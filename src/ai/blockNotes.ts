import { create } from "zustand";
import { type StreamReply, toAiError } from "../ipc/ai";
import type { Block } from "../terminal/blocks";
import { EXPLAIN_MAX_TOKENS, NO_MODEL_MESSAGE, explainRequest } from "./blockAi";
import { targetFor } from "./profiles";
import { type TextStream, streamText } from "./stream";

/*
 * AI notes under blocks (Explain), per pane and block, outside React and in
 * memory only. One request per block (asking again restarts it); several
 * blocks may stream at once. Notes of blocks that left the scrollback are
 * pruned by the blocks view, and a pane's notes go with its session
 * (`dropPaneNotes`, hooked up by `installAi`).
 */

export type BlockNoteStatus = "loading" | "streaming" | "done" | "error";

export type BlockNote = {
  status: BlockNoteStatus;
  /** The Markdown so far. */
  text: string;
  error?: string;
  /** The reply hit the token limit. */
  cut?: boolean;
  /** Stopped by the user before the reply was complete. */
  stopped?: boolean;
  collapsed: boolean;
};

export const useBlockNotes = create<Record<string, Record<number, BlockNote>>>()(() => ({}));

const running = new Map<string, { cancel: () => void }>();
const key = (paneId: string, blockId: number) => `${paneId}\u0000${blockId}`;

export function noteOf(paneId: string, blockId: number): BlockNote | undefined {
  return useBlockNotes.getState()[paneId]?.[blockId];
}

function setNote(paneId: string, blockId: number, note: BlockNote | null): void {
  useBlockNotes.setState((state) => {
    const pane = { ...state[paneId] };
    if (note) pane[blockId] = note;
    else delete pane[blockId];
    const next = { ...state };
    if (Object.keys(pane).length) next[paneId] = pane;
    else delete next[paneId];
    return next;
  }, true);
}

function patchNote(paneId: string, blockId: number, change: Partial<BlockNote>): void {
  const note = noteOf(paneId, blockId);
  if (note) setNote(paneId, blockId, { ...note, ...change });
}

function cancelRunning(paneId: string, blockId: number): void {
  const k = key(paneId, blockId);
  running.get(k)?.cancel();
  running.delete(k);
}

/**
 * Runs a note's request: `open` starts the stream (or returns null when
 * there is nothing to ask). Exported for tests, which pass a fake stream.
 */
export function runNote(
  paneId: string,
  blockId: number,
  open: (onText: (soFar: string) => void) => Promise<TextStream | null>,
): void {
  cancelRunning(paneId, blockId);
  const k = key(paneId, blockId);
  setNote(paneId, blockId, { status: "loading", text: "", collapsed: false });
  let stream: TextStream | null = null;
  let cancelled = false;
  const handle = {
    cancel: () => {
      cancelled = true;
      stream?.cancel();
    },
  };
  running.set(k, handle);
  const current = () => running.get(k) === handle;
  const onText = (soFar: string) => {
    if (current() && soFar) patchNote(paneId, blockId, { status: "streaming", text: soFar });
  };
  void (async () => {
    let reply: StreamReply;
    try {
      stream = await open(onText);
      if (cancelled) {
        stream?.cancel();
        return;
      }
      if (!stream) {
        running.delete(k);
        patchNote(paneId, blockId, { status: "error", error: "This terminal is not available." });
        return;
      }
      reply = await stream.result;
    } catch (raw) {
      if (!current()) return;
      running.delete(k);
      const error = toAiError(raw);
      if (error.kind === "cancelled") patchNote(paneId, blockId, { status: "done", stopped: true });
      else if (error.kind === "empty" && !noteOf(paneId, blockId)?.text)
        patchNote(paneId, blockId, { status: "error", error: "The model sent no explanation." });
      else patchNote(paneId, blockId, { status: "error", error: error.message });
      return;
    }
    if (!current()) return;
    running.delete(k);
    patchNote(paneId, blockId, { status: "done", text: reply.text, cut: reply.stop === "length" });
  })();
}

/** Explain: streams an explanation of `block` into its note (restarting one that runs). */
export function explainBlock(paneId: string, block: Block): void {
  if (!block.command.trim() || block.end === undefined) return;
  if (!targetFor("explain")) {
    cancelRunning(paneId, block.id);
    setNote(paneId, block.id, { status: "error", text: "", error: NO_MODEL_MESSAGE, collapsed: false });
    return;
  }
  runNote(paneId, block.id, async (onText) => {
    const request = await explainRequest(paneId, block);
    if (!request) return null;
    return streamText("explain", { ...request, maxTokens: EXPLAIN_MAX_TOKENS }, onText);
  });
}

/** Stop: the request ends; the text so far stays. */
export function stopNote(paneId: string, blockId: number): void {
  const note = noteOf(paneId, blockId);
  if (!note || (note.status !== "loading" && note.status !== "streaming")) return;
  // Settled here rather than by the cancelled request, which is no longer current.
  cancelRunning(paneId, blockId);
  patchNote(paneId, blockId, { status: "done", stopped: true });
}

export function dismissNote(paneId: string, blockId: number): void {
  cancelRunning(paneId, blockId);
  setNote(paneId, blockId, null);
}

export function toggleNote(paneId: string, blockId: number): void {
  const note = noteOf(paneId, blockId);
  if (note) patchNote(paneId, blockId, { collapsed: !note.collapsed });
}

/** Drops the notes of blocks no longer shown (cleared, or out of the scrollback). */
export function pruneNotes(paneId: string, liveBlockIds: Iterable<number>): void {
  const notes = useBlockNotes.getState()[paneId];
  if (!notes) return;
  const live = new Set(liveBlockIds);
  for (const id of Object.keys(notes).map(Number)) if (!live.has(id)) dismissNote(paneId, id);
}

/** The pane's session ended: all its notes go. */
export function dropPaneNotes(paneId: string): void {
  const notes = useBlockNotes.getState()[paneId];
  if (!notes) return;
  for (const id of Object.keys(notes).map(Number)) cancelRunning(paneId, id);
  useBlockNotes.setState((state) => {
    const next = { ...state };
    delete next[paneId];
    return next;
  }, true);
}
