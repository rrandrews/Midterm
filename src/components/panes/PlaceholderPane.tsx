import { useEffect, useRef } from "react";
import { registerPaneFocuser } from "../../layout/dock";
import { baseName } from "../../explorer/tree";
import { PANE_LABELS } from "../../state/layout";
import type { PaneKind } from "../../state/types";

/** Stands in for pane kinds that are not built yet (see docs/roadmap.md). */
type PlaceholderPaneProps = { paneId: string; kind: PaneKind; path?: string };

export function PlaceholderPane({ paneId, kind, path }: PlaceholderPaneProps) {
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
      <div className="font-medium text-fg-mid">{PANE_LABELS[kind]}</div>
      {path && (
        <div className="max-w-full truncate font-mono text-meta text-fg-soft" title={path}>
          {baseName(path)}
        </div>
      )}
      <div className="text-meta text-fg-dim">Not available yet</div>
    </div>
  );
}
