import { remoteIdOf, sameHost } from "../files/location";
import type { CopyProgress } from "../ipc/fs";
import { hostLabelForLocation } from "../ssh/connections";
import { baseName } from "./tree";

/*
 * Reactive file-transfer tracker for explorer panes (copy, move, duplicate,
 * local and cross-host SSH). Lives outside React so transfers survive pane
 * remounts and tab switches.
 */

export type TransferMode = "copy" | "move" | "duplicate";
export type TransferKind = "local" | "upload" | "download" | "remote-to-remote" | "remote";
export type TransferStatus = "running" | "done" | "error" | "cancelled";

export type FileTransfer = {
  readonly id: string;
  readonly paneId: string;
  readonly mode: TransferMode;
  readonly kind: TransferKind;
  readonly label: string;
  readonly fromHost: string | null;
  readonly toHost: string | null;
  readonly status: TransferStatus;
  /** Delayed for fast single-item same-host moves so instant renames never flicker. */
  readonly visible: boolean;
  /** Whether an in-progress cancel button can abort this transfer. */
  readonly cancellable: boolean;
  readonly itemsCompleted: number;
  readonly itemsTotal: number;
  /** Fraction [0, 1] of the item currently being transferred, when known. */
  readonly currentItemFraction: number | null;
  readonly bytesTransferred: number;
  readonly totalBytes: number | null;
  readonly filesCompleted: number;
  readonly totalFiles: number | null;
  readonly currentFile: string | null;
  readonly speedBps: number | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly error: string | null;
  readonly cancel: () => void;
};

export type TransferHandle = {
  readonly id: string;
  readonly signal: AbortSignal;
  startItem(itemPath: string): void;
  onItemProgress(progress: CopyProgress): void;
  finishItem(): void;
  finish(outcome: { status: "done" | "error" | "cancelled"; error?: string | null }): void;
};

const AUTO_DISMISS_MS = 4500;
const FAST_MOVE_REVEAL_MS = 120;

let nextSeq = 1;
let entries: FileTransfer[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Transfer ids whose owning pane was disposed while running; removed once settled. */
const detachedOnDispose = new Set<string>();

function emit(): void {
  for (const listener of listeners) listener();
}

function updateEntry(id: string, patch: Partial<FileTransfer>): void {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) return;
  const next = entries.slice();
  next[index] = { ...next[index], ...patch };
  entries = next;
  emit();
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

export function explorerTransfers(): readonly FileTransfer[] {
  return entries;
}

export function subscribeExplorerTransfers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dismissTransfer(id: string): void {
  clearTimer(id);
  detachedOnDispose.delete(id);
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length === entries.length) return;
  entries = next;
  emit();
}

export function clearFinishedTransfers(paneId: string): void {
  let changed = false;
  const next: FileTransfer[] = [];
  for (const entry of entries) {
    if (entry.paneId === paneId && entry.status !== "running") {
      clearTimer(entry.id);
      detachedOnDispose.delete(entry.id);
      changed = true;
    } else {
      next.push(entry);
    }
  }
  if (!changed) return;
  entries = next;
  emit();
}

/**
 * Releases transfer cards owned by a disposed pane: finished ones are removed
 * immediately and any still-running ones are marked to drop once they settle
 * so they never leak in the store without an owner.
 */
export function cleanupPaneTransfers(paneId: string): void {
  for (const entry of entries) {
    if (entry.paneId === paneId && entry.status === "running") {
      detachedOnDispose.add(entry.id);
    }
  }
  clearFinishedTransfers(paneId);
}

/** Test-only reset helper. */
export function resetTransfersForTest(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  detachedOnDispose.clear();
  entries = [];
  emit();
}

function classifyTransfer(sources: string[], destDir: string): {
  kind: TransferKind;
  fromHost: string | null;
  toHost: string | null;
} {
  const destRemote = remoteIdOf(destDir);
  const firstSource = sources[0];
  const srcRemote = firstSource ? remoteIdOf(firstSource) : null;
  const crossHost = sources.some((src) => !sameHost(src, destDir));
  const fromHost = srcRemote ? (hostLabelForLocation(firstSource) ?? srcRemote) : null;
  const toHost = destRemote ? (hostLabelForLocation(destDir) ?? destRemote) : null;
  if (!crossHost) {
    return { kind: destRemote ? "remote" : "local", fromHost, toHost };
  }
  if (!srcRemote && destRemote) return { kind: "upload", fromHost: "Local", toHost };
  if (srcRemote && !destRemote) return { kind: "download", fromHost, toHost: "Local" };
  return { kind: "remote-to-remote", fromHost, toHost };
}

/**
 * Registers a new explorer file transfer and returns a handle for updating
 * progress, cancelling via `AbortSignal`, and finishing it.
 */
export function beginTransfer({
  paneId,
  mode,
  sources,
  destDir,
}: {
  paneId: string;
  mode: TransferMode;
  sources: string[];
  destDir: string;
}): TransferHandle {
  const id = `transfer-${nextSeq++}`;
  const controller = new AbortController();
  const { kind, fromHost, toHost } = classifyTransfer(sources, destDir);
  const label = sources.length === 1 ? baseName(sources[0]) : `${sources.length} items`;
  const immediate = mode !== "move" || sources.length > 1 || kind === "upload" || kind === "download" || kind === "remote-to-remote";
  // Same-remote copies run as one helper RPC, so only multi-item batches can cancel between items.
  const cancellable = !(kind === "remote" && sources.length <= 1);
  const startedAt = Date.now();

  let doneBytes = 0;
  let doneFiles = 0;
  let itemBytes = 0;
  let itemFiles = 0;
  let itemsCompleted = 0;
  let lastSampleAt = startedAt;
  let lastSampleBytes = 0;
  let smoothedBps: number | null = null;
  let settled = false;

  const entry: FileTransfer = {
    id,
    paneId,
    mode,
    kind,
    label,
    fromHost,
    toHost,
    status: "running",
    visible: immediate,
    cancellable,
    itemsCompleted: 0,
    itemsTotal: sources.length,
    currentItemFraction: null,
    bytesTransferred: 0,
    totalBytes: null,
    filesCompleted: 0,
    totalFiles: null,
    currentFile: sources[0] ? baseName(sources[0]) : null,
    speedBps: null,
    startedAt,
    finishedAt: null,
    error: null,
    cancel: () => {
      if (settled || controller.signal.aborted) return;
      controller.abort();
      updateEntry(id, { visible: true });
    },
  };

  entries = [...entries, entry];
  emit();

  if (!immediate) {
    const revealTimer = setTimeout(() => {
      timers.delete(id);
      if (!settled) updateEntry(id, { visible: true });
    }, FAST_MOVE_REVEAL_MS);
    timers.set(id, revealTimer);
  }

  return {
    id,
    signal: controller.signal,
    startItem(itemPath) {
      if (settled) return;
      itemBytes = 0;
      itemFiles = 0;
      updateEntry(id, {
        currentFile: baseName(itemPath),
        currentItemFraction: null,
      });
    },
    onItemProgress(progress) {
      if (settled) return;
      itemBytes = progress.bytesTransferred;
      itemFiles = progress.filesCompleted;
      const totalBytesNow = doneBytes + itemBytes;
      const totalFilesNow = doneFiles + itemFiles;
      const now = Date.now();
      const dt = (now - lastSampleAt) / 1000;
      if (dt >= 0.15 && totalBytesNow >= lastSampleBytes) {
        const instant = (totalBytesNow - lastSampleBytes) / dt;
        smoothedBps = smoothedBps === null ? instant : smoothedBps * 0.65 + instant * 0.35;
        lastSampleAt = now;
        lastSampleBytes = totalBytesNow;
      }
      const single = sources.length === 1;
      const itemFraction =
        progress.totalBytes !== null && progress.totalBytes > 0
          ? Math.min(1, progress.bytesTransferred / progress.totalBytes)
          : progress.totalFiles !== null && progress.totalFiles > 0
            ? Math.min(1, progress.filesCompleted / progress.totalFiles)
            : progress.totalBytes === 0
              ? progress.filesCompleted > 0
                ? 1
                : 0
              : null;
      updateEntry(id, {
        bytesTransferred: totalBytesNow,
        totalBytes: single ? progress.totalBytes : null,
        filesCompleted: totalFilesNow,
        totalFiles: single ? progress.totalFiles : null,
        currentItemFraction: itemFraction,
        currentFile: progress.currentFile ?? baseName(sources[Math.min(itemsCompleted, sources.length - 1)] ?? ""),
        speedBps: smoothedBps,
      });
    },
    finishItem() {
      if (settled) return;
      doneBytes += itemBytes;
      doneFiles += itemFiles;
      itemBytes = 0;
      itemFiles = 0;
      itemsCompleted = Math.min(sources.length, itemsCompleted + 1);
      updateEntry(id, {
        itemsCompleted,
        bytesTransferred: doneBytes,
        filesCompleted: doneFiles,
        currentItemFraction: 0,
      });
    },
    finish({ status, error = null }) {
      if (settled) return;
      settled = true;
      clearTimer(id);
      const current = entries.find((candidate) => candidate.id === id);
      // Drop entries whose pane already closed, or fast single-item moves that finished silently.
      if (detachedOnDispose.delete(id) || (status === "done" && current && !current.visible)) {
        dismissTransfer(id);
        return;
      }
      updateEntry(id, {
        status,
        visible: true,
        finishedAt: Date.now(),
        error,
        speedBps: null,
        ...(status === "done"
          ? { itemsCompleted: sources.length, currentItemFraction: 1 }
          : {}),
      });
      if (status === "done") {
        const dismissTimer = setTimeout(() => {
          timers.delete(id);
          dismissTransfer(id);
        }, AUTO_DISMISS_MS);
        timers.set(id, dismissTimer);
      }
    },
  };
}

/** Overall progress fraction in `[0, 1]`, or `null` when indeterminate. */
export function transferFraction(transfer: FileTransfer): number | null {
  if (transfer.status === "done") return 1;
  if (transfer.itemsTotal <= 1) {
    if (transfer.totalBytes !== null && transfer.totalBytes > 0) {
      return Math.max(0, Math.min(1, transfer.bytesTransferred / transfer.totalBytes));
    }
    if (transfer.totalFiles !== null && transfer.totalFiles > 0) {
      return Math.max(0, Math.min(1, transfer.filesCompleted / transfer.totalFiles));
    }
    if (transfer.totalBytes === 0) return transfer.filesCompleted > 0 ? 1 : 0;
    return transfer.currentItemFraction;
  }
  const sub = transfer.currentItemFraction ?? 0;
  return Math.max(0, Math.min(1, (transfer.itemsCompleted + sub) / transfer.itemsTotal));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(remainingBytes: number, bytesPerSecond: number): string | null {
  if (!Number.isFinite(remainingBytes) || !Number.isFinite(bytesPerSecond) || remainingBytes <= 0 || bytesPerSecond < 1) {
    return null;
  }
  const seconds = Math.ceil(remainingBytes / bytesPerSecond);
  if (seconds <= 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}
