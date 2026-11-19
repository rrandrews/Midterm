import { memo } from "react";
import { notePaneFocused } from "../../layout/dock";
import { selectActiveTab, useAppStore } from "../../state/store";
import { peekSession } from "../../terminal/sessions";
import type { PaneNode } from "../../state/types";
import { PaneMenuItems } from "../layout/PaneMenuItems";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, MenuSeparator } from "../ui/Menu";
import { peekExplorer } from "../../explorer/explorers";
import { ExplorerMenuItems } from "./ExplorerMenus";
import { ExplorerPane } from "./ExplorerPane";
import { FileMenuItems } from "./FileMenuItems";
import { FilePane } from "./FilePane";
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
            // click; ⌥ forces the menu (xterm keeps ⌥-clicks from the
            // program, as `macOptionClickForcesSelection` is on; ⇧ would
            // not). Preventing the default also stops the menu opening.
            const session = kind === "terminal" ? peekSession(pane.id) : undefined;
            if (session?.wantsMouse && !event.altKey) event.preventDefault();
          }}
        >
          {kind === "terminal" ? (
            <TerminalPane paneId={pane.id} mode={pane.data.terminalMode} />
          ) : kind === "explorer" ? (
            <ExplorerPane paneId={pane.id} />
          ) : (
            <FilePane paneId={pane.id} kind={kind} path={pane.data.path} />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Pane">
        <KindMenuItems paneId={pane.id} kind={kind} path={pane.data.path} />
        <PaneMenuItems paneId={pane.id} />
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** The part of a pane's right-click menu that depends on its kind, with a separator after it. */
function KindMenuItems({ paneId, kind, path }: { paneId: string; kind: PaneNode["data"]["kind"]; path?: string }) {
  const explorer = kind === "explorer" ? peekExplorer(paneId) : undefined;
  const items =
    kind === "terminal" ? (
      <TerminalMenuItems paneId={paneId} />
    ) : explorer ? (
      <ExplorerMenuItems model={explorer} />
    ) : path ? (
      <FileMenuItems paneId={paneId} path={path} />
    ) : null;
  if (!items) return null;
  return (
    <>
      {items}
      <MenuSeparator />
    </>
  );
}
