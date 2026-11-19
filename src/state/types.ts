import type { TabNode, WorkspaceModel, WorkspaceNodeInput } from "react-resizable-panels";

/*
 * Naming: the app has workspaces → tabs → panes.
 *
 * The pane layout inside one tab is a react-resizable-panels "Workspace"
 * model, whose own vocabulary is splits → tabsets → tabs. We put exactly one
 * of its "tabs" in each tabset, so in this codebase:
 *
 *   library tab node  = a pane   (PaneNode)
 *   library tabset    = the pane's frame (drag handle, menu, drop target)
 *   library workspace = one tab's pane layout (Layout)
 */

export const PANE_KINDS = ["terminal", "explorer", "editor", "viewer"] as const;
export type PaneKind = (typeof PANE_KINDS)[number];

/** Serializable per-pane data, stored in the layout model. */
export type PaneData = { kind: PaneKind };

export type PaneNode = TabNode<PaneData>;
export type Layout = WorkspaceModel<PaneData>;
export type LayoutNodeInput = WorkspaceNodeInput<PaneData>;

export type Tab = {
  id: string;
  title: string;
  layout: Layout;
  /**
   * Bumped when the layout is changed from outside the mounted layout
   * component, which is uncontrolled and has to be remounted to pick it up.
   */
  layoutRev: number;
  /** A pane produced output while this tab was in the background. */
  activity: boolean;
};

export type Workspace = {
  id: string;
  name: string;
  tabs: Tab[];
  activeTabId: string;
};
