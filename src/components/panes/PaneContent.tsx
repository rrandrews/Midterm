import { memo } from "react";
import { notePaneFocused } from "../../layout/dock";
import { selectActiveTab, useAppStore } from "../../state/store";
import { peekSession } from "../../terminal/sessions";
import type { PaneNode } from "../../state/types";
import { PaneMenuItems } from "../layout/PaneMenuItems";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, MenuSeparator } from "../ui/Menu";
import { PlaceholderPane } from "./PlaceholderPane";
import { TerminalMenuItems } from "./TerminalMenuItems";
import { TerminalPane } from "./TerminalPane";

/**
 * Renders a pane's content according to its kind, tracks whether it is the
 * active pane, and gives it a right-click menu: commands for its kind, then
 * the commands every pane has.
 */
export const PaneContent = memo(function PaneContent({ pane }: { pane: PaneNode }) {
  const { kind } = pane.data;
  const active = useAppStore((state) => selectActiveTab(state).activePaneId === pane.id);
  const activate = () => {
    notePaneFocused(pane.id);
    useAppStore.getState().setActivePane(pane.id);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={`pane pane-${kind}${active ? " is-active" : ""}`}
          data-pane-id={pane.id}
          data-pane-kind={kind}
          // The pane becomes active when anything inside it is focused or pressed.
          onFocusCapture={activate}
          onPointerDownCapture={activate}
          onContextMenu={(event) => {
            // A program that reads the mouse (vim, htop…) gets the right
            // click; ⇧ forces the menu. Preventing the default here also
            // stops the menu from opening.
            const session = kind === "terminal" ? peekSession(pane.id) : undefined;
            if (session?.wantsMouse && !event.shiftKey) event.preventDefault();
          }}
        >
          {kind === "terminal" ? (
            <TerminalPane paneId={pane.id} />
          ) : (
            <PlaceholderPane paneId={pane.id} kind={kind} />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Pane">
        {kind === "terminal" && (
          <>
            <TerminalMenuItems paneId={pane.id} />
            <MenuSeparator />
          </>
        )}
        <PaneMenuItems paneId={pane.id} />
      </ContextMenuContent>
    </ContextMenu>
  );
});
