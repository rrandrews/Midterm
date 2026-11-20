import { activePaneId, livePane } from "../../actions";
import { selectAllPanes, useAppStore } from "../../state/store";
import { blockOutput, canRun, runFromBlocks } from "../../terminal/blockMode";
import { peekSession } from "../../terminal/sessions";
import type { Skill } from "../types";

const OUTPUT_LIMIT = 4000;

/** The terminal the agent means: the one named, else the pane it works with, else the active pane, else the first terminal. */
function terminalPane(paneId: unknown, contextPane?: string): string {
  const candidates = [paneId, contextPane, activePaneId()].filter((id): id is string => typeof id === "string");
  for (const id of candidates) if (livePane(id)?.data.kind === "terminal") return id;
  if (typeof paneId === "string") throw new Error(`No terminal pane "${paneId}"`);
  const first = selectAllPanes(useAppStore.getState()).find((pane) => pane.data.kind === "terminal");
  if (!first) throw new Error("There is no terminal");
  return first.id;
}

/** The middle of long output is dropped; the head and tail say the most. */
function clip(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  const half = OUTPUT_LIMIT / 2;
  return `${text.slice(0, half)}\n… ${text.length - OUTPUT_LIMIT} characters left out …\n${text.slice(-half)}`;
}

const paneIdProperty = { type: "string", description: "A terminal pane id; the active terminal if omitted" };

export const terminalSkills: Skill[] = [
  {
    id: "commands",
    title: "Terminal commands",
    description: "Read the commands recently run in a terminal with their output and exit status, and run a command in it.",
    instructions:
      "Commands and their output are only tracked when the shell has integration (zsh, bash, fish started by Midterm). " +
      "Read recent blocks before suggesting a fix. Running a command types it at the prompt and presses Enter, so only run " +
      "commands the user asked for; the shell must be idle at a prompt.",
    tools: [
      {
        name: "recent_blocks",
        description: "The last commands run in a terminal: command line, directory, exit code, duration and output (clipped).",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: {
            paneId: paneIdProperty,
            count: { type: "integer", minimum: 1, maximum: 20, default: 5 },
          },
          additionalProperties: false,
        },
        run: async (input, ctx) => {
          const { paneId, count = 5 } = input as { paneId?: string; count?: number };
          const id = terminalPane(paneId, ctx.paneId);
          const session = peekSession(id);
          if (!session) throw new Error("The terminal has not started");
          const snap = session.blocks.snapshot();
          return {
            paneId: id,
            integration: snap.integration,
            cwd: (snap.nested ? snap.location.cwd : session.cwd) ?? null,
            // Set while the prompt is a shell on another machine (over ssh).
            host: snap.nested ? (snap.location.host ?? "unknown") : null,
            blocks: snap.blocks.slice(-count).map((block) => ({
              command: block.command,
              cwd: block.cwd ?? null,
              host: block.host ?? null,
              exitCode: block.exitCode ?? null,
              running: block.end === undefined,
              durationMs: block.endedAt === undefined ? null : Math.round(block.endedAt - block.startedAt),
              output: clip(blockOutput(session, block)),
            })),
          };
        },
      },
      {
        name: "run_command",
        description: "Runs a command line in a terminal that is idle at a prompt (blocks mode or classic, with shell integration).",
        effect: "write",
        inputSchema: {
          type: "object",
          properties: { paneId: paneIdProperty, command: { type: "string", minLength: 1 } },
          required: ["command"],
          additionalProperties: false,
        },
        run: async (input, ctx) => {
          const { paneId, command } = input as { paneId?: string; command: string };
          const id = terminalPane(paneId, ctx.paneId);
          const session = peekSession(id);
          if (!session || !canRun(session)) throw new Error("The terminal is not waiting at a prompt");
          runFromBlocks(session, command);
          return { paneId: id, sent: command };
        },
      },
    ],
  },
];
