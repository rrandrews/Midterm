import { useCallback, useEffect, useState } from "react";
import {
  type DisableDropArgs,
  Workspace as Dock,
  Separator,
  type TabsetNode,
  type WorkspaceClassNames,
} from "react-resizable-panels";
import { type DockHandle, getDock, registerDock, restoreFocusAfterLayoutChange } from "../../layout/dock";
import { notePaneDrag } from "../../layout/paneDrag";
import {
  clampSizeLimits,
  DEFAULT_MIN_HEIGHT,
  DEFAULT_MIN_WIDTH,
  type FrameLimits,
  frameLimitUpdates,
  withSizeLimits,
} from "../../layout/paneSize";
import { activePlugin, kindLabel, subscribePlugins } from "../../plugins/registry";
import { countPanes } from "../../state/layout";
import { findTab, useAppStore } from "../../state/store";
import type { Layout, PaneData, PaneNode, Tab } from "../../state/types";
import { PaneHost } from "../../plugins/PaneHost";
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

const renderContent = (pane: PaneNode) => <PaneHost pane={pane} />;

const renderToolbar = (frame: Frame) => {
  const pane = paneOf(frame);
  return pane ? <PaneToolbar pane={pane} /> : null;
};

/** The size limits a pane of `kind` asks for (`pane.size`), clamped. */
const limitsOf = (kind: string): FrameLimits => clampSizeLimits(activePlugin(kind)?.pane.size);

const MIN_WIDTH = `${DEFAULT_MIN_WIDTH}px`;
const MIN_HEIGHT = `${DEFAULT_MIN_HEIGHT}px`;

/**
 * Brings a mounted layout's frame limits in line with their panes' plugins
 * (after a split, a change of pane type, a plugin loading). Each update is
 * reported as a model change, which stores it.
 */
function syncSizeLimits(dock: DockHandle): void {
  for (const { frameId, limits } of frameLimitUpdates(dock.getModel(), limitsOf)) dock.updateTabset(frameId, limits);
}

const renderSeparator = () => <Separator className="pane-separator" />;

const renderDragPreview = (frame: Frame) => {
  const pane = paneOf(frame);
  // Rendered only while a pane is dragged: lets tabs accept the drop.
  if (pane) notePaneDrag(pane.id);
  return pane ? kindLabel(pane.data.kind) : "Pane";
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
  // Starts with its frames' size limits set (a store-side edit does not set them).
  const [defaultModel] = useState(() => withSizeLimits(tab.layout, limitsOf));
  const [dock, setDock] = useState<DockHandle | null>(null);

  const dockRef = useCallback(
    (handle: DockHandle | null) => {
      setDock(handle);
      return handle ? registerDock({ id: tabId, layoutRev }, handle) : undefined;
    },
    [tabId, layoutRev],
  );

  // Imported plugins load after the layout is shown, and may be enabled, disabled or replaced.
  useEffect(() => (dock ? subscribePlugins(() => syncSizeLimits(dock)) : undefined), [dock]);

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
      // A new frame (a split, a drop at an edge) or a pane of another kind may need other limits.
      if (frameLimitUpdates(layout, limitsOf).length) {
        queueMicrotask(() => {
          const handle = getDock({ id: tabId, layoutRev });
          if (handle) syncSizeLimits(handle);
        });
      }
    },
    [tabId, layoutRev],
  );

  return (
    <Dock<PaneData>
      workspaceRef={dockRef}
      className="min-h-0 flex-1"
      classNames={CLASS_NAMES}
      defaultModel={defaultModel}
      disableDrop={rejectStacking}
      onModelChanged={onModelChanged}
      renderSeparator={renderSeparator}
      renderTabContent={renderContent}
      renderTabsetDragPreview={renderDragPreview}
      renderTabsetToolbar={renderToolbar}
      tabsetMinHeight={MIN_HEIGHT}
      tabsetMinWidth={MIN_WIDTH}
    />
  );
}
