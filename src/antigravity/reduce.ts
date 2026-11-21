import type {
  ContentBlock,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  Usage,
} from "@agentclientprotocol/sdk/unstable";
import type {
  AcpToolCall,
  AcpToolStatus,
  AntigravitySession,
  ChangedFile,
  FileMention,
  ImageAttachment,
  SessionTotals,
  TranscriptItem,
} from "./types";
import { diffStats, diffTexts, relativeTo } from "./ui/format";

/*
 * Pure reducer turning ACP v1 `SessionUpdate` notifications and turn lifecycle
 * events into `AntigravitySession` state. Unit-tested in reduce.test.ts.
 */

const EMPTY_TOTALS: SessionTotals = {
  turns: 0,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  cachedReadTokens: 0,
};

let nextItemSeq = 1;
const itemId = (prefix: string) => `${prefix}:${nextItemSeq++}`;

export function createSession(seed: {
  key: string;
  paneId: string;
  cwd: string;
  sessionId?: string;
  mode?: string;
  model?: string;
  thoughtLevel?: string;
}): AntigravitySession {
  return {
    key: seed.key,
    paneId: seed.paneId,
    cwd: seed.cwd,
    status: "new",
    sessionId: seed.sessionId,
    savedMode: seed.mode,
    savedModel: seed.model,
    savedThoughtLevel: seed.thoughtLevel,
    configOptions: [],
    availableCommands: [],
    items: [],
    tools: {},
    changedFiles: {},
    plan: [],
    permissions: [],
    elicitations: [],
    totals: { ...EMPTY_TOTALS },
  };
}

function mapToolStatus(status: ToolCallStatus | null | undefined, fallback: AcpToolStatus): AcpToolStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return fallback;
  }
}

function isToolDone(status: AcpToolStatus): boolean {
  return status === "completed" || status === "failed" || status === "denied" || status === "cancelled";
}

function contentBlockText(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "resource" && "text" in block.resource) return block.resource.text;
  if (block.type === "resource_link") return `[${block.name}]`;
  return "";
}

function contentBlockImage(block: ContentBlock): ImageAttachment | undefined {
  if (block.type !== "image") return undefined;
  if (block.mimeType === "image/png" || block.mimeType === "image/jpeg" || block.mimeType === "image/gif" || block.mimeType === "image/webp") {
    return { mediaType: block.mimeType, data: block.data };
  }
  return undefined;
}

function fileUrlToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    const url = new URL(uri);
    const decoded = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return uri.slice("file://".length);
  }
}

function contentBlockMention(block: ContentBlock, cwd: string): FileMention | undefined {
  if (block.type !== "resource_link") return undefined;
  const path = fileUrlToPath(block.uri);
  return { path, label: block.name || relativeTo(path, cwd) };
}

/** Merges any native ACP `diff` blocks in `content` into `changedFiles`, tracking stats per tool call. */
function recordDiffs(
  changedFiles: Record<string, ChangedFile>,
  toolId: string,
  content: readonly ToolCallContent[],
): { changedFiles: Record<string, ChangedFile>; editedPaths: string[] } {
  const diffs = content.filter((c): c is Extract<ToolCallContent, { type: "diff" }> => c.type === "diff");
  if (diffs.length === 0) return { changedFiles, editedPaths: [] };
  // Aggregate multiple diffs to the same path within this single tool call first.
  const perPath = new Map<string, { added: number; removed: number; latestDiff: { oldText?: string | null; newText: string } }>();
  for (const diff of diffs) {
    const lines = diffTexts(diff.oldText ?? "", diff.newText);
    const { added, removed } = diffStats(lines);
    const cur = perPath.get(diff.path);
    perPath.set(diff.path, {
      added: (cur?.added ?? 0) + added,
      removed: (cur?.removed ?? 0) + removed,
      latestDiff: { oldText: diff.oldText, newText: diff.newText },
    });
  }
  const next = { ...changedFiles };
  const editedPaths: string[] = [];
  for (const [path, stats] of perPath) {
    const prev = next[path];
    const byTool = { ...(prev?.byTool ?? {}), [toolId]: { added: stats.added, removed: stats.removed } };
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const entry of Object.values(byTool)) {
      totalAdded += entry.added;
      totalRemoved += entry.removed;
    }
    next[path] = {
      path,
      added: totalAdded,
      removed: totalRemoved,
      edits: Object.keys(byTool).length,
      lastToolCallId: toolId,
      byTool,
      latestDiff: stats.latestDiff,
    };
    editedPaths.push(path);
  }
  return { changedFiles: next, editedPaths };
}

/** Closes any currently streaming assistant/thinking items. */
function closeStreams(items: TranscriptItem[]): TranscriptItem[] {
  let changed = false;
  const out = items.map((item) => {
    if ((item.kind === "assistant" || item.kind === "thinking") && item.streaming) {
      changed = true;
      return { ...item, streaming: false };
    }
    return item;
  });
  return changed ? out : items;
}

/** Appends a chunk of streamed text (`assistant` or `thinking`) cleanly to the timeline. */
function appendStreamChunk(
  items: TranscriptItem[],
  kind: "assistant" | "thinking",
  text: string,
  messageId: string | null | undefined,
): TranscriptItem[] {
  if (!text) return items;
  const last = items[items.length - 1];
  const sameId = !messageId || !last || !("messageId" in last) || !last.messageId || last.messageId === messageId;
  if (last && last.kind === kind && last.streaming && sameId) {
    const updated = items.slice();
    updated[updated.length - 1] = { ...last, text: last.text + text, messageId: last.messageId ?? messageId ?? undefined };
    return updated;
  }
  const closed = closeStreams(items);
  return [...closed, { kind, id: itemId(kind), messageId: messageId ?? undefined, text, streaming: true }];
}

/** Applies one ACP `SessionUpdate` to `session`. Pure; returns updated session and any newly edited paths. */
export function reduceUpdate(
  session: AntigravitySession,
  update: SessionUpdate,
  now: number,
): { session: AntigravitySession; editedPaths: string[] } {
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const text = update.content.type === "text" ? update.content.text : "";
      const image = contentBlockImage(update.content);
      const mention = contentBlockMention(update.content, session.cwd);
      const last = session.items[session.items.length - 1];
      if (last && last.kind === "user" && !last.queued) {
        const items = session.items.slice();
        items[items.length - 1] = {
          ...last,
          text: last.text + text,
          images: image ? [...(last.images ?? []), image] : last.images,
          mentions: mention ? [...(last.mentions ?? []), mention] : last.mentions,
        };
        return { session: { ...session, items }, editedPaths: [] };
      }
      const closed = closeStreams(session.items);
      const item: TranscriptItem = {
        kind: "user",
        id: itemId("user"),
        text,
        ...(image ? { images: [image] } : {}),
        ...(mention ? { mentions: [mention] } : {}),
      };
      return { session: { ...session, items: [...closed, item] }, editedPaths: [] };
    }

    case "agent_message_chunk": {
      const text = contentBlockText(update.content);
      const items = appendStreamChunk(session.items, "assistant", text, update.messageId);
      return { session: { ...session, items }, editedPaths: [] };
    }

    case "agent_thought_chunk": {
      const text = contentBlockText(update.content);
      const items = appendStreamChunk(session.items, "thinking", text, update.messageId);
      return { session: { ...session, items }, editedPaths: [] };
    }

    case "tool_call": {
      const id = update.toolCallId;
      const existing = session.tools[id];
      const status = mapToolStatus(update.status, existing?.status ?? "in_progress");
      const content = update.content ?? existing?.content ?? [];
      const tool: AcpToolCall = {
        id,
        title: update.title || existing?.title || update.name || "Tool",
        name: update.name ?? existing?.name,
        kind: update.kind ?? existing?.kind ?? "other",
        status,
        content,
        locations: update.locations ?? existing?.locations ?? [],
        rawInput: update.rawInput !== undefined ? update.rawInput : existing?.rawInput,
        rawOutput: update.rawOutput !== undefined ? update.rawOutput : existing?.rawOutput,
        startedAt: existing?.startedAt ?? now,
        endedAt: isToolDone(status) ? (existing?.endedAt ?? now) : undefined,
      };
      const items = existing
        ? session.items
        : [...closeStreams(session.items), { kind: "tool" as const, id: `tool:${id}`, toolCallId: id }];
      const { changedFiles, editedPaths } = recordDiffs(session.changedFiles, id, content);
      return {
        session: {
          ...session,
          items,
          tools: { ...session.tools, [id]: tool },
          changedFiles,
        },
        editedPaths,
      };
    }

    case "tool_call_update": {
      const id = update.toolCallId;
      const existing = session.tools[id];
      const prevStatus = existing?.status ?? "in_progress";
      // Keep a locally denied call marked denied even if the agent follows up with failed.
      const nextStatus = prevStatus === "denied" ? "denied" : mapToolStatus(update.status, prevStatus);
      const content = update.content ?? existing?.content ?? [];
      const tool: AcpToolCall = {
        id,
        title: update.title ?? existing?.title ?? update.name ?? "Tool",
        name: update.name ?? existing?.name,
        kind: update.kind ?? existing?.kind ?? "other",
        status: nextStatus,
        content,
        locations: update.locations ?? existing?.locations ?? [],
        rawInput: update.rawInput !== undefined ? update.rawInput : existing?.rawInput,
        rawOutput: update.rawOutput !== undefined ? update.rawOutput : existing?.rawOutput,
        startedAt: existing?.startedAt ?? now,
        endedAt: isToolDone(nextStatus) ? (existing?.endedAt ?? now) : existing?.endedAt,
      };
      const items = existing
        ? session.items
        : [...closeStreams(session.items), { kind: "tool" as const, id: `tool:${id}`, toolCallId: id }];
      const { changedFiles, editedPaths } = recordDiffs(session.changedFiles, id, content);
      return {
        session: {
          ...session,
          items,
          tools: { ...session.tools, [id]: tool },
          changedFiles,
        },
        editedPaths,
      };
    }

    case "plan": {
      return { session: { ...session, plan: update.entries ?? [] }, editedPaths: [] };
    }

    case "available_commands_update": {
      return { session: { ...session, availableCommands: update.availableCommands ?? [] }, editedPaths: [] };
    }

    case "config_option_update": {
      return { session: { ...session, configOptions: update.configOptions ?? [] }, editedPaths: [] };
    }

    case "current_mode_update": {
      const modes = session.modes
        ? { ...session.modes, currentModeId: update.currentModeId }
        : { currentModeId: update.currentModeId, availableModes: [] };
      const configOptions = session.configOptions.map((opt) =>
        opt.type === "select" && (opt.category === "mode" || opt.id === "mode")
          ? { ...opt, currentValue: update.currentModeId }
          : opt,
      );
      return { session: { ...session, modes, configOptions }, editedPaths: [] };
    }

    case "session_info_update": {
      const title = update.title === null ? undefined : update.title !== undefined ? update.title : session.title;
      return { session: { ...session, title }, editedPaths: [] };
    }

    case "usage_update": {
      return {
        session: {
          ...session,
          usage: {
            used: update.used,
            size: update.size,
            cost: update.cost ?? session.usage?.cost ?? null,
          },
        },
        editedPaths: [],
      };
    }

    case "compaction_update": {
      const summary =
        update.summary === null
          ? ""
          : update.summary !== undefined
            ? update.summary.map(contentBlockText).join("")
            : undefined;
      const idx = session.items.findIndex((it) => it.kind === "compaction" && it.compactionId === update.compactionId);
      if (idx >= 0) {
        const prev = session.items[idx] as Extract<TranscriptItem, { kind: "compaction" }>;
        const items = session.items.slice();
        items[idx] = {
          ...prev,
          status: update.status,
          summary: summary !== undefined ? summary : prev.summary,
          error: update.error === null ? undefined : update.error !== undefined ? update.error : prev.error,
        };
        return { session: { ...session, items }, editedPaths: [] };
      }
      const closed = closeStreams(session.items);
      return {
        session: {
          ...session,
          items: [
            ...closed,
            {
              kind: "compaction",
              id: `compaction:${update.compactionId}`,
              compactionId: update.compactionId,
              status: update.status,
              summary: summary ?? "",
              error: update.error ?? undefined,
            },
          ],
        },
        editedPaths: [],
      };
    }

    case "compaction_summary_chunk": {
      const chunk = contentBlockText(update.content);
      const idx = session.items.findIndex((it) => it.kind === "compaction" && it.compactionId === update.compactionId);
      if (idx >= 0) {
        const prev = session.items[idx] as Extract<TranscriptItem, { kind: "compaction" }>;
        const items = session.items.slice();
        items[idx] = { ...prev, summary: prev.summary + chunk };
        return { session: { ...session, items }, editedPaths: [] };
      }
      const closed = closeStreams(session.items);
      return {
        session: {
          ...session,
          items: [
            ...closed,
            {
              kind: "compaction",
              id: `compaction:${update.compactionId}`,
              compactionId: update.compactionId,
              status: "in_progress",
              summary: chunk,
            },
          ],
        },
        editedPaths: [],
      };
    }

    case "notice": {
      const tone: "info" | "warn" | "error" =
        update.severity === "error" ? "error" : update.severity === "warning" ? "warn" : "info";
      const closed = closeStreams(session.items);
      return {
        session: {
          ...session,
          items: [
            ...closed,
            {
              kind: "notice",
              id: itemId("notice"),
              tone,
              title: update.title,
              description: update.description ?? undefined,
            },
          ],
        },
        editedPaths: [],
      };
    }

    default:
      return { session, editedPaths: [] };
  }
}

/** Settles streaming items and any running tools at the end of a prompt turn. */
export function finishTurn(
  session: AntigravitySession,
  stopReason: StopReason | string,
  now: number,
  usage?: Usage | null,
): AntigravitySession {
  const durationMs = session.turnStartedAt ? Math.max(0, now - session.turnStartedAt) : 0;
  const cancelled = stopReason === "cancelled";
  const tools: Record<string, AcpToolCall> = { ...session.tools };
  for (const [id, tool] of Object.entries(tools)) {
    if (!isToolDone(tool.status)) {
      tools[id] = {
        ...tool,
        status: cancelled ? "cancelled" : "completed",
        endedAt: tool.endedAt ?? now,
      };
    }
  }
  const items = closeStreams(session.items);
  const totals: SessionTotals = {
    turns: session.totals.turns + 1,
    durationMs: session.totals.durationMs + durationMs,
    inputTokens: session.totals.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: session.totals.outputTokens + (usage?.outputTokens ?? 0),
    thoughtTokens: session.totals.thoughtTokens + (usage?.thoughtTokens ?? 0),
    cachedReadTokens: session.totals.cachedReadTokens + (usage?.cachedReadTokens ?? 0),
  };
  const resultItem: TranscriptItem = {
    kind: "result",
    id: itemId("result"),
    durationMs,
    stopReason,
    usage: usage ?? undefined,
    isError: stopReason === "refusal",
  };
  return {
    ...session,
    status: "idle",
    turnStartedAt: undefined,
    items: [...items, resultItem],
    tools,
    totals,
  };
}

/** Settles an abnormally ended session (transport exit or unrecoverable error). */
export function failSession(
  session: AntigravitySession,
  error: string,
  now: number,
  authRequired = false,
): AntigravitySession {
  const tools: Record<string, AcpToolCall> = { ...session.tools };
  for (const [id, tool] of Object.entries(tools)) {
    if (!isToolDone(tool.status)) {
      tools[id] = { ...tool, status: "cancelled", endedAt: tool.endedAt ?? now };
    }
  }
  return {
    ...session,
    status: "error",
    error,
    authRequired,
    turnStartedAt: undefined,
    items: closeStreams(session.items),
    tools,
    permissions: [],
    elicitations: [],
  };
}
