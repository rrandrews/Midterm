import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, FilePlus, FolderPlus, Link2, Pin } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { openFile, renameOpenFiles } from "../../actions";
import { registerPaneActions } from "../../commands/registry";
import { focusPane, registerPaneFocuser } from "../../layout/dock";
import type { GitCode } from "../../ipc/fs";
import { homeDirectory } from "../../ipc/system";
import { fileClipboard, subscribeFileClipboard } from "../../explorer/clipboard";
import { dropDir, explorerDrag, subscribeExplorerDrag } from "../../explorer/drag";
import { acquireExplorer, releaseExplorer } from "../../explorer/explorers";
import type { ExplorerModel, ExplorerSnapshot } from "../../explorer/model";
import { type Row, baseName, displayPath, findByPrefix, parentPath, rowId } from "../../explorer/tree";
import { InlineEdit } from "../ui/InlineEdit";
import { PaneMenuItems } from "../layout/PaneMenuItems";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../ui/Menu";
import { MenuItems } from "../../plugins/MenuItems";
import { usePluginSettings } from "../../plugins/settings";
import { EntryMenuItems, confirmTrash, copyEntries, copyPaths, explorerMenu, pasteInto } from "./ExplorerMenus";
import { ExplorerSearch, type ExplorerSearchMode } from "./ExplorerSearch";
import { useExplorerDrag } from "./useExplorerDrag";
import { FileIcon, drawsIcons } from "../../icons/FileIcon";
import { useActiveIconSet } from "../../icons/state";
import type { LoadedIconSet } from "../../icons/types";

const ROW_HEIGHT = 24;
/** Indent per level, and the left padding of the top level (from the mockup). */
const INDENT = 14;
const PAD_LEFT = 12;
/** Type-ahead forgets what was typed after this long. */
const TYPEAHEAD_MS = 800;

const BADGE_COLOR: Record<GitCode, string> = {
  M: "text-warn",
  A: "text-ok",
  U: "text-ok",
  R: "text-info",
  D: "text-err",
  C: "text-err",
};

const BADGE_TITLE: Record<GitCode, string> = {
  M: "Modified",
  A: "Added",
  U: "Untracked",
  R: "Renamed",
  D: "Deleted",
  C: "Conflicted",
};

/**
 * The file explorer: a live tree of the root directory. State lives in an
 * `ExplorerModel` (src/explorer/), which this component attaches to.
 */
export function ExplorerPane({ paneId }: { paneId: string }) {
  const [model, setModel] = useState<ExplorerModel | null>(null);

  useEffect(() => {
    const acquired = acquireExplorer(paneId);
    acquired.attach();
    setModel(acquired);
    return () => releaseExplorer(acquired);
  }, [paneId]);

  return model ? <ExplorerView paneId={paneId} model={model} /> : null;
}

function ExplorerView({ paneId, model }: { paneId: string; model: ExplorerModel }) {
  const icons = useActiveIconSet();
  const striped = usePluginSettings("explorer").striped === true;
  const snap = useSyncExternalStore(model.subscribe, model.snapshot);
  const clipboard = useSyncExternalStore(subscribeFileClipboard, fileClipboard);
  const drag = useSyncExternalStore(subscribeExplorerDrag, explorerDrag);
  const treeRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  /** Path the context menu is for; `null` for the empty area. */
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [search, setSearch] = useState<ExplorerSearchMode | null>(null);

  const virtualizer = useVirtualizer({
    count: snap.rows.length,
    getScrollElement: () => treeRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(
    () => registerPaneFocuser(paneId, () => treeRef.current?.focus({ preventScroll: true })),
    [paneId],
  );

  // ⌘F finds files and folders by name, ⌃⌘F searches inside files (`explorer.searchText`).
  useEffect(
    () => registerPaneActions(paneId, { find: () => setSearch("name"), searchText: () => setSearch("text") }),
    [paneId],
  );

  const closeSearch = () => {
    setSearch(null);
    focusPane(paneId);
  };

  const rows = snap.rows;
  const selectedIndex = rows.findIndex((row) => rowId(row) === snap.selected);
  const cut = new Set(clipboard?.cut ? clipboard.paths : []);
  const dropInto = dropDir(drag);

  /** The paths a command acts on, starting from `path`: the selection if `path` is in it. */
  const pathsFor = (path: string) => (snap.selection.has(path) ? model.selectedPaths() : [path]);
  const { onRowPointerDown, consumeClick } = useExplorerDrag({ model, pathsFor });

  const selectIndex = (index: number, extend = false) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (row?.type !== "entry") return;
    if (extend) model.selectRange(row.entry.path);
    else model.select(row.entry.path);
    virtualizer.scrollToIndex(rows.indexOf(row), { align: "auto" });
  };

  const open = (path: string, newPane = false) => openFile(path, { fromPaneId: paneId, newPane });

  const activate = (row: Row, newPane = false) => {
    if (row.type !== "entry") return;
    if (row.entry.kind === "dir") model.toggle(row.entry.path);
    else open(row.entry.path, newPane);
  };

  /** A revealed path to scroll to once its row is shown (its folders may still be loading). */
  const pendingReveal = useRef<string | null>(null);
  const reveal = (path: string) => {
    setSearch(null);
    pendingReveal.current = path;
    model.reveal(path);
    focusPane(paneId);
  };
  useEffect(() => {
    const path = pendingReveal.current;
    if (!path) return;
    const index = snap.rows.findIndex((row) => rowId(row) === path);
    if (index === -1) return;
    pendingReveal.current = null;
    virtualizer.scrollToIndex(index, { align: "center" });
  }, [snap.rows, virtualizer]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (snap.editing) return;
    const row = rows[selectedIndex];
    const page = Math.max(1, Math.floor((treeRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const key = event.key.toLowerCase();
    const cmdOnly = event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (event.metaKey && event.key === "Backspace") {
      handled();
      void confirmTrash(model, model.selectedPaths());
      return;
    }
    // Finder's keys: ⌘O (or ⌘↓) opens, ↩ renames.
    if (event.metaKey && !event.ctrlKey && !event.altKey && (key === "o" || event.key === "ArrowDown")) {
      handled();
      if (row) activate(row, event.shiftKey);
      return;
    }
    if (cmdOnly && key === "a") {
      handled();
      model.selectAll();
      return;
    }
    if (cmdOnly && (key === "c" || key === "x")) {
      handled();
      copyEntries(model.selectedPaths(), key === "x");
      return;
    }
    if (cmdOnly && key === "v") {
      handled();
      void pasteInto(model, model.targetDir());
      return;
    }
    // ⌥⌘C: Finder's "Copy as pathname". Matched on the physical key: ⌥ changes `key`.
    if (event.metaKey && event.altKey && !event.ctrlKey && event.code === "KeyC") {
      handled();
      copyPaths(model.selectedPaths());
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const extend = event.shiftKey;
    switch (event.key) {
      case "ArrowDown":
        handled();
        selectIndex(selectedIndex === -1 ? 0 : nextEntry(rows, selectedIndex, 1), extend);
        return;
      case "ArrowUp":
        handled();
        selectIndex(selectedIndex === -1 ? 0 : nextEntry(rows, selectedIndex, -1), extend);
        return;
      case "PageDown":
        handled();
        selectIndex(nextEntry(rows, Math.min(rows.length - 1, selectedIndex + page), -1, true), extend);
        return;
      case "PageUp":
        handled();
        selectIndex(nextEntry(rows, Math.max(0, selectedIndex - page), 1, true), extend);
        return;
      case "Home":
        handled();
        selectIndex(nextEntry(rows, 0, 1, true), extend);
        return;
      case "End":
        handled();
        selectIndex(nextEntry(rows, rows.length - 1, -1, true), extend);
        return;
      case "ArrowRight":
        handled();
        if (row?.type !== "entry" || row.entry.kind !== "dir") return;
        if (!row.expanded) model.expand(row.entry.path);
        else selectIndex(nextEntry(rows, selectedIndex, 1));
        return;
      case "ArrowLeft": {
        handled();
        if (row?.type !== "entry") return;
        if (row.expanded) {
          model.collapse(row.entry.path);
          return;
        }
        const parent = parentPath(row.entry.path);
        const parentIndex = rows.findIndex((candidate) => rowId(candidate) === parent);
        if (parentIndex !== -1) selectIndex(parentIndex);
        return;
      }
      case "Enter":
      case "F2":
        handled();
        if (row?.type === "entry") model.startRename(row.entry.path);
        return;
      case "Escape":
        typeahead.current.text = "";
        // Several selected: back to just the cursor.
        if (snap.selection.size > 1) {
          handled();
          model.select(snap.selected);
        }
        return;
    }
    // Type-ahead: printable characters select the next matching name.
    if (event.key.length === 1 && event.key !== " " && !event.shiftKey) {
      handled();
      const now = performance.now();
      const state = typeahead.current;
      state.text = now - state.at > TYPEAHEAD_MS ? event.key : state.text + event.key;
      state.at = now;
      const repeated = state.text.length > 1 && [...state.text].every((char) => char === state.text[0]);
      const found = findByPrefix(rows, selectedIndex, state.text, repeated);
      if (found !== -1) selectIndex(found);
    }
  };

  const onContextMenu = (event: MouseEvent) => {
    const path = (event.target as HTMLElement).closest<HTMLElement>("[data-path]")?.dataset.path ?? null;
    setMenuPath(path);
    // Right-clicking outside the selection selects just that entry; inside, the menu is for all of it.
    if (path && !snap.selection.has(path)) model.select(path);
  };

  const onRowClick = (event: MouseEvent, row: Row) => {
    if (consumeClick() || row.type !== "entry") return;
    const { path, kind } = row.entry;
    if (event.shiftKey) model.selectRange(path, event.metaKey);
    else if (event.metaKey) model.toggleSelected(path);
    else {
      model.select(path);
      if (kind === "dir" && event.detail === 1) model.toggle(path);
    }
  };

  const menuRow = menuPath ? rows.find((row) => rowId(row) === menuPath) : undefined;
  const createIn = (kind: "file" | "dir") => model.startCreate(model.targetDir(), kind);

  return (
    <div className="explorer relative flex h-full flex-col">
      <RootHeader snap={snap} dropping={dropInto === snap.root} onCreate={createIn} onClick={() => model.select(null)} />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={treeRef}
            role="tree"
            aria-label="Files"
            aria-multiselectable="true"
            aria-activedescendant={selectedIndex === -1 ? undefined : rowDomId(paneId, snap.selected)}
            tabIndex={0}
            data-drop-dir={snap.root}
            className={`explorer-tree relative min-h-0 flex-1 overflow-y-auto outline-none select-none ${
              dropInto === snap.root ? "is-drop-target" : ""
            }`}
            onKeyDown={onKeyDown}
            onContextMenu={onContextMenu}
            onClick={(event) => {
              // A click on the empty space below the rows clears the selection.
              if (event.target === event.currentTarget || !(event.target as HTMLElement).closest("[data-path]")) {
                if (!consumeClick()) model.select(null);
              }
            }}
          >
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                const id = rowId(row);
                return (
                  <TreeRow
                    key={id}
                    paneId={paneId}
                    model={model}
                    snap={snap}
                    row={row}
                    icons={icons}
                    top={item.start}
                    stripe={striped && item.index % 2 === 1}
                    cut={cut.has(id)}
                    dropping={dropInto === id}
                    onClick={(event) => onRowClick(event, row)}
                    onPointerDown={(event) => onRowPointerDown(event, id)}
                    onActivate={(newPane) => activate(row, newPane)}
                  />
                );
              })}
            </div>
            {rows.length === 0 && snap.rootLoaded && (
              <div className="absolute inset-x-0 top-0 px-3 py-1 text-meta text-fg-dim">Empty folder</div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label="Files">
          {menuRow?.type === "entry" ? (
            <EntryMenuItems
              paneId={paneId}
              model={model}
              entry={menuRow.entry}
              paths={pathsFor(menuRow.entry.path)}
              root={snap.root}
              onOpen={(newPane) => open(menuRow.entry.path, newPane)}
            />
          ) : (
            <>
              <MenuItems items={explorerMenu(model)} />
              <PaneMenuItems paneId={paneId} />
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {snap.error && (
        <div role="status" className="border-t border-line px-3 py-1.5 text-meta text-err">
          {snap.error}
        </div>
      )}
      {search && (
        <ExplorerSearch
          paneId={paneId}
          mode={search}
          root={snap.root}
          showHidden={snap.showHidden}
          onClose={closeSearch}
          onReveal={reveal}
        />
      )}
      {drag?.source === paneId && (
        <DragImage paths={drag.paths} x={drag.x} y={drag.y} copy={drag.copy && drag.target?.type === "dir"} />
      )}
    </div>
  );
}

/** Index of the next entry row from `from` in `step` direction (`from` itself if `inclusive`). */
function nextEntry(rows: Row[], from: number, step: 1 | -1, inclusive = false): number {
  for (let index = inclusive ? from : from + step; index >= 0 && index < rows.length; index += step) {
    if (rows[index].type === "entry") return index;
  }
  return from;
}

function rowDomId(paneId: string, path: string | null): string {
  return `explorer-${paneId}-${encodeURIComponent(path ?? "")}`;
}

/** The root's name as the top folder shows it: `~` for home, `/` for the file system root. */
function rootName(root: string): string {
  if (root === "/") return "/";
  if (root === homeDirectory()) return "~";
  return baseName(root);
}

type RootHeaderProps = {
  snap: ExplorerSnapshot;
  /** Entries dragged over it would drop into the root. */
  dropping: boolean;
  onCreate: (kind: "file" | "dir") => void;
  onClick: () => void;
};

/**
 * The top folder: the root, a little larger than the rows, which sit
 * under it without an indent. New file and new folder buttons show while
 * the explorer has focus.
 */
function RootHeader({ snap, dropping, onCreate, onClick }: RootHeaderProps) {
  const icons = useActiveIconSet();
  const name = rootName(snap.root);
  const full = displayPath(snap.root, homeDirectory());
  const keepFocus = (event: PointerEvent) => event.preventDefault();
  return (
    // Right padding leaves room for the pane's hover controls.
    <div
      className={`explorer-root flex h-[30px] flex-none items-center gap-1.5 pt-0.5 pr-14 pl-3 ${dropping ? "is-drop-target" : ""}`}
      title={full}
      data-drop-dir={snap.root}
      onClick={onClick}
    >
      <FileIcon set={icons.set} light={icons.light} name={name} path={snap.root} kind="dir" expanded />
      <span className="min-w-0 truncate text-input font-semibold text-fg-bright">{name}</span>
      {snap.pinned && <Pin size={10} strokeWidth={2} className="flex-none text-fg-dim" aria-label="Pinned" />}
      {snap.link && <Link2 size={11} strokeWidth={2} className="flex-none text-fg-dim" aria-label="Linked to a terminal" />}
      <span className="explorer-root-actions ml-auto flex flex-none items-center gap-0.5">
        <button
          type="button"
          aria-label="New file"
          title="New file"
          className="explorer-root-button"
          onPointerDown={keepFocus}
          onClick={(event) => {
            event.stopPropagation();
            onCreate("file");
          }}
        >
          <FilePlus size={13} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="New folder"
          title="New folder"
          className="explorer-root-button"
          onPointerDown={keepFocus}
          onClick={(event) => {
            event.stopPropagation();
            onCreate("dir");
          }}
        >
          <FolderPlus size={13} strokeWidth={1.75} />
        </button>
      </span>
    </div>
  );
}

/** What follows the pointer while entries are dragged. */
function DragImage({ paths, x, y, copy }: { paths: string[]; x: number; y: number; copy: boolean }) {
  return createPortal(
    <div className="explorer-drag-image" style={{ left: x + 12, top: y + 10 }}>
      {copy && <span className="explorer-drag-copy">+</span>}
      {paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`}
    </div>,
    document.body,
  );
}

type TreeRowProps = {
  paneId: string;
  model: ExplorerModel;
  snap: ExplorerSnapshot;
  row: Row;
  icons: { set: LoadedIconSet | null; light: boolean };
  top: number;
  /** Shaded, for striped rows. */
  stripe: boolean;
  /** On the clipboard after ⌘X. */
  cut: boolean;
  /** Dragged entries would drop into this folder. */
  dropping: boolean;
  onClick: (event: MouseEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
  onActivate: (newPane: boolean) => void;
};

/** Width the icon and its gap take, when the set draws icons. */
const ICON_SPACE = 16 + 6;

function TreeRow({ paneId, model, snap, row, icons, top, stripe, cut, dropping, onClick, onPointerDown, onActivate }: TreeRowProps) {
  const indent = PAD_LEFT + row.depth * INDENT;
  const style = { top, height: ROW_HEIGHT, paddingLeft: indent };
  const base = `absolute inset-x-0 flex items-center gap-1.5 pr-3 whitespace-nowrap ${stripe ? "is-stripe" : ""}`;
  const finishEditing = () => {
    model.cancelEdit();
    focusPane(paneId);
  };

  if (row.type === "status") {
    return (
      <div className={`${base} text-meta text-fg-dim`} style={{ ...style, paddingLeft: indent + 16 + (drawsIcons(icons.set) ? ICON_SPACE : 0) }}>
        <span className="truncate">{row.text}</span>
      </div>
    );
  }

  if (row.type === "create") {
    return (
      <div className={base} style={style}>
        <Chevron dir={row.kind === "dir"} expanded={false} />
        <FileIcon set={icons.set} light={icons.light} name="" kind={row.kind} />
        <InlineEdit
          label={row.kind === "dir" ? "New folder name" : "New file name"}
          value=""
          onCommit={(name) =>
            void model.commitCreate(name).then((created) => {
              if (created?.kind === "file") openFile(created.path, { fromPaneId: paneId });
            })
          }
          onDone={finishEditing}
        />
      </div>
    );
  }

  const { entry, expanded } = row;
  const selected = snap.selection.has(entry.path);
  const cursor = snap.selected === entry.path;
  const renaming = snap.editing?.type === "rename" && snap.editing.path === entry.path;
  const badge = snap.badges.get(entry.path);
  const dim = entry.ignored || entry.hidden;

  return (
    <div
      id={rowDomId(paneId, entry.path)}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={entry.kind === "dir" ? expanded : undefined}
      aria-selected={selected}
      data-path={entry.path}
      data-drop-dir={entry.kind === "dir" ? entry.path : parentPath(entry.path)}
      title={entry.symlink ? `${entry.name} (symbolic link)` : undefined}
      className={`${base} explorer-row cursor-default text-ui ${
        selected ? "is-selected text-fg-bright" : dim ? "text-fg-faint" : "text-fg-mid"
      } ${cursor ? "is-cursor" : ""} ${dim ? "is-dim" : ""} ${cut ? "is-cut" : ""} ${dropping ? "is-drop-target" : ""}`}
      style={style}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onDoubleClick={(event) => {
        if (entry.kind === "file" && !event.metaKey && !event.shiftKey) onActivate(false);
      }}
      onAuxClick={(event) => {
        // Middle click opens in a new pane.
        if (event.button === 1 && entry.kind === "file") onActivate(true);
      }}
    >
      <Chevron dir={entry.kind === "dir"} expanded={expanded} />
      <FileIcon
        set={icons.set}
        light={icons.light}
        name={entry.name}
        path={entry.path}
        kind={entry.kind}
        expanded={expanded}
      />
      {renaming ? (
        <InlineEdit
          label={`Rename ${entry.name}`}
          value={entry.name}
          onCommit={(name) =>
            void model.commitRename(name).then((renamed) => {
              if (renamed) renameOpenFiles(renamed.from, renamed.to);
            })
          }
          onDone={finishEditing}
        />
      ) : (
        <span className={`min-w-0 truncate ${entry.symlink ? "italic" : ""}`}>{entry.name}</span>
      )}
      {badge && !renaming && (
        <span
          className={`ml-auto flex-none text-meta ${BADGE_COLOR[badge]} ${entry.kind === "dir" ? "opacity-70" : ""}`}
          title={entry.kind === "dir" ? `Contains ${BADGE_TITLE[badge].toLowerCase()} files` : BADGE_TITLE[badge]}
        >
          {entry.kind === "dir" ? "•" : badge}
        </span>
      )}
    </div>
  );
}

function Chevron({ dir, expanded }: { dir: boolean; expanded: boolean }) {
  if (!dir) return <span className="w-2.5 flex-none" aria-hidden="true" />;
  const Icon = expanded ? ChevronDown : ChevronRight;
  return <Icon size={10} strokeWidth={2.25} className="flex-none text-fg-dim" aria-hidden="true" />;
}
