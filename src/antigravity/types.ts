import type {
  AgentCapabilities,
  AvailableCommand,
  CreateElicitationRequest,
  Implementation,
  PermissionOption,
  PlanEntry,
  RequestId,
  SessionConfigOption,
  SessionModeState,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  ToolKind,
  Usage,
  UsageUpdate,
} from "@agentclientprotocol/sdk/unstable";

/*
 * The Antigravity ACP pane's session state model, held in the Zustand store
 * (src/antigravity/store.ts) and rendered by src/antigravity/ui/.
 */

export const ANTIGRAVITY_KIND = "antigravity";

export type SessionStatus = "new" | "starting" | "idle" | "running" | "error";

export type ImageAttachment = {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
};

export type FileMention = {
  /** Absolute file path. */
  path: string;
  /** Display label (relative to cwd). */
  label: string;
};

export type TranscriptItem =
  | {
      kind: "user";
      id: string;
      text: string;
      images?: ImageAttachment[];
      mentions?: FileMention[];
      queued?: boolean;
      queueId?: string;
    }
  | { kind: "assistant"; id: string; messageId?: string; text: string; streaming: boolean }
  | { kind: "thinking"; id: string; messageId?: string; text: string; streaming: boolean }
  | { kind: "tool"; id: string; toolCallId: string }
  | {
      kind: "compaction";
      id: string;
      compactionId: string;
      status: string;
      summary: string;
      error?: string;
    }
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; title: string; description?: string }
  | { kind: "command"; id: string; text: string }
  | { kind: "result"; id: string; durationMs: number; stopReason: StopReason | string; usage?: Usage; isError?: boolean };

export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed" | "denied" | "cancelled";

export type AcpToolCall = {
  id: string;
  title: string;
  name?: string;
  kind: ToolKind;
  status: AcpToolStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  startedAt: number;
  endedAt?: number;
};

export type ChangedFile = {
  path: string;
  added: number;
  removed: number;
  edits: number;
  lastToolCallId: string;
  /** Per-tool-call line totals so partial updates to one tool never erase another tool's stats. */
  byTool: Record<string, { added: number; removed: number }>;
  latestDiff?: { oldText?: string | null; newText: string };
};

export type PendingPermission = {
  rpcId: RequestId;
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
};

export type PendingElicitation = {
  rpcId: RequestId;
  request: CreateElicitationRequest;
};

export type SessionTotals = {
  turns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedReadTokens: number;
};

export type SidePanel = "history" | "files" | "session" | "plan";

export type AntigravityPaneData = {
  cwd: string;
  sessionId?: string;
  mode?: string;
  model?: string;
  thoughtLevel?: string;
};

export type AntigravitySession = {
  key: string;
  paneId: string;
  cwd: string;
  status: SessionStatus;
  error?: string;
  authRequired?: boolean;
  sessionId?: string;
  title?: string;

  /** Reported by `initialize`. */
  agentInfo?: Implementation;
  capabilities?: AgentCapabilities;
  agyPath?: string;
  agyVersion?: string | null;

  /** Dynamic ACP configuration options and legacy session modes. */
  configOptions: SessionConfigOption[];
  modes?: SessionModeState;
  /** User's saved/preferred selections before the first session/new answers. */
  savedMode?: string;
  savedModel?: string;
  savedThoughtLevel?: string;

  availableCommands: AvailableCommand[];

  /** Timeline transcript. */
  items: TranscriptItem[];
  tools: Record<string, AcpToolCall>;
  changedFiles: Record<string, ChangedFile>;
  plan: PlanEntry[];
  permissions: PendingPermission[];
  elicitations: PendingElicitation[];

  usage?: UsageUpdate;
  totals: SessionTotals;

  loadingTranscript?: boolean;
  turnStartedAt?: number;

  /** UI state (not persisted). */
  panel?: SidePanel;
};
