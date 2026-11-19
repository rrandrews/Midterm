import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import {
  findNext,
  findPrevious,
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { Compartment, EditorState, type Extension, type StateEffect, type Text } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { confirm } from "../components/ui/ConfirmDialog";
import { baseName, parentPath } from "../explorer/tree";
import { repoRootOf } from "../files/repoRoot";
import { watchFile } from "../files/watch";
import * as fs from "../ipc/fs";
import type { FileVersion } from "../ipc/fs";
import { highlighting } from "./highlight";
import { loadLanguage } from "./languages";
import { type TextFormat, clampPosition, decodeText, detectIndent, encodeText, minimalChange } from "./text";

/*
 * One editor pane's file: a CodeMirror view and everything about the file
 * behind it (disk version, dirty state, external changes). Lives outside
 * React, keyed by pane id (registry.ts), like terminal sessions: the view's
 * element is moved in and out of the pane on mount and unmount, so undo
 * history, selection, scroll position and unsaved changes survive tab
 * switches and re-docks. Also used read-only for text in viewer panes.
 */

export type EditorStatus = "loading" | "ready" | "missing" | "binary" | "tooLarge" | "error";

export type EditorSnapshot = {
  path: string;
  status: EditorStatus;
  /** Why loading or the last save failed. */
  error: string | null;
  /** The buffer differs from what was last loaded or saved. */
  dirty: boolean;
  /**
   * The file changed (or was deleted) on disk while the buffer had unsaved
   * changes, so it was not reloaded. Shown as a notice in the pane.
   */
  external: "changed" | "deleted" | null;
  saving: boolean;
  readOnly: boolean;
  /** Detected language, e.g. "TypeScript". */
  language: string | null;
  /** The repository the file is in, for breadcrumbs. */
  repoRoot: string | null;
  /** Size on disk, for the "too large" and "binary" messages. */
  size: number | null;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Extensions every editor has (the per-file ones are in compartments). */
const BASE_EXTENSIONS: Extension = [
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  highlighting,
  bracketMatching(),
  closeBrackets(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  search({ top: true }),
  // Cmd+F, Cmd+G, Cmd+S and Ctrl+G are app commands (src/commands/core.ts),
  // which reach the editor through its pane actions.
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
  EditorView.theme({}, { dark: true }),
];

export type EditorOptions = { wordWrap: boolean; tabSize: number; lineNumbers: boolean };

function optionExtensions({ wordWrap, tabSize, lineNumbers: numbers }: EditorOptions): Extension {
  return [numbers ? lineNumbers() : [], wordWrap ? EditorView.lineWrapping : [], EditorState.tabSize.of(tabSize)];
}

export class EditorModel {
  readonly kind = "editor";
  private readonly host = document.createElement("div");
  private readonly view: EditorView;
  private readonly language = new Compartment();
  private readonly indent = new Compartment();
  private readonly options = new Compartment();
  private optionValues: EditorOptions = { wordWrap: false, tabSize: 4, lineNumbers: true };
  private languageSupport: Extension = [];
  private languageName: string | null = null;

  private status: EditorStatus = "loading";
  private error: string | null = null;
  /** Disk version the buffer is based on; `null` if there is no file. */
  private version: FileVersion | null = null;
  private size: number | null = null;
  /** The document as last loaded or saved. */
  private savedDoc: Text;
  private format: TextFormat = { bom: false, lineEnding: "\n" };
  private dirty = false;
  private external: "changed" | "deleted" | null = null;
  private saving = false;
  private repoRoot: string | null = null;

  private loadToken = 0;
  private checkToken = 0;
  private unwatch: () => void;
  private attachCount = 0;
  private disposed = false;
  private scrollSnapshot: StateEffect<unknown> | null = null;
  private pendingReveal: { line: number; column?: number } | null = null;

  private readonly listeners = new Set<() => void>();
  private current: EditorSnapshot;

  constructor(
    readonly paneId: string,
    private filePath: string,
    readonly readOnly = false,
  ) {
    this.host.className = "editor-host";
    this.view = new EditorView({ parent: this.host, state: this.createState("") });
    this.savedDoc = this.view.state.doc;
    this.current = this.buildSnapshot();
    this.unwatch = watchFile(filePath, () => void this.checkDisk());
    void this.detectLanguage();
    void this.findRepo();
    void this.load(false);
  }

  /** The buffer's text, with unsaved changes. */
  text(): string {
    return this.view.state.doc.toString();
  }

  get path(): string {
    return this.filePath;
  }

  // --- Subscription (for useSyncExternalStore) ---

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): EditorSnapshot => this.current;

  private emit(): void {
    this.current = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): EditorSnapshot {
    return {
      path: this.filePath,
      status: this.status,
      error: this.error,
      dirty: this.dirty,
      external: this.external,
      saving: this.saving,
      readOnly: this.readOnly,
      language: this.languageName,
      repoRoot: this.repoRoot,
      size: this.size,
    };
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  // --- On screen ---

  /** Shows the editor inside `container`. */
  attach(container: HTMLElement): void {
    if (this.disposed) return;
    container.appendChild(this.host);
    this.attachCount++;
    if (this.scrollSnapshot) this.view.dispatch({ effects: this.scrollSnapshot });
    this.scrollSnapshot = null;
    this.view.requestMeasure();
    this.applyReveal();
    // Catch up on anything missed (a change during a save, say).
    void this.checkDisk();
  }

  /** Takes the editor off screen; everything is kept. */
  detach(): void {
    if (this.attachCount === 0) return;
    this.attachCount--;
    if (this.attachCount > 0) return;
    this.scrollSnapshot = this.view.scrollSnapshot();
    this.host.remove();
  }

  get isAttached(): boolean {
    return this.attachCount > 0;
  }

  focus(): void {
    this.view.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unwatch();
    this.view.destroy();
    this.host.remove();
    this.listeners.clear();
  }

  /** The font from the settings (CSS font stack and px size). */
  setFont(family: string, size: number): void {
    this.host.style.setProperty("--editor-font", family);
    this.host.style.setProperty("--editor-font-size", `${size}px`);
    this.view.requestMeasure();
  }

  /** Options from the editor's settings (word wrap, tab size, line numbers). */
  setOptions(options: EditorOptions): void {
    this.optionValues = options;
    this.view.dispatch({ effects: this.options.reconfigure(optionExtensions(options)) });
  }

  /** The file was renamed or moved: same buffer, new path. */
  setPath(path: string): void {
    if (path === this.filePath) return;
    this.filePath = path;
    this.unwatch();
    this.unwatch = watchFile(path, () => void this.checkDisk());
    this.repoRoot = null;
    void this.detectLanguage();
    void this.findRepo();
    this.emit();
  }

  // --- Commands ---

  find = (): void => void openSearchPanel(this.view);
  findNext = (): void => void findNext(this.view);
  findPrevious = (): void => void findPrevious(this.view);
  goToLine = (): void => void gotoLine(this.view);

  /** Moves the cursor to a 1-based line (and column) and scrolls it into view, once the file is showing. */
  reveal(line: number, column?: number): void {
    this.pendingReveal = { line, column };
    this.applyReveal();
  }

  private applyReveal(): void {
    const target = this.pendingReveal;
    if (!target || this.status !== "ready" || !this.isAttached) return;
    this.pendingReveal = null;
    const doc = this.view.state.doc;
    const { line, column } = clampPosition(doc.lines, (n) => doc.line(n).length, target.line, target.column);
    const at = doc.line(line).from + column - 1;
    this.view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
  }

  /**
   * Writes the buffer to disk. If the file changed on disk since it was
   * loaded, asks before overwriting. Returns whether it was saved.
   */
  save = async (): Promise<boolean> => {
    if (this.readOnly || this.status !== "ready" || this.saving) return false;
    const path = this.filePath;
    const doc = this.view.state.doc;
    const text = encodeText(doc.toString(), this.format);
    // A file known to be gone is created again, but not over one that
    // appeared in the meantime.
    const expect: fs.WriteExpect =
      this.external === "deleted" || !this.version
        ? { kind: "absent" }
        : { kind: "version", version: this.version };
    this.saving = true;
    // A reload still reading the file would bring back what is being replaced.
    this.loadToken++;
    this.emit();
    let saved = false;
    try {
      let result = await fs.writeTextFile(path, text, expect);
      if (result.kind === "conflict") {
        const ok = await confirm({
          title: `“${baseName(path)}” changed on disk`,
          message: !result.current
            ? "Another program deleted it after it was opened here. Save it again?"
            : expect.kind === "absent"
              ? "Another program created it again after it was deleted. Save anyway, replacing that file?"
              : "Another program changed it after it was opened here. Save anyway, replacing those changes?",
          action: result.current ? "Overwrite" : "Save",
        });
        if (!ok) {
          this.external = result.current ? "changed" : "deleted";
          return false;
        }
        result = await fs.writeTextFile(path, text, { kind: "any" });
      }
      if (result.kind === "written" && !this.disposed) {
        this.version = result.version;
        this.size = result.version.size;
        this.savedDoc = doc;
        this.external = null;
        this.error = null;
        saved = true;
      }
    } catch (error) {
      this.error = `Could not save: ${message(error)}`;
    } finally {
      this.saving = false;
      if (!this.disposed) {
        this.updateDirty();
        this.emit();
        // Watcher reports that arrived during the save were skipped.
        void this.checkDisk();
      }
    }
    return saved;
  };

  /** Replaces the buffer with the file on disk (undoable). */
  revert = (): void => {
    void this.load(true);
  };

  /** Keeps the buffer after an external change; the next save overwrites the file without asking. */
  keepMine = async (): Promise<void> => {
    const version = await fs.fileVersion(this.filePath).catch(() => undefined);
    if (version === undefined || this.disposed) return;
    this.version = version;
    this.external = null;
    this.emit();
  };

  dismissError = (): void => {
    if (this.status !== "ready") return;
    this.error = null;
    this.emit();
  };

  // --- Loading ---

  private createState(text: string, indent: string | null = null): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        BASE_EXTENSIONS,
        this.language.of(this.languageSupport),
        this.indent.of(indent ? indentUnit.of(indent) : []),
        this.options.of(optionExtensions(this.optionValues)),
        this.readOnly ? EditorState.readOnly.of(true) : [],
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.updateDirty();
        }),
      ],
    });
  }

  private updateDirty(): void {
    const dirty = !this.readOnly && !this.view.state.doc.eq(this.savedDoc);
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    this.emit();
  }

  /**
   * Reads the file. With `keepView`, a showing buffer is updated in place
   * (smallest change, so the cursor and scroll position stay), else it is
   * replaced along with its undo history.
   */
  private async load(keepView: boolean, { automatic = false } = {}): Promise<void> {
    const token = ++this.loadToken;
    const path = this.filePath;
    const before = this.view.state.doc;
    let file: fs.TextFile;
    try {
      file = await fs.readTextFile(path);
    } catch (error) {
      const version = await fs.fileVersion(path).catch(() => null);
      if (token !== this.loadToken || this.disposed) return;
      if (this.status === "ready") {
        // Keep the buffer: a deleted file can be saved again, and a failed
        // reload should not hide what is there.
        if (version) this.error = `Could not reload: ${message(error)}`;
        else this.external = "deleted";
      } else {
        this.status = version ? "error" : "missing";
        this.error = version ? message(error) : null;
        this.version = null;
      }
      this.emit();
      return;
    }
    if (token !== this.loadToken || this.disposed) return;

    if (file.kind !== "text") {
      this.version = file.version;
      this.size = file.version.size;
      this.status = file.kind;
      this.error = null;
      this.emit();
      return;
    }

    const view = this.view;
    if (automatic && this.status === "ready" && !view.state.doc.eq(before)) {
      // Typed into while the file was being read: keep the edits and say
      // the file changed instead of replacing them.
      this.external = "changed";
      this.emit();
      return;
    }
    this.version = file.version;
    this.size = file.version.size;
    const { text, format } = decodeText(file.text);
    this.format = format;
    if (keepView && this.status === "ready") {
      const change = minimalChange(view.state.doc.toString(), text.replace(/\r\n?/g, "\n"));
      if (change) view.dispatch({ changes: change });
    } else {
      view.setState(this.createState(text, detectIndent(text)));
    }
    this.savedDoc = view.state.doc;
    this.status = "ready";
    this.error = null;
    this.external = null;
    this.updateDirty();
    this.emit();
    this.applyReveal();
  }

  /** Looks at the file on disk after a watcher report: reloads, or notes the change. */
  private async checkDisk(): Promise<void> {
    if (this.disposed || this.saving || this.status === "loading") return;
    const token = ++this.checkToken;
    const path = this.filePath;
    const version = await fs.fileVersion(path).catch(() => undefined);
    if (version === undefined || token !== this.checkToken || this.disposed || this.saving) return;
    if (path !== this.filePath) return;

    if (this.status !== "ready") {
      // Missing, unreadable, binary or too large: try again if anything changed.
      if (!fs.sameVersion(version, this.version)) void this.load(false);
      return;
    }
    if (fs.sameVersion(version, this.version)) {
      if (this.external) {
        this.external = null;
        this.emit();
      }
      return;
    }
    if (version === null) {
      if (this.external !== "deleted") {
        this.external = "deleted";
        this.emit();
      }
      return;
    }
    if (!this.dirty) {
      void this.load(true, { automatic: true });
      return;
    }
    if (this.external !== "changed") {
      this.external = "changed";
      this.emit();
    }
  }

  private async detectLanguage(): Promise<void> {
    const path = this.filePath;
    const language = await loadLanguage(path);
    if (this.disposed || path !== this.filePath) return;
    this.languageSupport = language?.support ?? [];
    this.languageName = language?.name ?? null;
    this.view.dispatch({ effects: this.language.reconfigure(this.languageSupport) });
    this.emit();
  }

  private async findRepo(): Promise<void> {
    const path = this.filePath;
    const root = await repoRootOf(parentPath(path));
    if (this.disposed || path !== this.filePath) return;
    this.repoRoot = root;
    this.emit();
  }
}
