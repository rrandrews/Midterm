import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  Check,
  Copy,
  FolderInput,
  Loader2,
  X,
} from "lucide-react";
import { useSyncExternalStore } from "react";
import {
  type FileTransfer,
  clearFinishedTransfers,
  dismissTransfer,
  explorerTransfers,
  formatBytes,
  formatEta,
  formatRate,
  subscribeExplorerTransfers,
  transferFraction,
} from "../../explorer/transfers";
import { Tip } from "../ui/Tooltip";

function transferTitle(transfer: FileTransfer): string {
  const verb =
    transfer.status === "done"
      ? transfer.kind === "upload"
        ? "Uploaded"
        : transfer.kind === "download"
          ? "Downloaded"
          : transfer.mode === "move"
            ? "Moved"
            : transfer.mode === "duplicate"
              ? "Duplicated"
              : "Copied"
      : transfer.status === "cancelled"
        ? "Cancelled"
        : transfer.kind === "upload"
          ? "Uploading"
          : transfer.kind === "download"
            ? "Downloading"
            : transfer.mode === "move"
              ? "Moving"
              : transfer.mode === "duplicate"
                ? "Duplicating"
                : "Copying";
  return `${verb} ${transfer.label}`;
}

function hostRoute(transfer: FileTransfer): string | null {
  if (transfer.kind === "upload" && transfer.toHost) return `→ ${transfer.toHost}`;
  if (transfer.kind === "download" && transfer.fromHost) return `← ${transfer.fromHost}`;
  if (transfer.kind === "remote-to-remote" && transfer.fromHost && transfer.toHost) {
    return `${transfer.fromHost} → ${transfer.toHost}`;
  }
  return null;
}

function TransferIcon({ transfer }: { transfer: FileTransfer }) {
  if (transfer.status === "done") return <Check size={12} strokeWidth={2.25} className="flex-none text-ok" aria-hidden="true" />;
  if (transfer.status === "error") return <AlertCircle size={12} strokeWidth={2} className="flex-none text-err" aria-hidden="true" />;
  if (transfer.status === "cancelled") return <Ban size={12} strokeWidth={2} className="flex-none text-fg-dim" aria-hidden="true" />;
  if (transfer.kind === "upload") return <ArrowUpFromLine size={12} strokeWidth={2} className="flex-none text-accent" aria-hidden="true" />;
  if (transfer.kind === "download") return <ArrowDownToLine size={12} strokeWidth={2} className="flex-none text-accent" aria-hidden="true" />;
  if (transfer.mode === "move") return <FolderInput size={12} strokeWidth={2} className="flex-none text-accent" aria-hidden="true" />;
  if (transfer.mode === "copy" || transfer.mode === "duplicate") {
    return <Copy size={12} strokeWidth={2} className="flex-none text-accent" aria-hidden="true" />;
  }
  return <Loader2 size={12} className="flex-none animate-spin text-accent" aria-hidden="true" />;
}

function transferMeta(transfer: FileTransfer): string {
  if (transfer.status === "error") return transfer.error ?? "Transfer failed";
  if (transfer.status === "cancelled") {
    return transfer.itemsCompleted > 0
      ? `Stopped after ${transfer.itemsCompleted} of ${transfer.itemsTotal}`
      : "Cancelled";
  }
  const parts: string[] = [];
  if (transfer.status === "done") {
    if (transfer.bytesTransferred > 0) parts.push(formatBytes(transfer.bytesTransferred));
    if (transfer.filesCompleted > 1) parts.push(`${transfer.filesCompleted} files`);
    else if (transfer.itemsTotal > 1) parts.push(`${transfer.itemsTotal} items`);
    return parts.join(" · ") || "Complete";
  }
  if (transfer.itemsTotal > 1) {
    parts.push(`${Math.min(transfer.itemsCompleted + 1, transfer.itemsTotal)}/${transfer.itemsTotal}`);
  }
  if (transfer.totalBytes !== null && transfer.totalBytes > 0) {
    parts.push(`${formatBytes(transfer.bytesTransferred)} / ${formatBytes(transfer.totalBytes)}`);
  } else if (transfer.bytesTransferred > 0) {
    parts.push(formatBytes(transfer.bytesTransferred));
  } else if (transfer.filesCompleted > 0) {
    parts.push(`${transfer.filesCompleted} files`);
  }
  if (transfer.speedBps !== null && transfer.speedBps >= 1024) {
    parts.push(formatRate(transfer.speedBps));
    if (transfer.totalBytes !== null) {
      const eta = formatEta(transfer.totalBytes - transfer.bytesTransferred, transfer.speedBps);
      if (eta) parts.push(`~${eta}`);
    }
  }
  return parts.join(" · ") || "Starting…";
}

function TransferRow({ transfer }: { transfer: FileTransfer }) {
  const fraction = transferFraction(transfer);
  const percent = fraction !== null ? Math.round(fraction * 100) : null;
  const route = hostRoute(transfer);
  const running = transfer.status === "running";
  const title = transferTitle(transfer);
  const barTone =
    transfer.status === "done" ? "bg-ok" : transfer.status === "error" ? "bg-err" : transfer.status === "cancelled" ? "bg-fg-faint" : "bg-accent";
  const meta = transferMeta(transfer);
  const milestone =
    transfer.status === "running"
      ? `Started ${title.toLowerCase()}`
      : transfer.status === "error"
        ? `${title}: ${transfer.error ?? "Transfer failed"}`
        : title;

  return (
    <div className="explorer-transfer-item flex flex-col gap-1 px-2.5 py-1.5">
      <span className="sr-only" role="status" aria-live="polite">
        {milestone}
      </span>
      <div className="flex items-center gap-1.5">
        <TransferIcon transfer={transfer} />
        <Tip content={title} side="top">
          <span className="min-w-0 flex-1 truncate text-meta font-medium text-fg-soft">
            {title}
          </span>
        </Tip>
        {route && <span className="flex-none rounded bg-hover px-1 py-px text-micro text-fg-dim">{route}</span>}
        {running && percent !== null && (
          <span className="flex-none font-mono text-micro text-fg-dim tabular-nums">{percent}%</span>
        )}
        {(!running || transfer.cancellable) && (
          <Tip content={running ? "Cancel transfer" : "Dismiss"} side="left">
            <button
              type="button"
              aria-label={running ? `Cancel ${transfer.label}` : `Dismiss ${transfer.label}`}
              className="flex flex-none rounded p-0.5 text-fg-dim hover:bg-hover hover:text-fg-bright"
              onClick={() => (running ? transfer.cancel() : dismissTransfer(transfer.id))}
            >
              <X size={11} strokeWidth={2} />
            </button>
          </Tip>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent !== null ? percent : undefined}
        className="explorer-transfer-track h-[3px] w-full overflow-hidden rounded-full bg-hover"
      >
        {fraction !== null ? (
          <div
            className={`h-full rounded-full transition-[width] duration-100 ${barTone}`}
            style={{ width: `${Math.max(running ? 2 : 0, Math.round(fraction * 100))}%` }}
          />
        ) : running ? (
          <div className={`explorer-transfer-indeterminate h-full w-2/5 rounded-full ${barTone}`} />
        ) : (
          <div className={`h-full w-full rounded-full opacity-40 ${barTone}`} />
        )}
      </div>
      <div className="flex items-center gap-2 text-micro text-fg-dim">
        {running && transfer.currentFile && transfer.currentFile !== transfer.label && (
          <Tip content={transfer.currentFile} side="top">
            <span className="min-w-0 truncate">{transfer.currentFile}</span>
          </Tip>
        )}
        <Tip content={meta} side="top">
          <span
            className={`min-w-0 truncate font-mono tabular-nums ${
              running && transfer.currentFile && transfer.currentFile !== transfer.label ? "ml-auto flex-none" : ""
            } ${transfer.status === "error" ? "text-err" : ""}`}
          >
            {meta}
          </span>
        </Tip>
      </div>
    </div>
  );
}

/** Docked file-transfer progress tray at the bottom of an explorer pane. */
export function ExplorerTransfers({ paneId }: { paneId: string }) {
  const all = useSyncExternalStore(subscribeExplorerTransfers, explorerTransfers);
  const transfers = all.filter((transfer) => transfer.paneId === paneId && transfer.visible);
  if (transfers.length === 0) return null;
  const finishedCount = transfers.filter((transfer) => transfer.status !== "running").length;

  return (
    <div className="explorer-transfers flex flex-none flex-col border-t border-line bg-field/65" aria-label="File transfers">
      {transfers.length > 1 && (
        <div className="flex items-center justify-between border-b border-line/70 px-2.5 py-1 text-micro text-fg-dim">
          <span>
            {transfers.length} transfers
          </span>
          {finishedCount > 0 && (
            <button
              type="button"
              className="text-micro text-fg-muted hover:text-fg-bright"
              onClick={() => clearFinishedTransfers(paneId)}
            >
              Clear finished
            </button>
          )}
        </div>
      )}
      <div className="flex max-h-40 flex-col divide-y divide-line/60 overflow-y-auto">
        {transfers.map((transfer) => (
          <TransferRow key={transfer.id} transfer={transfer} />
        ))}
      </div>
    </div>
  );
}
