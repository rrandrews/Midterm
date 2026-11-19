import { updatePaneData } from "../../actions";
import type { PanePlugin, PaneProps } from "../../plugins/types";
import { isDraftDirty, stopEditing, useThemeDraft } from "./draft";
import { ThemeEditorPane } from "./ThemeEditorPane";
import { currentTheme } from "../state";
import { selectAllPanes, useAppStore } from "../../state/store";

function Editor({ paneId, data }: PaneProps) {
  const themeId = typeof data.themeId === "string" ? data.themeId : currentTheme().id;
  const retarget = (id: string) => updatePaneData(paneId, { themeId: id });
  return <ThemeEditorPane paneId={paneId} themeId={themeId} onPick={retarget} onSaved={retarget} />;
}

/** The theme editor, as a pane so edits preview on the real panes around it. */
export const themeEditorPlugin: PanePlugin = {
  id: "theme-editor",
  name: "Theme editor",
  description: "Edit a theme’s colors with a live preview.",
  icon: "palette",
  pane: {
    component: Editor,
    validateData: (raw) => (typeof raw.themeId === "string" && raw.themeId ? { themeId: raw.themeId } : {}),
    createData: () => ({ themeId: currentTheme().id }),
    closeBlockers: async (paneId) =>
      useThemeDraft.getState().ownerPaneId === paneId && isDraftDirty() ? [{ type: "other", name: "The theme has unsaved changes" }] : [],
    tabTitle: () => "theme",
    splittable: false,
    menu: () => [],
  },
};

// The draft ends with the last theme editor pane.
useAppStore.subscribe(() => {
  if (!useThemeDraft.getState().sourceId) return;
  queueMicrotask(() => {
    const open = selectAllPanes(useAppStore.getState()).some((pane) => pane.data.kind === "theme-editor");
    if (!open) stopEditing();
  });
});
