import { isWithin } from "../explorer/tree";
import { viewerModeFor } from "../files/kinds";
import { getSettings, useSettings } from "../settings/settings";
import { monoFontStack } from "../settings/schema";
import { selectAllPanes, useAppStore } from "../state/store";
import { ViewerModel } from "../viewer/model";
import { EditorModel } from "./model";

/*
 * Registry of the models behind editor and viewer panes, keyed by pane id.
 * Same lifetime rule as terminal sessions and explorers: a model is
 * disposed once no pane of its kind showing its file is left in the store
 * and it is off screen. So an editor in a background tab keeps its unsaved
 * changes, and only closing the pane (which asks first, see closing.ts)
 * discards them.
 *
 * Editors get an EditorModel; viewers get a ViewerModel for Markdown and
 * images, and a read-only EditorModel for other text.
 */

export type FileModel = EditorModel | ViewerModel;
type FileKind = "editor" | "viewer";
/** Which model a pane needs; a change means a new model. */
type Shape = "editor" | "readOnly" | "markdown" | "image";

/** `holds`: mounted components using the model (it is never disposed while held). */
type Entry = { model: FileModel; kind: FileKind; shape: Shape; holds: number };

const entries = new Map<string, Entry>();
/** Lines to show once a pane's file is open (from `revealInPane`). */
const pendingReveals = new Map<string, { path: string; line: number; column?: number }>();

function shapeFor(kind: FileKind, path: string): Shape {
  if (kind === "editor") return "editor";
  const mode = viewerModeFor(path);
  return mode === "text" ? "readOnly" : mode;
}

function create(paneId: string, path: string, shape: Shape): FileModel {
  if (shape === "markdown" || shape === "image") return new ViewerModel(paneId, path, shape);
  const model = new EditorModel(paneId, path, shape === "readOnly");
  const { fontFamily, fontSize } = getSettings();
  model.setFont(monoFontStack(fontFamily), fontSize);
  return model;
}

/**
 * The model for a pane showing `path`, created if needed, for a mounted
 * component (which attaches it, and calls `releaseFileModel` when done).
 */
export function acquireFileModel(paneId: string, kind: FileKind, path: string): FileModel {
  const shape = shapeFor(kind, path);
  let entry = entries.get(paneId);
  if (entry && (entry.shape !== shape || entry.model.path !== path)) {
    // The pane's kind or file changed (the old component released it).
    entries.delete(paneId);
    entry.model.dispose();
    entry = undefined;
  }
  if (!entry) {
    entry = { model: create(paneId, path, shape), kind, shape, holds: 0 };
    entries.set(paneId, entry);
  }
  entry.holds++;
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
  if (entry?.model === model) entry.holds = Math.max(0, entry.holds - 1);
  scheduleReconcile();
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
  for (const { model } of entries.values()) {
    if (isWithin(model.path, from)) model.setPath(to + model.path.slice(from.length));
  }
}

function reconcile(): void {
  const live = new Map<string, { kind: string; path?: string }>();
  for (const pane of selectAllPanes(useAppStore.getState())) live.set(pane.id, pane.data);
  for (const [paneId, entry] of entries) {
    const pane = live.get(paneId);
    const current = pane && pane.kind === entry.kind && pane.path === entry.model.path;
    if (current || entry.holds > 0) continue;
    entries.delete(paneId);
    entry.model.dispose();
  }
  for (const paneId of pendingReveals.keys()) if (!live.has(paneId)) pendingReveals.delete(paneId);
}

let reconcileTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleReconcile(): void {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(reconcile, 0);
}

useAppStore.subscribe(scheduleReconcile);

let lastFont = { family: getSettings().fontFamily, size: getSettings().fontSize };
useSettings.subscribe(({ fontFamily, fontSize }) => {
  if (fontFamily === lastFont.family && fontSize === lastFont.size) return;
  lastFont = { family: fontFamily, size: fontSize };
  for (const { model } of entries.values()) {
    if (model instanceof EditorModel) model.setFont(monoFontStack(fontFamily), fontSize);
  }
});
