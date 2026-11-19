import { isWithin } from "../explorer/tree";
import { viewerModeFor } from "../files/kinds";
import { getSettings, useSettings } from "../settings/settings";
import { monoFontStack } from "../settings/schema";
import { createPaneState } from "../plugins/paneState";
import { selectAllPanes, useAppStore } from "../state/store";
import { editorOptions, markdownMode } from "./settings";
import { ViewerModel } from "../viewer/model";
import { EditorModel } from "./model";

/*
 * The models behind editor and viewer panes, keyed by pane id (a shared
 * pane state, see src/plugins/paneState.ts): a model is disposed once no
 * pane of its kind showing its file is left in the store and nothing shows
 * it. So an editor in a background tab keeps its unsaved changes, and only
 * closing the pane (which asks first, see closing.ts) discards them.
 *
 * Editors get an EditorModel; viewers get a ViewerModel for Markdown and
 * images, and a read-only EditorModel for other text.
 */

export type FileModel = EditorModel | ViewerModel;
type FileKind = "editor" | "viewer";
/** Which model a pane needs; a change means a new model. */
type Shape = "editor" | "readOnly" | "markdown" | "image";

type Entry = { model: FileModel; kind: FileKind; shape: Shape };

const entries = createPaneState<Entry>({
  isLive: (pane, entry) => pane.data.kind === entry.kind && pane.data.path === entry.model.path,
  dispose: (entry, paneId) => {
    entry.model.dispose();
    if (!livePaneIds().has(paneId)) pendingReveals.delete(paneId);
  },
});
/** Lines to show once a pane's file is open (from `revealInPane`). */
const pendingReveals = new Map<string, { path: string; line: number; column?: number }>();

function livePaneIds(): Set<string> {
  return new Set(selectAllPanes(useAppStore.getState()).map((pane) => pane.id));
}

function shapeFor(kind: FileKind, path: string): Shape {
  if (kind === "editor") return "editor";
  const mode = viewerModeFor(path);
  if (mode === "markdown" && markdownMode() === "source") return "readOnly";
  return mode === "text" ? "readOnly" : mode;
}

function create(paneId: string, path: string, shape: Shape): FileModel {
  if (shape === "markdown" || shape === "image") return new ViewerModel(paneId, path, shape);
  const model = new EditorModel(paneId, path, shape === "readOnly");
  const { fontFamily, fontSize } = getSettings();
  model.setFont(monoFontStack(fontFamily), fontSize);
  model.setOptions(editorOptions());
  return model;
}

/**
 * The model for a pane showing `path`, created if needed, for a mounted
 * component (which attaches it, and calls `releaseFileModel` when done).
 */
export function acquireFileModel(paneId: string, kind: FileKind, path: string): FileModel {
  const shape = shapeFor(kind, path);
  // A new kind or file means a new model (the old component released it).
  const entry = entries.acquire(
    paneId,
    () => ({ model: create(paneId, path, shape), kind, shape }),
    (existing) => existing.shape === shape && existing.model.path === path,
  );
  const reveal = pendingReveals.get(paneId);
  if (reveal?.path === path) {
    pendingReveals.delete(paneId);
    if (entry.model instanceof EditorModel) entry.model.reveal(reveal.line, reveal.column);
  }
  return entry.model;
}

/** A component is done with a model; it is disposed only if its pane is gone. */
export function releaseFileModel(model: FileModel): void {
  const entry = entries.get(model.paneId);
  if (entry?.model === model) entries.release(model.paneId, entry);
}

/** The editor (or read-only text viewer) model of a pane, if it has one. */
export function peekEditor(paneId: string): EditorModel | undefined {
  const model = entries.get(paneId)?.model;
  return model instanceof EditorModel ? model : undefined;
}

export function peekFileModel(paneId: string): FileModel | undefined {
  return entries.get(paneId)?.model;
}

/** Whether the pane is an editor with unsaved changes. */
export function hasUnsavedChanges(paneId: string): boolean {
  return entries.get(paneId)?.model.isDirty ?? false;
}

/** Paths of the files with unsaved changes among these panes. */
export function unsavedFiles(paneIds: string[]): string[] {
  return paneIds.filter(hasUnsavedChanges).map((paneId) => entries.get(paneId)?.model.path ?? "");
}

/**
 * Moves the cursor of a pane's editor to a line once it shows `path`
 * (now, or when the pane is mounted and the file loaded).
 */
export function revealInPane(paneId: string, path: string, line: number, column?: number): void {
  const model = entries.get(paneId)?.model;
  if (model?.path === path && model instanceof EditorModel) model.reveal(line, column);
  else pendingReveals.set(paneId, { path, line, column });
}

/** Keeps models in step with a rename of `from` (a file, or a directory containing files) to `to`. */
export function renameOpenModels(from: string, to: string): void {
  for (const [, { model }] of entries.entries()) {
    if (isWithin(model.path, from)) model.setPath(to + model.path.slice(from.length));
  }
}

let lastFont = { family: getSettings().fontFamily, size: getSettings().fontSize };
useSettings.subscribe(({ fontFamily, fontSize }) => {
  if (fontFamily === lastFont.family && fontSize === lastFont.size) return;
  lastFont = { family: fontFamily, size: fontSize };
  for (const [, { model }] of entries.entries()) {
    if (model instanceof EditorModel) model.setFont(monoFontStack(fontFamily), fontSize);
  }
});

let lastOptions = JSON.stringify(editorOptions());
useSettings.subscribe(() => {
  const options = editorOptions();
  const json = JSON.stringify(options);
  if (json === lastOptions) return;
  lastOptions = json;
  for (const [, { model }] of entries.entries()) {
    if (model instanceof EditorModel) model.setOptions(options);
  }
});
