import { useEffect, useRef } from "react";
import { registerPaneFocuser } from "../../layout/dock";
import { kindLabel } from "../../plugins/registry";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  const [title, detail] =
    status === "missing"
      ? ["File not found", path]
      : status === "binary"
        ? ["Binary file", size === null ? "Not shown" : `${formatSize(size)}, not shown`]
        : status === "tooLarge"
          ? ["Too large to open", size === null ? path : formatSize(size)]
          : ["Could not open the file", error ?? path];
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

