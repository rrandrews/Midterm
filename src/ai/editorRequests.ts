import { create } from "zustand";
import type { CmdRequest } from "./slash";

/*
 * Requests whose answer lands in a pane's blocks input editor (`/cmd`, Fix),
 * per pane and outside React, so a block's Fix button can start one. The
 * editor (BlockInput) shows the request line and its status above itself,
 * puts `result` in the editor when it is done, and puts `restore` back on an
 * error or a cancel. One request per pane: starting another cancels it.
 */

export type EditorRequestStatus = "loading" | "done" | "error";

export type EditorRequest = {
  /** Tells requests apart, so the editor applies each answer once. */
  id: number;
  /** Shown above the editor (`/cmd …`, `fix: …`). */
  line: string;
  status: EditorRequestStatus;
  /** Shown while loading, e.g. "writing a command… esc cancels". */
  busy: string;
  message?: string;
  /** The command to put in the editor once done. */
  result?: string;
  /** What goes back in the editor on an error or a cancel. */
  restore: string;
  /** The editor has put `result` (or `restore`, on an error) in place. */
  applied: boolean;
};

export const useEditorRequests = create<Record<string, EditorRequest>>()(() => ({}));

const running = new Map<string, CmdRequest>();
let counter = 0;

function setEntry(paneId: string, entry: EditorRequest | null): void {
  useEditorRequests.setState((state) => {
    const next = { ...state };
    if (entry) next[paneId] = entry;
    else delete next[paneId];
    return next;
  }, true);
}

function patch(paneId: string, id: number, change: Partial<EditorRequest>): void {
  const entry = useEditorRequests.getState()[paneId];
  if (entry?.id === id) setEntry(paneId, { ...entry, ...change });
}

/** Starts a request for the pane's editor (cancelling the one before). */
export function startEditorRequest(
  paneId: string,
  options: { line: string; restore: string; busy: string; run: () => CmdRequest },
): void {
  running.get(paneId)?.cancel();
  running.delete(paneId);
  const id = ++counter;
  setEntry(paneId, { id, line: options.line, status: "loading", busy: options.busy, restore: options.restore, applied: false });
  const request = options.run();
  running.set(paneId, request);
  request.result.then(
    (command) => {
      if (running.get(paneId) !== request) return;
      running.delete(paneId);
      patch(paneId, id, { status: "done", result: command });
    },
    (error: { kind?: string; message?: string }) => {
      if (running.get(paneId) !== request) return;
      running.delete(paneId);
      patch(paneId, id, { status: "error", message: error?.message ?? String(error) });
    },
  );
}

/** A request with an error at once (e.g. `/cmd` without a task); `restore` goes back in the editor. */
export function failEditorRequest(paneId: string, options: { line: string; restore: string; message: string }): void {
  running.get(paneId)?.cancel();
  running.delete(paneId);
  setEntry(paneId, { id: ++counter, line: options.line, status: "error", busy: "", message: options.message, restore: options.restore, applied: false });
}

/**
 * Cancels the pane's request and forgets it. Returns what goes back in the
 * editor (`restore`) when one was loading, else undefined.
 */
export function cancelEditorRequest(paneId: string): string | undefined {
  const entry = useEditorRequests.getState()[paneId];
  running.get(paneId)?.cancel();
  running.delete(paneId);
  if (entry) setEntry(paneId, null);
  return entry?.status === "loading" ? entry.restore : undefined;
}

/** The editor applied the answer (or the restore) of request `id`. */
export function markApplied(paneId: string, id: number): void {
  patch(paneId, id, { applied: true });
}

/** What the editor should put in place for a settled request it has not applied yet. */
export function pendingText(entry: EditorRequest | undefined): string | undefined {
  if (!entry || entry.applied) return undefined;
  if (entry.status === "done") return entry.result;
  if (entry.status === "error") return entry.restore;
  return undefined;
}

/** Forgets a settled request (the editor was emptied). A loading one stays. */
export function clearEditorRequest(paneId: string): void {
  if (useEditorRequests.getState()[paneId]?.status !== "loading") setEntry(paneId, null);
}

/* ---- The editor's draft, for requests started elsewhere ---- */

type EditorHandle = { draft: () => string; focus: () => void };
const editors = new Map<string, EditorHandle>();

/** Called by the mounted editor; returns its unbind. */
export function bindEditor(paneId: string, handle: EditorHandle): () => void {
  editors.set(paneId, handle);
  return () => {
    if (editors.get(paneId) === handle) editors.delete(paneId);
  };
}

/** The pane's editor text right now; undefined when no editor is mounted. */
export function editorDraft(paneId: string): string | undefined {
  return editors.get(paneId)?.draft();
}

export function focusEditor(paneId: string): void {
  editors.get(paneId)?.focus();
}
