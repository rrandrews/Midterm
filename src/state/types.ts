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

/**
 * A pane's kind is the id of the plugin that renders it (`terminal`,
 * `explorer`, `editor`, `viewer`, or an imported plugin's id). See
 * `src/plugins/` and docs/plugins.md.
 */
export type PaneKind = string;

/**
 * Serializable per-pane data, stored in the layout model (and saved to
 * disk). Apart from `kind`, its fields belong to the plugin that owns the
 * kind, which validates them on restore. Built-in plugins type their own
 * fields (e.g. `TerminalData` in `src/plugins/builtin/terminal.tsx`).
 */
export type PaneData = {
  kind: PaneKind;
  /**
   * The file a pane shows, by convention for plugins that open files
   * (`fileHandler`): renames on disk and "open file" look at it.
   */
  path?: string;
  [field: string]: unknown;
};

export type PaneNode = TabNode<PaneData>;
export type Layout = WorkspaceModel<PaneData>;
export type LayoutNodeInput = WorkspaceNodeInput<PaneData>;

export type Tab = {
  id: string;
  title: string;
  /**
   * The user named this tab. Otherwise `title` follows the active pane
   * (its foreground program, or its directory).
   */
  titleLocked?: boolean;
  layout: Layout;
  /**
   * Bumped when the layout is changed from outside the mounted layout
   * component, which is uncontrolled and has to be remounted to pick it up.
   */
  layoutRev: number;
  /** A pane produced output while this tab was in the background. */
  activity: boolean;
  /** The pane that last had keyboard focus; restored when the tab is shown. */
  activePaneId?: string;
};

export type Workspace = {
  id: string;
  name: string;
  /**
   * Icon shown in the workspace badge: a name from `WORKSPACE_ICONS`
   * (`src/workspaces/icons.ts`). Unset shows the name's first letter.
   */
  icon?: string;
  tabs: Tab[];
  activeTabId: string;
};
