import { useEffect, useRef } from "react";
import { registerPaneFocuser } from "../../layout/dock";
import { PANE_LABELS } from "../../state/layout";
import type { PaneKind } from "../../state/types";

/** Stands in for pane kinds that are not built yet (see docs/roadmap.md). */
export function PlaceholderPane({ paneId, kind }: { paneId: string; kind: PaneKind }) {
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
      <div className="text-meta text-fg-dim">Not available yet</div>
    </div>
  );
}
