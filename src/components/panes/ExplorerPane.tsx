import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Pin } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { openFile, renameOpenFiles } from "../../actions";
import { focusPane, registerPaneFocuser } from "../../layout/dock";
import type { GitCode } from "../../ipc/fs";
import { homeDirectory } from "../../ipc/system";
import { acquireExplorer, releaseExplorer } from "../../explorer/explorers";
import type { ExplorerModel, ExplorerSnapshot } from "../../explorer/model";
import { type Row, displayPath, findByPrefix, parentPath, rowId } from "../../explorer/tree";
import { InlineEdit } from "../ui/InlineEdit";
import { PaneMenuItems } from "../layout/PaneMenuItems";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, MenuSeparator } from "../ui/Menu";
import { EntryMenuItems, ExplorerMenuItems, confirmTrash } from "./ExplorerMenus";

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
  const snap = useSyncExternalStore(model.subscribe, model.snapshot);
  const treeRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  /** Path the context menu is for; `null` for the empty area. */
  const [menuPath, setMenuPath] = useState<string | null>(null);

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

  const rows = snap.rows;
  const selectedIndex = rows.findIndex((row) => rowId(row) === snap.selected);

  const selectIndex = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (row?.type !== "entry") return;
    model.select(row.entry.path);
    virtualizer.scrollToIndex(rows.indexOf(row), { align: "auto" });
  };

  const open = (path: string, newPane = false) => openFile(path, { fromPaneId: paneId, newPane });

  const activate = (row: Row, newPane = false) => {
    if (row.type !== "entry") return;
    if (row.entry.kind === "dir") model.toggle(row.entry.path);
    else open(row.entry.path, newPane);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (snap.editing) return;
    const row = rows[selectedIndex];
    const page = Math.max(1, Math.floor((treeRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.metaKey && event.key === "Backspace") {
      handled();
      if (row?.type === "entry") void confirmTrash(model, [row.entry.path]);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case "ArrowDown":
        handled();
        selectIndex(selectedIndex === -1 ? 0 : nextEntry(rows, selectedIndex, 1));
        return;
      case "ArrowUp":
        handled();
        selectIndex(selectedIndex === -1 ? 0 : nextEntry(rows, selectedIndex, -1));
        return;
      case "PageDown":
        handled();
        selectIndex(nextEntry(rows, Math.min(rows.length - 1, selectedIndex + page), -1, true));
        return;
      case "PageUp":
        handled();
        selectIndex(nextEntry(rows, Math.max(0, selectedIndex - page), 1, true));
        return;
      case "Home":
        handled();
        selectIndex(nextEntry(rows, 0, 1, true));
        return;
      case "End":
        handled();
        selectIndex(nextEntry(rows, rows.length - 1, -1, true));
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
        handled();
        if (row) activate(row);
        return;
      case "F2":
        handled();
        if (row?.type === "entry") model.startRename(row.entry.path);
        return;
      case "Escape":
        typeahead.current.text = "";
        return;
    }
    // Type-ahead: printable characters select the next matching name.
    if (event.key.length === 1 && event.key !== " ") {
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
    if (path) model.select(path);
  };

  const menuRow = menuPath ? rows.find((row) => rowId(row) === menuPath) : undefined;

  return (
    <div className="flex h-full flex-col">
      <Header snap={snap} />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={treeRef}
            role="tree"
            aria-label="Files"
            aria-activedescendant={selectedIndex === -1 ? undefined : rowDomId(paneId, snap.selected)}
            tabIndex={0}
            className="explorer-tree relative min-h-0 flex-1 overflow-y-auto outline-none"
            onKeyDown={onKeyDown}
            onContextMenu={onContextMenu}
          >
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                return (
                  <TreeRow
                    key={rowId(row)}
                    paneId={paneId}
                    model={model}
                    snap={snap}
                    row={row}
                    top={item.start}
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
              root={snap.root}
              onOpen={(newPane) => open(menuRow.entry.path, newPane)}
            />
          ) : (
            <>
              <ExplorerMenuItems model={model} />
              <MenuSeparator />
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

function Header({ snap }: { snap: ExplorerSnapshot }) {
  const shown = displayPath(snap.root, homeDirectory());
  return (
    // Right padding leaves room for the pane's hover controls.
    <div className="flex h-[30px] flex-none items-center gap-1.5 pt-1 pr-14 pl-3" title={snap.root}>
      {/* Truncates from the left, so the end of a long path stays visible. */}
      <span className="min-w-0 truncate font-mono text-meta text-fg-dim [direction:rtl]">
        <bdi>{shown}</bdi>
      </span>
      {snap.pinned && (
        <Pin size={10} strokeWidth={2} className="flex-none text-fg-dim" aria-label="Pinned" />
      )}
    </div>
  );
}

type TreeRowProps = {
  paneId: string;
  model: ExplorerModel;
  snap: ExplorerSnapshot;
  row: Row;
  top: number;
  onActivate: (newPane: boolean) => void;
};

function TreeRow({ paneId, model, snap, row, top, onActivate }: TreeRowProps) {
  const indent = PAD_LEFT + row.depth * INDENT;
  const style = { top, height: ROW_HEIGHT, paddingLeft: indent };
  const base = "absolute inset-x-0 flex items-center gap-1.5 pr-3 whitespace-nowrap";
  const finishEditing = () => {
    model.cancelEdit();
    focusPane(paneId);
  };

  if (row.type === "status") {
    return (
      <div className={`${base} text-meta text-fg-dim`} style={{ ...style, paddingLeft: indent + 16 }}>
        <span className="truncate">{row.text}</span>
      </div>
    );
  }

  if (row.type === "create") {
    return (
      <div className={base} style={style}>
        <Chevron dir={row.kind === "dir"} expanded={false} />
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
  const selected = snap.selected === entry.path;
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
      title={entry.symlink ? `${entry.name} (symbolic link)` : undefined}
      className={`${base} explorer-row cursor-default text-ui ${
        selected ? "is-selected text-fg-bright" : dim ? "text-fg-faint" : "text-fg-mid"
      }`}
      style={style}
      onClick={(event) => {
        model.select(entry.path);
        if (entry.kind === "dir" && event.detail === 1) model.toggle(entry.path);
      }}
      onDoubleClick={() => {
        if (entry.kind === "file") onActivate(false);
      }}
      onAuxClick={(event) => {
        // Middle click opens in a new pane.
        if (event.button === 1 && entry.kind === "file") onActivate(true);
      }}
    >
      <Chevron dir={entry.kind === "dir"} expanded={expanded} />
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
