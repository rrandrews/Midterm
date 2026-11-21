/*
 * The Claude Code pane's session model, as held in the store
 * (src/claude/store.ts) and read by the UI (src/claude/ui/). The reducer
 * (src/claude/reduce.ts) turns SDK messages into this shape.
 */

import type {
  ContextUsage,
  EffortLevel,
  ImageAttachment,
  McpServerStatus,
  PermissionMode,
  PermissionRequest,
  PlanUsage,
  SessionInit,
} from "./protocol";

export type SessionStatus =
  /** No process yet (nothing sent; or after an error, until the next message). */
  | "new"
  /** The process is starting. */
  | "starting"
  /** Ready for a message. */
  | "idle"
  /** A turn is running. */
  | "running"
  /** The process failed or ended unexpectedly; `error` says why. The next message starts a new one (resuming). */
  | "error";

/** One entry of a transcript, in order. Tool calls are entries that point into `tools`. */
export type TranscriptItem =
  | { kind: "user"; id: string; text: string; images?: ImageAttachment[]; /** Sent while a turn ran; not yet folded in. */ queued?: boolean }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "thinking"; id: string; text: string; streaming: boolean; /** Redacted thinking: no text to show. */ redacted?: boolean }
  | { kind: "tool"; id: string; toolUseId: string }
  /** Status lines: compaction, API retries, hook output, errors, interrupts… */
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; text: string }
  /** The output of a local slash command (/cost, /context, …). */
  | { kind: "command"; id: string; text: string }
  /** The end of a turn. */
  | { kind: "result"; id: string; durationMs: number; costUsd: number; turns: number; isError: boolean; stopReason?: string | null };

export type ToolStatus = "streaming" | "pending" | "running" | "done" | "error" | "denied" | "cancelled";

export type ToolCall = {
  /** The tool_use id. */
  id: string;
  name: string;
  /** The parsed input (partial while `streaming`). */
  input: Record<string, unknown>;
  status: ToolStatus;
  /** The tool_result's content as text (images dropped; long results clipped by the reducer to 64 KB). */
  result?: string;
  /** The SDK's structured `tool_use_result`, when the CLI sent one (e.g. Edit's structured patch). */
  structured?: unknown;
  isError?: boolean;
  /** The Agent/Task call this ran under; `null` for the main thread. */
  parentToolUseId: string | null;
  startedAt: number;
  endedAt?: number;
  /** Seconds, from tool_progress. */
  elapsed?: number;
};

/** A background task or subagent (system task_* messages). */
export type Task = {
  id: string;
  /** The Agent/Task tool_use that started it, if any: its transcript is `subTranscripts[toolUseId]`. */
  toolUseId?: string;
  parentTaskId?: string;
  description: string;
  subagentType?: string;
  taskType?: string;
  prompt?: string;
  status: "pending" | "running" | "completed" | "failed" | "stopped" | "killed" | "paused";
  backgrounded?: boolean;
  startedAt: number;
  endedAt?: number;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastToolName?: string;
  summary?: string;
  error?: string;
};

/** A to-do: from TodoWrite's list, or a task of the CLI's task tools (TaskCreate / TaskUpdate / TaskList), which have an `id`. */
export type Todo = { id?: string; content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

/** Totals over the session's turns (from result messages). */
export type SessionTotals = {
  costUsd: number;
  durationMs: number;
  apiDurationMs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Per model, from the last result's modelUsage (cumulative in the CLI). */
  byModel: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number; contextWindow: number }>;
};

/** A streamed API message being built: its id and, per content block index, the item it feeds. */
export type StreamState = {
  messageId: string;
  blocks: Record<number, { itemId: string; kind: "text" | "thinking" | "tool"; toolUseId?: string; /** Tool input JSON received so far. */ json?: string }>;
};

export type SidePanel ="context" | "usage" | "agents" | "plugins" | "config" | "history";

export type ClaudeSession = {
  key: string;
  paneId: string;
  cwd: string;
  status: SessionStatus;
  error?: string;
  /** The SDK session id, once known (saved in the pane data; resumed on restart). */
  sessionId?: string;
  init?: SessionInit;
  /** Model value as chosen (alias such as "opus" or "default"), and the model the CLI reports. */
  model?: string;
  resolvedModel?: string;
  effort?: EffortLevel | null;
  permissionMode: PermissionMode;
  title?: string;

  /** The main thread's transcript. */
  items: TranscriptItem[];
  /** Each subagent's transcript, keyed by the Agent/Task tool_use id that started it. */
  subTranscripts: Record<string, TranscriptItem[]>;
  tools: Record<string, ToolCall>;
  tasks: Record<string, Task>;
  /** Pending prompts, oldest first. */
  permissions: PermissionRequest[];
  todos: Todo[];

  /** Last fetched context breakdown, and the estimate from the last main-thread assistant message's usage. */
  context?: ContextUsage;
  contextTokens?: number;
  contextWindow?: number;
  usage?: PlanUsage;
  /** The latest rate_limit_event's info. */
  rateLimit?: unknown;
  totals: SessionTotals;
  mcpServers: McpServerStatus[] | { name: string; status: string; source?: string }[];

  /** A saved transcript is being loaded (`sessions.messages`); sends wait for it. */
  loadingTranscript?: boolean;
  /** Created to resume a saved session: the first result's cost includes earlier spend. */
  resumed?: boolean;
  /** Whether this session's process was started allowing `bypassPermissions` (unset before it starts). */
  bypassAllowed?: boolean;
  /** When the running turn started (for "working for 12s"); unset when idle. */
  turnStartedAt?: number;
  /** Compaction is in progress (system/status "compacting"). */
  compacting?: boolean;
  /** Reducer bookkeeping for streamed API messages, by thread ("" = main thread, else the parent tool_use id). */
  streams?: Record<string, StreamState>;

  /** UI state that belongs to the session (not saved). */
  panel?: SidePanel;
  /** The task shown in the Agents panel. */
  focusedTask?: string;
};
