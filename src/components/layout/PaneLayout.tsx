import { useCallback, useState } from "react";
import {
  type DisableDropArgs,
  Workspace as Dock,
  Separator,
  type TabsetNode,
  type WorkspaceClassNames,
} from "react-resizable-panels";
import { type DockHandle, registerDock, restoreFocusAfterLayoutChange } from "../../layout/dock";
import { PANE_LABELS, countPanes } from "../../state/layout";
import { findTab, useAppStore } from "../../state/store";
import type { Layout, PaneData, PaneNode, Tab } from "../../state/types";
import { PaneContent } from "../panes/PaneContent";
import { PaneToolbar } from "./PaneToolbar";

type Frame = TabsetNode<PaneData>;

// Everything passed to the layout is defined out here: these props are part
// of what every pane re-renders for, so they must be referentially stable.

const CLASS_NAMES: WorkspaceClassNames<PaneData> = {
  tabset: "pane-frame",
  header: "pane-header",
  tabList: "pane-tablist",
  dropIndicator: "pane-drop",
  dragPreview: "pane-drag-preview",
};

const paneOf = (frame: Frame): PaneNode | undefined =>
  frame.tabs.find((pane) => pane.id === frame.selectedId) ?? frame.tabs[0];

/**
 * One pane per frame: a dragged pane can split a frame or dock at an edge of
 * the layout, but never stacks into another pane's frame (as a second tab).
 */
function rejectStacking({ target }: DisableDropArgs<PaneData>): boolean {
  if ("edge" in target) return false;
  return "index" in target || target.region === "center";
}

const renderContent = (pane: PaneNode) => <PaneContent pane={pane} />;

const renderSeparator = () => <Separator className="pane-separator" />;

const renderDragPreview = (frame: Frame) => {
  const pane = paneOf(frame);
  return pane ? PANE_LABELS[pane.data.kind] : "Pane";
};

/**
 * The split layout of one tab's panes.
 *
 * Uncontrolled: it starts from `tab.layout` and reports changes back to the
 * store. Give it a key that changes with `tab.id` and `tab.layoutRev`, so it
 * remounts when a different layout has to be shown. Remounting is cheap
 * because pane state (terminals) lives outside React.
 */
export function PaneLayout({ tab }: { tab: Tab }) {
  const tabId = tab.id;
  // The revision this instance was mounted for; a newer one means the store
  // has moved on and this instance is about to be replaced.
  const [layoutRev] = useState(tab.layoutRev);
  const alone = countPanes(tab.layout) <= 1;

  const dockRef = useCallback(
    (handle: DockHandle | null) =>
      handle ? registerDock({ id: tabId, layoutRev }, handle) : undefined,
    [tabId, layoutRev],
  );

  const onModelChanged = useCallback(
    (layout: Layout) => {
      const state = useAppStore.getState();
      // Never let a stale layout overwrite the one that replaced it.
      if (findTab(state, tabId)?.layoutRev !== layoutRev) return;
      const { setTabLayout, closeTab } = state;
      if (countPanes(layout) === 0) {
        closeTab(tabId);
        return;
      }
      setTabLayout(tabId, layout);
      restoreFocusAfterLayoutChange();
    },
    [tabId, layoutRev],
  );

  const renderToolbar = useCallback(
    (frame: Frame) => {
      const pane = paneOf(frame);
      return pane ? <PaneToolbar pane={pane} alone={alone} /> : null;
    },
    [alone],
  );

  return (
    <Dock<PaneData>
      workspaceRef={dockRef}
      className="min-h-0 flex-1"
      classNames={CLASS_NAMES}
      defaultModel={tab.layout}
      disableDrop={rejectStacking}
      onModelChanged={onModelChanged}
      renderSeparator={renderSeparator}
      renderTabContent={renderContent}
      renderTabsetDragPreview={renderDragPreview}
      renderTabsetToolbar={renderToolbar}
      tabsetMinHeight="56px"
      tabsetMinWidth="96px"
    />
  );
}
