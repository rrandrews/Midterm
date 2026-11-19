import { memo } from "react";
import { notePaneFocused } from "../../layout/dock";
import { selectActiveTab, useAppStore } from "../../state/store";
import type { PaneNode } from "../../state/types";
import { PlaceholderPane } from "./PlaceholderPane";
import { TerminalPane } from "./TerminalPane";

/** Renders a pane's content according to its kind, and tracks whether it is the active pane. */
export const PaneContent = memo(function PaneContent({ pane }: { pane: PaneNode }) {
  const { kind } = pane.data;
  const active = useAppStore((state) => selectActiveTab(state).activePaneId === pane.id);
  const activate = () => {
    notePaneFocused(pane.id);
    useAppStore.getState().setActivePane(pane.id);
  };

  return (
    <div
      className={`pane pane-${kind}${active ? " is-active" : ""}`}
      data-pane-id={pane.id}
      data-pane-kind={kind}
      // The pane becomes active when anything inside it is focused or pressed.
      onFocusCapture={activate}
      onPointerDownCapture={activate}
    >
      {kind === "terminal" ? (
        <TerminalPane paneId={pane.id} />
      ) : (
        <PlaceholderPane paneId={pane.id} kind={kind} />
      )}
    </div>
  );
});
