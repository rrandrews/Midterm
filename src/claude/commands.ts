import { isTauri } from "@tauri-apps/api/core";
import { copyText } from "../ipc/clipboard";
import { writeTextFile } from "../ipc/fs";
import { openExternal } from "../ipc/shell";
import type { EffortLevel, ModelInfo, SlashCommand } from "./protocol";
import { addNotice, askAside, forkConversation, getSession, setEffort, setModel, setPermissionMode, updateSession } from "./store";
import type { ClaudeSession, SidePanel, ToolCall } from "./types";
import { startNewSession } from "./ui/actions";
import { EFFORT_LABELS, FALLBACK_MODELS, MODE_LABELS, modelLabel } from "./ui/format";
import { showPluginsView } from "./ui/panels/PluginsPanel";

/*
 * Slash commands. The CLI reports its own (built-ins such as /doctor and
 * /compact, every skill, plugin commands); they are sent as messages. The
 * pane adds the ones it answers itself, as the VS Code extension does: a side
 * question (/btw), the chips (/model, /effort, /plan), the side panels, and
 * a few actions (/status, /copy, /export, /fork, /bug). Where both have a
 * command (/model, /context, /clear…), the pane's wins: it keeps the chips
 * and panels in step with what is shown.
 */

/** A choice for a command's argument, listed in the menu after `/name `. */
export type CommandOption = { value: string; label: string; current?: boolean };

/** What the composer lends a command: its own send (with the attached images) and a way to put the text back. */
export type CommandContext = {
  /** Sends a message as the composer would (with its attachments); the text comes back to the box if it is not sent. */
  send: (text: string) => void;
  /** Puts the command back in the box (it could not run). */
  restore: () => void;
};

export type PaneCommand = SlashCommand & {
  /** Marks the pane's commands in the menu. */
  pane: true;
  run: (key: string, args: string, context: CommandContext) => unknown;
  /** Choices for the argument: Enter on the bare command lists them. */
  options?: (session: ClaudeSession) => CommandOption[];
};

/** What the CLI offers before a session has reported its own list. */
const CLI_FALLBACK: SlashCommand[] = [
  { name: "compact", description: "Clear history but keep a summary in context", argumentHint: "[instructions]" },
  { name: "init", description: "Initialize a CLAUDE.md file with codebase documentation", argumentHint: "" },
  { name: "review", description: "Review a pull request", argumentHint: "" },
  { name: "security-review", description: "Complete a security review of the pending changes", argumentHint: "" },
];

/** The last list the CLI reported for each folder: a new pane shows it before its own process is up. */
const known = new Map<string, SlashCommand[]>();

export function rememberCommands(cwd: string, commands: SlashCommand[]): void {
  if (commands.length) known.set(cwd, commands);
}

function openPanel(key: string, panel: SidePanel): void {
  updateSession(key, { panel });
}

function modelsOf(session: ClaudeSession): ModelInfo[] {
  return session.init?.models.length ? session.init.models : FALLBACK_MODELS;
}

/** A model by its value, name or a unique prefix of either ("opus", "sonnet[1m]"). */
export function findModel(models: ModelInfo[], query: string): ModelInfo | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const exact = models.find((model) => model.value.toLowerCase() === q || model.displayName.toLowerCase() === q);
  if (exact) return exact;
  const partial = models.filter((model) => model.value.toLowerCase().startsWith(q) || model.displayName.toLowerCase().startsWith(q));
  return partial.length === 1 ? partial[0] : undefined;
}

const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** The current model's effort levels (the standard ones before the session reports models); none when it takes no effort. */
function effortsOf(session: ClaudeSession): EffortLevel[] {
  const current = modelsOf(session).find((model) => model.value === (session.model ?? "default"));
  if (current?.supportsEffort === false) return [];
  return current?.supportedEffortLevels?.length ? current.supportedEffortLevels : EFFORTS;
}

/** The transcript as Markdown: messages, answers, and one line per tool call. */
export function transcriptMarkdown(session: ClaudeSession): string {
  const out: string[] = [`# ${session.title ?? "Claude Code session"}`, "", `Folder: \`${session.cwd}\``];
  if (session.sessionId) out.push(`Session: \`${session.sessionId}\``);
  for (const item of session.items) {
    if (item.kind === "user") out.push("", "## You", "", item.text || "(images)");
    else if (item.kind === "assistant" && item.text) out.push("", "## Claude", "", item.text);
    else if (item.kind === "tool") {
      const tool: ToolCall | undefined = session.tools[item.toolUseId];
      if (tool) out.push("", `- ${tool.name}${toolSubject(tool) ? `: \`${toolSubject(tool)}\`` : ""}${tool.status === "error" ? " (failed)" : ""}`);
    } else if (item.kind === "aside") out.push("", `> /btw ${item.question}`, ...(item.answer ? [">", ...item.answer.split("\n").map((line) => `> ${line}`)] : []));
    else if (item.kind === "command") out.push("", "```", item.text, "```");
  }
  return `${out.join("\n")}\n`;
}

function toolSubject(tool: ToolCall): string | undefined {
  const input = tool.input;
  const value = input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.description;
  if (typeof value !== "string") return undefined;
  const line = value.split("\n")[0];
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "claude-session"
  );
}

async function exportTranscript(key: string, args: string): Promise<void> {
  const session = getSession(key);
  if (!session) return;
  if (!session.items.some((item) => item.kind === "user")) {
    addNotice(key, "Nothing to export yet.", "info");
    return;
  }
  const markdown = transcriptMarkdown(session);
  if (!isTauri()) {
    if (await copyText(markdown)) addNotice(key, "Copied the conversation as Markdown.", "info");
    else addNotice(key, "Could not copy the conversation: the clipboard refused it.", "warn");
    return;
  }
  // Always through the save dialog, which asks before replacing a file; a typed name only suggests one.
  const name = args.trim() || `${slug(session.title ?? "")}.md`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ title: "Export the conversation", defaultPath: name.startsWith("/") ? name : `${session.cwd}/${name}`, filters: [{ name: "Markdown", extensions: ["md"] }] });
  if (!path) return;
  try {
    await writeTextFile(path, markdown, { kind: "any" });
    addNotice(key, `Exported the conversation to ${path}.`, "info");
  } catch (error) {
    addNotice(key, `Could not export: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** /status: what this session runs with. */
export function statusText(session: ClaudeSession): string {
  const init = session.init;
  const account = init?.account;
  const servers = session.mcpServers as { status: string }[];
  const rows: [string, string | undefined][] = [
    ["Claude Code", init?.claudeCodeVersion],
    ["Folder", session.cwd],
    ["Session", session.sessionId],
    ["Model", modelLabel(session.model, modelsOf(session), session.resolvedModel)],
    ["Effort", session.effort ? (EFFORT_LABELS[session.effort] ?? session.effort) : "model default"],
    ["Mode", MODE_LABELS[session.permissionMode]],
    ["Account", account ? [account.email, account.organization, account.subscriptionType].filter(Boolean).join(", ") || account.apiKeySource || account.tokenSource : undefined],
    ["MCP servers", servers.length ? `${servers.filter((server) => server.status === "connected").length} connected of ${servers.length}` : undefined],
    ["Output style", init?.outputStyle],
  ];
  const shown = rows.filter((row): row is [string, string] => Boolean(row[1]));
  const width = Math.max(...shown.map(([label]) => label.length));
  return shown.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

function addOutput(key: string, text: string): void {
  updateSession(key, (session) => ({ items: [...session.items, { kind: "command", id: `local:${crypto.randomUUID()}`, text }] }));
}

const panel = (name: string, description: string, target: SidePanel, aliases?: string[]): PaneCommand => ({
  name,
  description,
  argumentHint: "",
  aliases,
  pane: true,
  run: (key) => openPanel(key, target),
});

export const PANE_COMMANDS: PaneCommand[] = [
  {
    name: "btw",
    description: "Ask a side question; the answer stays out of the conversation",
    argumentHint: "<question>",
    pane: true,
    run: (key, args) => (args.trim() ? askAside(key, args) : addNotice(key, "Type a question after /btw.", "info")),
  },
  {
    name: "plan",
    description: "Switch to plan mode; with a prompt, send it too",
    argumentHint: "[prompt]",
    pane: true,
    run: async (key, args, context) => {
      if (!(await setPermissionMode(key, "plan"))) return context.restore();
      if (args.trim()) context.send(args.trim());
    },
  },
  {
    name: "model",
    description: "Change the model",
    argumentHint: "[model]",
    pane: true,
    options: (session) => modelsOf(session).map((model) => ({ value: model.value, label: model.displayName, current: model.value === (session.model ?? "default") })),
    run: (key, args) => {
      const session = getSession(key);
      if (!session) return;
      const model = findModel(modelsOf(session), args);
      if (!model) return addNotice(key, `No model matches “${args.trim()}”.`, "warn");
      return setModel(key, model.value === "default" ? undefined : model.value);
    },
  },
  {
    name: "effort",
    description: "Change the reasoning effort",
    argumentHint: "[level]",
    pane: true,
    options: (session) => [
      ...effortsOf(session).map((level) => ({ value: level, label: EFFORT_LABELS[level] ?? level, current: session.effort === level })),
      { value: "auto", label: "Model default", current: !session.effort },
    ],
    run: (key, args) => {
      const session = getSession(key);
      if (!session) return;
      const value = args.trim().toLowerCase();
      if (value === "auto" || value === "default") return setEffort(key, null);
      if (!effortsOf(session).length) return addNotice(key, "This model has no reasoning effort setting.", "info");
      const level = effortsOf(session).find((candidate) => candidate === value || EFFORT_LABELS[candidate]?.toLowerCase() === value);
      if (!level) return addNotice(key, `No effort level “${args.trim()}”. Try ${effortsOf(session).join(", ")} or auto.`, "warn");
      return setEffort(key, level);
    },
  },
  panel("context", "Show what fills the context window", "context"),
  panel("usage", "Show session cost and plan limits", "usage", ["cost"]),
  panel("agents", "Show subagents and background tasks", "agents"),
  {
    name: "mcp",
    description: "Manage MCP servers",
    argumentHint: "",
    pane: true,
    run: (key) => {
      showPluginsView(key, "mcp");
      openPanel(key, "plugins");
    },
  },
  {
    name: "plugin",
    description: "Manage plugins and marketplaces",
    argumentHint: "",
    aliases: ["plugins", "marketplace"],
    pane: true,
    run: (key) => {
      showPluginsView(key, "installed");
      openPanel(key, "plugins");
    },
  },
  panel("config", "Edit settings, permissions and CLAUDE.md files", "config", ["settings", "permissions", "allowed-tools", "memory"]),
  panel("resume", "Resume a past session in this folder", "history", ["history"]),
  {
    name: "clear",
    description: "Start a new session (this one stays in History)",
    argumentHint: "",
    aliases: ["new", "reset"],
    pane: true,
    run: (key) => startNewSession(key),
  },
  {
    name: "fork",
    description: "Continue in a copy of this conversation",
    argumentHint: "",
    aliases: ["branch"],
    pane: true,
    run: (key) => forkConversation(key),
  },
  {
    name: "status",
    description: "Show the version, model, account and folder",
    argumentHint: "",
    pane: true,
    run: (key) => {
      const session = getSession(key);
      if (session) addOutput(key, statusText(session));
    },
  },
  {
    name: "copy",
    description: "Copy Claude's last answer",
    argumentHint: "",
    pane: true,
    run: async (key) => {
      const last = [...(getSession(key)?.items ?? [])].reverse().find((item) => item.kind === "assistant" && item.text);
      if (!last || last.kind !== "assistant") return addNotice(key, "No answer to copy yet.", "info");
      if (await copyText(last.text)) addNotice(key, "Copied the last answer.", "info");
      else addNotice(key, "Could not copy: the clipboard refused it.", "warn");
    },
  },
  {
    name: "export",
    description: "Save the conversation as Markdown",
    argumentHint: "[file]",
    pane: true,
    run: (key, args) => exportTranscript(key, args),
  },
  {
    name: "bug",
    description: "Report a Claude Code bug on GitHub",
    argumentHint: "",
    aliases: ["feedback"],
    pane: true,
    run: () => openExternal("https://github.com/anthropics/claude-code/issues"),
  },
  {
    name: "login",
    description: "Sign in to Claude Code",
    argumentHint: "",
    aliases: ["logout"],
    pane: true,
    run: (key) => addNotice(key, "Sign-in is shared with the claude CLI: run `claude /login` (or `/logout`) in a terminal pane, then start a new session here.", "info"),
  },
];

const paneNames = new Set(PANE_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]));

/** The pane's commands, then the CLI's (its own list, the folder's last known one, or a few built-ins), without names the pane answers. */
export function commandList(session: Pick<ClaudeSession, "init" | "cwd"> | undefined): (SlashCommand | PaneCommand)[] {
  const reported = session?.init?.commands.length ? session.init.commands : session ? known.get(session.cwd) : undefined;
  // `__name`: the CLI's internal commands.
  const cli = (reported ?? CLI_FALLBACK).filter((command) => !paneNames.has(command.name) && !command.name.startsWith("__"));
  return [...PANE_COMMANDS, ...cli];
}

/** Whether the list shown is the CLI's own (not the stand-in before a session reported one). */
export function hasFullList(session: Pick<ClaudeSession, "init" | "cwd"> | undefined): boolean {
  return Boolean(session && (session.init?.commands.length || known.has(session.cwd)));
}

export function isPaneCommand(command: SlashCommand | PaneCommand): command is PaneCommand {
  return (command as PaneCommand).pane === true;
}

/** `/name args` → the pane command it names (by name or alias), if the pane answers it. */
export function findPaneCommand(text: string): { command: PaneCommand; args: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  const command = PANE_COMMANDS.find((candidate) => candidate.name === name || candidate.aliases?.includes(name));
  return command ? { command, args: match[2] ?? "" } : undefined;
}
