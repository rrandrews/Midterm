import { RefreshCw, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { openTerminalAt } from "../../actions";
import { parentPath } from "../../explorer/tree";
import { fallbackHostLabel, remoteIdOf } from "../../files/location";
import { homeDirectory } from "../../ipc/system";
import { registerPaneFocuser } from "../../layout/dock";
import { kindLabel } from "../../plugins/registry";
import { displayLocation, reconnectConnection, useSshConnection } from "../../ssh/connections";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Compact SSH host badge with connection status dot, or `null` for local files. */
export function SshHostBadge({ path }: { path: string }) {
  const remoteId = remoteIdOf(path);
  const remote = useSshConnection(remoteId);
  if (!remoteId) return null;
  const label = remote?.label ?? fallbackHostLabel(remoteId);
  const dot = remote?.status === "connected" ? "bg-ok" : remote?.status === "connecting" ? "bg-warn" : "bg-err";
  return (
    <span
      className="inline-flex max-w-[140px] flex-none items-center gap-1 rounded bg-hover px-1.5 py-0.5 text-micro text-fg-dim"
      title={`SSH: ${label} (${remote?.status ?? "disconnected"})`}
    >
      <span className={`size-1.5 flex-none rounded-full ${dot}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Compact reconnect bar shown when an open remote SSH file's connection is disconnected. */
export function SshDisconnectedBar({ paneId, path }: { paneId: string; path: string }) {
  const remoteId = remoteIdOf(path);
  const remote = useSshConnection(remoteId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [remoteId]);
  if (!remoteId || remote?.status === "connected" || remote?.status === "connecting") return null;

  const hostLabel = remote?.label ?? fallbackHostLabel(remoteId);
  const canReplaySsh = (remote?.sshArgs.length ?? 0) > 0;
  const reconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await reconnectConnection(remoteId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-none flex-col gap-1 border-y border-line bg-hover/40 pr-2 pl-4 py-1 text-meta">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-fg-dim">Disconnected from {hostLabel}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void reconnect()}
          className="inline-flex h-5 flex-none items-center gap-1 rounded-[4px] bg-hover px-2 text-micro text-fg-bright hover:bg-accent-soft disabled:opacity-50"
        >
          <RefreshCw size={10} className={busy ? "animate-spin" : undefined} />
          {busy ? "Reconnecting…" : "Reconnect"}
        </button>
        <button
          type="button"
          title={canReplaySsh ? "Open SSH terminal" : "Open local terminal to reconnect"}
          onClick={() => openTerminalAt(canReplaySsh ? parentPath(path) : undefined, paneId)}
          className="inline-flex h-5 flex-none items-center gap-1 rounded-[4px] bg-hover px-2 text-micro text-fg-dim hover:text-fg-bright"
        >
          <Terminal size={10} />
          Terminal
        </button>
      </div>
      {error && (
        <div className="truncate text-micro text-err" title={error}>
          {error}
        </div>
      )}
    </div>
  );
}

/** What the pane shows instead of the file while it cannot be shown. */
export function StatusMessage({
  status,
  path,
  size,
  error,
}: {
  status: string;
  path: string;
  size: number | null;
  error: string | null;
}) {
  if (status === "loading") return <div className="flex-1" />;
  const shownPath = displayLocation(path, homeDirectory(), { includeHost: true });
  const [title, detail] =
    status === "missing"
      ? ["File not found", shownPath]
      : status === "binary"
        ? ["Binary file", size === null ? "Not shown" : `${formatSize(size)}, not shown`]
        : status === "tooLarge"
          ? ["Too large to open", size === null ? shownPath : formatSize(size)]
          : ["Could not open the file", error ?? shownPath];
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
      <div className="font-medium text-fg-mid">{title}</div>
      <div className="max-w-full truncate text-meta text-fg-dim" title={detail}>
        {detail}
      </div>
    </div>
  );
}

/** An editor or viewer pane with no file (e.g. just changed to this type). */
export function NoFile({ paneId, kind }: { paneId: string; kind: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(
    () => registerPaneFocuser(paneId, () => ref.current?.focus({ preventScroll: true })),
    [paneId],
  );
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center outline-none"
    >
      <div className="font-medium text-fg-mid">{kindLabel(kind)}</div>
      <div className="text-meta text-fg-dim">No file open. Open one from the explorer.</div>
    </div>
  );
}

