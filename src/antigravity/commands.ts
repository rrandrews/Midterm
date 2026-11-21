import type { AvailableCommand } from "@agentclientprotocol/sdk/unstable";
import { isTauri } from "@tauri-apps/api/core";
import { confirm } from "../components/ui/ConfirmDialog";
import { copyText } from "../ipc/clipboard";
import { writeTextFile } from "../ipc/fs";
import {
  appendCommandOutput,
  currentOptionValue,
  ensureStarted,
  getSession,
  resetSession,
  runLoginInTerminal,
  sessionWork,
  setConfigValue,
  setModeValue,
  setPanel,
  switchToSession,
  updateSession,
} from "./store";
import type { AntigravitySession } from "./types";
import { findConfigOption, flattenSelectOptions, formatCost, formatTokens } from "./ui/format";

/*
 * Slash commands for the Antigravity ACP pane: local pane commands merged
 * with the live ACP `available_commands_update` list (cached per cwd).
 */

export type CommandOption = { value: string; label: string; current?: boolean };

export type CommandContext = {
  send: (message: string) => void;
  restore: () => void;
};

export type PaneCommand = {
  name: string;
  aliases?: string[];
  description: string;
  argumentHint?: string;
  options?: (session: AntigravitySession) => CommandOption[];
  run: (sessionKey: string, args: string, ctx: CommandContext) => void | Promise<void>;
};

export type ListedCommand = {
  name: string;
  aliases?: string[];
  description: string;
  argumentHint?: string;
  source: "pane" | "agent";
};

const cachedAgentCommands = new Map<string, AvailableCommand[]>();

export function rememberCommands(cwd: string, commands: AvailableCommand[]): void {
  if (cwd && commands.length) cachedAgentCommands.set(cwd, commands);
}

/** Confirms if a turn is running before starting a fresh session. */
export async function startNewSession(key: string): Promise<void> {
  const work = sessionWork(key);
  if (work) {
    const ok = await confirm({
      title: "Start a new Antigravity session?",
      message: "The current turn is still running and will be stopped.",
      action: "New session",
    });
    if (!ok) return;
  }
  resetSession(key);
}

/** Confirms if a turn or queued prompt is active before switching to another session from History. */
export async function confirmSwitchSession(key: string, target: { sessionId: string; cwd?: string }): Promise<void> {
  const work = sessionWork(key);
  if (work) {
    const ok = await confirm({
      title: "Switch Antigravity session?",
      message: "The current turn or queued prompts will be stopped and discarded.",
      action: "Switch session",
    });
    if (!ok) return;
  }
  await switchToSession(key, target);
}

function transcriptAsMarkdown(session: AntigravitySession): string {
  const out: string[] = [`# ${session.title ?? "Antigravity session"}`, "", `Folder: \`${session.cwd}\``, ""];
  for (const item of session.items) {
    switch (item.kind) {
      case "user":
        out.push("## User", "", item.text, "");
        break;
      case "assistant":
        out.push("## Antigravity", "", item.text, "");
        break;
      case "tool": {
        const tool = session.tools[item.toolCallId];
        if (tool) out.push(`- **Tool**: ${tool.title} (${tool.status})`);
        break;
      }
      case "notice":
        out.push(`> **${item.title}**${item.description ? `: ${item.description}` : ""}`, "");
        break;
    }
  }
  return out.join("\n");
}

function selectOptionsOf(session: AntigravitySession, category: string): CommandOption[] {
  const opt = findConfigOption(session.configOptions, category);
  if (opt?.type === "select") {
    return flattenSelectOptions(opt).map((o) => ({
      value: o.value,
      label: o.name,
      current: o.value === opt.currentValue,
    }));
  }
  if (category === "mode" && session.modes) {
    return session.modes.availableModes.map((m) => ({
      value: m.id,
      label: m.name,
      current: m.id === session.modes!.currentModeId,
    }));
  }
  return [];
}

function matchChoice(options: CommandOption[], raw: string): CommandOption | undefined {
  const q = raw.trim().toLowerCase();
  return (
    options.find((o) => o.value.toLowerCase() === q) ??
    options.find((o) => o.label.toLowerCase() === q) ??
    options.find((o) => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
  );
}

export const PANE_COMMANDS: PaneCommand[] = [
  {
    name: "new",
    aliases: ["clear", "reset"],
    description: "Start a fresh session in this folder",
    run: (key) => startNewSession(key),
  },
  {
    name: "plan",
    description: "Switch to plan mode (optionally send a prompt)",
    argumentHint: "[prompt]",
    run: async (key, args, ctx) => {
      const started = await ensureStarted(key);
      const session = getSession(key);
      const planOpt = session ? selectOptionsOf(session, "mode").find((o) => o.value.toLowerCase().includes("plan")) : undefined;
      if (!started || !planOpt) {
        updateSession(key, (s) => ({
          items: [
            ...s.items,
            {
              kind: "notice",
              id: `plan-missing:${Date.now()}`,
              tone: "warn",
              title: "Plan mode unavailable",
              description: "Antigravity did not confirm a plan mode, so the prompt was not sent.",
            },
          ],
        }));
        ctx.restore();
        return;
      }
      const switched = await setModeValue(key, planOpt.value);
      if (!switched) {
        ctx.restore();
        return;
      }
      if (args.trim()) ctx.send(args.trim());
    },
  },
  {
    name: "mode",
    description: "Switch session permission mode",
    argumentHint: "<mode>",
    options: (session) => selectOptionsOf(session, "mode"),
    run: async (key, args) => {
      const session = getSession(key);
      if (!session || !args.trim()) return;
      const choice = matchChoice(selectOptionsOf(session, "mode"), args);
      if (choice) await setModeValue(key, choice.value);
      else appendCommandOutput(key, `Unknown mode: ${args.trim()}`);
    },
  },
  {
    name: "model",
    description: "Switch the active model",
    argumentHint: "<model>",
    options: (session) => selectOptionsOf(session, "model"),
    run: async (key, args) => {
      const session = getSession(key);
      if (!session || !args.trim()) return;
      const opt = findConfigOption(session.configOptions, "model");
      const choice = matchChoice(selectOptionsOf(session, "model"), args);
      if (opt && choice) await setConfigValue(key, opt.id, choice.value);
      else appendCommandOutput(key, `Unknown model: ${args.trim()}`);
    },
  },
  {
    name: "effort",
    aliases: ["thinking"],
    description: "Set reasoning / thought effort level",
    argumentHint: "<level>",
    options: (session) => selectOptionsOf(session, "thought_level"),
    run: async (key, args) => {
      const session = getSession(key);
      if (!session || !args.trim()) return;
      const opt = findConfigOption(session.configOptions, "thought_level");
      const choice = matchChoice(selectOptionsOf(session, "thought_level"), args);
      if (opt && choice) await setConfigValue(key, opt.id, choice.value);
      else appendCommandOutput(key, `Unknown effort level: ${args.trim()}`);
    },
  },
  {
    name: "history",
    aliases: ["resume"],
    description: "Open session history to resume a past conversation",
    run: (key) => setPanel(key, "history"),
  },
  {
    name: "files",
    description: "Show files modified in this session",
    run: (key) => setPanel(key, "files"),
  },
  {
    name: "session",
    aliases: ["usage", "context", "config"],
    description: "Open session usage, context meter and options",
    run: (key) => setPanel(key, "session"),
  },
  {
    name: "status",
    description: "Print current Antigravity ACP session status",
    run: (key) => {
      const s = getSession(key);
      if (!s) return;
      const lines = [
        `Agent:   ${s.agentInfo?.title ?? s.agentInfo?.name ?? "Antigravity"} ${s.agentInfo?.version ?? ""}`.trim(),
        `CLI:     ${s.agyPath ?? "agy"}${s.agyVersion ? ` (${s.agyVersion})` : ""}`,
        `Folder:  ${s.cwd}`,
        `Session: ${s.sessionId ?? "(not started)"}`,
        `Mode:    ${currentOptionValue(s, "mode") ?? "default"}`,
        `Model:   ${currentOptionValue(s, "model") ?? "default"}`,
        `Effort:  ${currentOptionValue(s, "thought_level") ?? "default"}`,
      ];
      if (s.usage) {
        const pct = s.usage.size > 0 ? Math.round((s.usage.used / s.usage.size) * 100) : 0;
        lines.push(`Context: ${formatTokens(s.usage.used)} / ${formatTokens(s.usage.size)} (${pct}%)`);
        if (s.usage.cost) lines.push(`Cost:    ${formatCost(s.usage.cost.amount, s.usage.cost.currency)}`);
      }
      appendCommandOutput(key, lines.join("\n"));
    },
  },
  {
    name: "copy",
    description: "Copy the last Antigravity answer to the clipboard",
    run: async (key) => {
      const s = getSession(key);
      if (!s) return;
      const last = [...s.items].reverse().find((it) => it.kind === "assistant" && it.text.trim());
      if (!last || last.kind !== "assistant") {
        appendCommandOutput(key, "No answer to copy yet.");
        return;
      }
      await copyText(last.text);
      appendCommandOutput(key, "Copied last answer to clipboard.");
    },
  },
  {
    name: "export",
    description: "Export the transcript as Markdown",
    run: async (key) => {
      const s = getSession(key);
      if (!s) return;
      const md = transcriptAsMarkdown(s);
      if (!isTauri()) {
        await copyText(md);
        appendCommandOutput(key, "Copied Markdown transcript to clipboard.");
        return;
      }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = await save({
        defaultPath: `${s.cwd}/antigravity-transcript.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!target) return;
      await writeTextFile(target, md, { kind: "any" });
      appendCommandOutput(key, `Exported transcript to ${target}`);
    },
  },
  {
    name: "login",
    description: "Run `agy acp --login` in a new terminal pane",
    run: (key) => runLoginInTerminal(key),
  },
];

/** Finds a local pane command matching `/name [args]`. */
export function findPaneCommand(input: string): { command: PaneCommand; args: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  const args = match[2] ?? "";
  const command = PANE_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
  return command ? { command, args } : undefined;
}

/** Merged command list: pane commands first, then agent commands not shadowed by pane commands. */
export function commandList(session: Pick<AntigravitySession, "availableCommands" | "cwd"> | undefined): ListedCommand[] {
  const paneNames = new Set<string>();
  const out: ListedCommand[] = [];
  for (const cmd of PANE_COMMANDS) {
    paneNames.add(cmd.name);
    for (const a of cmd.aliases ?? []) paneNames.add(a);
    out.push({
      name: cmd.name,
      aliases: cmd.aliases,
      description: cmd.description,
      argumentHint: cmd.argumentHint,
      source: "pane",
    });
  }
  const agentCmds = session?.availableCommands.length
    ? session.availableCommands
    : session?.cwd
      ? (cachedAgentCommands.get(session.cwd) ?? [])
      : [];
  for (const cmd of agentCmds) {
    if (cmd.name.startsWith("__") || paneNames.has(cmd.name)) continue;
    out.push({
      name: cmd.name,
      description: cmd.description,
      argumentHint: cmd.input?.hint,
      source: "agent",
    });
  }
  return out;
}
