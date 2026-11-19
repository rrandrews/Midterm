import { EditorPane, ViewerPane } from "../../components/panes/FilePane";
import { fileMenu } from "../../editor/menu";
import { hasUnsavedChanges, peekEditor, revealInPane, unsavedFiles } from "../../editor/registry";
import { EDITOR_FIELDS, VIEWER_FIELDS } from "../../editor/settings";
import { baseName } from "../../explorer/tree";
import { isImagePath } from "../../files/kinds";
import { activePaneId } from "../../actions";
import type { PaneData, PaneNode } from "../../state/types";
import type { PanePlugin, PaneProps, PaneSpec } from "../types";
import { validateFileData } from "./data";
import { editorSkills, viewerSkills } from "./fileSkills";

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/** What editor and viewer panes have in common: a `path`, kept when changing between the two. */
const filePane: Pick<PaneSpec, "validateData" | "convertData" | "directory" | "menu"> = {
  validateData: validateFileData,
  convertData: (previous: PaneData) => (previous.path ? { path: previous.path } : {}),
  directory: (pane: PaneNode) => (pane.data.path ? parentOf(pane.data.path) : undefined),
  menu: (ctx) => fileMenu(ctx.paneId, ctx.data().path),
};

function Editor({ paneId, data }: PaneProps) {
  return <EditorPane paneId={paneId} path={data.path} />;
}

function Viewer({ paneId, data }: PaneProps) {
  return <ViewerPane paneId={paneId} path={data.path} />;
}

/** The active pane's editor, if it is an editable one showing its file. */
function activeEditor() {
  const editor = peekEditor(activePaneId() ?? "");
  return editor && !editor.readOnly && editor.snapshot().status === "ready" ? editor : undefined;
}

/** Editor panes: files in CodeMirror. Text opens here by default. */
export const editorPlugin: PanePlugin = {
  id: "editor",
  name: "Editor",
  description: "Edits text files, with syntax highlighting, find and go to line.",
  icon: "file-code",
  pane: {
    ...filePane,
    component: Editor,
    isDirty: hasUnsavedChanges,
    closeBlockers: async (paneId) => unsavedFiles([paneId]).map((path) => ({ type: "unsaved", name: baseName(path) })),
    fileHandler: (path) => (isImagePath(path) ? false : "default"),
    reveal: revealInPane,
    background: "var(--pane-editor)",
  },
  commands: [
    {
      id: "editor.revert",
      title: "Revert file",
      category: "Editor",
      run: () => activeEditor()?.revert(),
      enabled: () => activeEditor()?.isDirty ?? false,
    },
  ],
  settings: { fields: EDITOR_FIELDS },
  skills: editorSkills,
};

/** Viewer panes: rendered Markdown, images, read-only text. Images open here. */
export const viewerPlugin: PanePlugin = {
  id: "viewer",
  name: "Viewer",
  description: "Shows rendered Markdown, images and read-only text.",
  icon: "eye",
  pane: {
    ...filePane,
    component: Viewer,
    fileHandler: (path) => (isImagePath(path) ? "default" : "option"),
    background: "var(--pane-viewer)",
  },
  settings: { fields: VIEWER_FIELDS },
  skills: viewerSkills,
};
