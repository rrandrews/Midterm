import { useCallback, useEffect, useState } from "react";
import {
  type BeforeModelChangeArgs,
  type DisableDropArgs,
  Workspace as Dock,
  Separator,
  type TabRenderProps,
  type TabsetNode,
  type WorkspaceChangedMeta,
  type WorkspaceClassNames,
} from "react-resizable-panels";
import { type DockHandle, getDock, notePaneFocused, registerDock, restoreFocusAfterLayoutChange } from "../../layout/dock";
import { closePane } from "../../closing";
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
import { countPanes, frameOf, isShown, shownPane, visiblePanes } from "../../state/layout";
import { findTab, useAppStore } from "../../state/store";
import type { Layout, PaneData, PaneNode, Tab } from "../../state/types";
import { PaneHost } from "../../plugins/PaneHost";
import { PaneToolbar } from "./PaneToolbar";
import { Subtab } from "./Subtab";

type Frame = TabsetNode<PaneData>;

// Everything passed to the layout is defined out here: these props are part
// of what every pane re-renders for, so they must be referentially stable.

/** A frame with more than one pane shows them as subtabs, in a strip above the content. */
const hasSubtabs = (frame: Frame) => frame.tabs.length > 1;

const CLASS_NAMES: WorkspaceClassNames<PaneData> = {
  tabset: (frame) => (hasSubtabs(frame) ? "pane-frame has-subtabs" : "pane-frame"),
  header: "pane-header",
  tabList: "pane-tablist",
  dropIndicator: "pane-drop",
  dragPreview: "pane-drag-preview",
};

const paneOf = (frame: Frame): PaneNode | undefined => shownPane(frame);

/**
 * A pane dropped on the middle of another pane, or on a frame's subtab
 * strip, becomes a subtab of that frame. The one thing refused is dropping
 * a frame onto itself.
 */
function disableDrop({ target, tabset }: DisableDropArgs<PaneData>): boolean {
  return !!tabset && "tabsetId" in target && target.tabsetId === tabset.id;
}

/**
 * The library closes a focused subtab on Delete or Backspace; closing goes
 * through `closePane` instead, which asks first when something would be
 * lost (unsaved edits, a running program).
 */
function onBeforeModelChange({ reason, removedTabs }: BeforeModelChangeArgs<PaneData>): boolean {
  if (reason !== "close") return true;
  for (const pane of removedTabs) void closePane(pane.id);
  return false;
}

const renderContent = (pane: PaneNode) => <PaneHost pane={pane} />;

const renderTab = (pane: PaneNode, props: TabRenderProps) => <Subtab pane={pane} props={props} />;

const renderTabDragPreview = (pane: PaneNode) => {
  // Rendered only while a subtab is dragged: lets tabs accept the drop.
  notePaneDrag([pane.id]);
  return kindLabel(pane.data.kind);
};

const renderToolbar = (frame: Frame) => {
  const pane = paneOf(frame);
  return pane ? <PaneToolbar pane={pane} strip={hasSubtabs(frame)} /> : null;
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
  // Rendered only while a pane is dragged: lets tabs accept the drop. The
  // grip drags every subtab, the shown one first.
  if (pane) notePaneDrag([pane.id, ...frame.tabs.filter((tab) => tab !== pane).map((tab) => tab.id)]);
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
    (layout: Layout, meta?: WorkspaceChangedMeta) => {
      const state = useAppStore.getState();
      // Never let a stale layout overwrite the one that replaced it.
      if (findTab(state, tabId)?.layoutRev !== layoutRev) return;
      const { setTabLayout, setActivePane, closeTab } = state;
      if (countPanes(layout) === 0) {
        closeTab(tabId);
        return;
      }
      const previous = findTab(state, tabId);
      const active = previous?.activePaneId;
      setTabLayout(tabId, layout);
      // The pane commands and focus will go to (keyboard focus may stay on the strip).
      const activate = (paneId: string) => {
        setActivePane(paneId);
        notePaneFocused(paneId);
      };
      const shownBefore = new Set(previous ? visiblePanes(previous.layout).map((pane) => pane.id) : []);
      const revealed = visiblePanes(layout).find((pane) => !shownBefore.has(pane.id));
      if (meta?.reason === "select" && revealed) {
        // The user picked a subtab (by pointer or keyboard): it is the active pane.
        activate(revealed.id);
      } else if (active && !isShown(layout, active)) {
        // Another subtab of the active pane's frame is showing (one dropped in): it is the active pane now.
        const frame = frameOf(layout, active);
        const next = frame && shownPane(frame);
        if (next) activate(next.id);
      }
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
      disableDrop={disableDrop}
      onBeforeModelChange={onBeforeModelChange}
      onModelChanged={onModelChanged}
      renderDragPreview={renderTabDragPreview}
      renderSeparator={renderSeparator}
      renderTab={renderTab}
      renderTabContent={renderContent}
      renderTabsetDragPreview={renderDragPreview}
      renderTabsetToolbar={renderToolbar}
      tabsetMinHeight={MIN_HEIGHT}
      tabsetMinWidth={MIN_WIDTH}
      tabRemovalSelectionBehavior="adjacent"
    />
  );
}
