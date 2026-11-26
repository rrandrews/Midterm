import { useVirtualizer } from "@tanstack/react-virtual";
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Search, TextSearch as TextSearchIcon, WholeWord } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { openFile } from "../../actions";
import { type NameIndex, type NameResult, type Range, type TextRow, baseNameOf, countMatches, firstMatchIndex, flattenResults, indexEntries, parentOf, resultsSummary, searchNames, segments, trimPreview } from "../../explorer/search";
import { joinPath } from "../../explorer/tree";
import { FileIcon } from "../../icons/FileIcon";
import { useActiveIconSet } from "../../icons/state";
import type { LoadedIconSet } from "../../icons/types";
import { type TextSearch, type TextSearchFile, findEntries, searchText } from "../../ipc/fs";
import { Tip } from "../ui/Tooltip";

/*
 * Search inside an explorer pane, drawn over it: a bar over the header and,
 * once something is typed, a results panel over the tree. "name" finds
 * files and folders by fuzzy name (the folder is listed once and filtered
 * here); "text" searches inside files (the backend streams results).
 */

export type ExplorerSearchMode = "name" | "text";

const ROW_HEIGHT = 24;
/** Left padding of a row (as the tree's top level). */
const PAD_LEFT = 12;
/** Width of a chevron and its gap, for rows that line up with one. */
const CHEVRON_SPACE = 10 + 6;
const DEBOUNCE_MS = 200;
const MAX_RESULTS = 2000;
const INDEX_LIMIT = 50000;
const INDEX_CACHE_MS = 30_000;

/** What a pane's search remembers, so that reopening shows the last one. */
type Query = { query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean };
type SearchOption = "caseSensitive" | "wholeWord" | "regex";
/** ⌥⌘ + key (by physical key, as ⌥ changes what a key types) toggles an option. */
const TOGGLE_KEYS: Partial<Record<string, SearchOption>> = { KeyC: "caseSensitive", KeyW: "wholeWord", KeyR: "regex" };
const remembered = new Map<string, Query>();
const recall = (paneId: string, mode: ExplorerSearchMode): Query =>
  remembered.get(`${paneId}:${mode}`) ?? { query: "", caseSensitive: false, wholeWord: false, regex: false };

/* Name search: the folder's entries, listed once and kept for a while. */

type Loaded = { index: NameIndex; truncated: boolean };
const indexCache = new Map<string, { at: number; loaded: Promise<Loaded> }>();

function loadIndex(root: string, showHidden: boolean): Promise<Loaded> {
  const key = `${root}\0${showHidden}`;
  const now = Date.now();
  for (const [other, entry] of indexCache) if (now - entry.at >= INDEX_CACHE_MS) indexCache.delete(other);
  const cached = indexCache.get(key);
  if (cached) return cached.loaded;
  const loaded = findEntries(root, { limit: INDEX_LIMIT, showHidden }).then(({ entries, truncated }) => ({
    index: indexEntries(entries),
    truncated,
  }));
  indexCache.set(key, { at: now, loaded });
  // A failure is not worth remembering.
  loaded.catch(() => {
    if (indexCache.get(key)?.loaded === loaded) indexCache.delete(key);
  });
  return loaded;
}

type IndexState = { key: string; loaded?: Loaded; error?: string };

/* Text search: results arrive in batches. */

type TextState = {
  /** The root the results are relative to. */
  root?: string;
  files: TextSearchFile[];
  phase: "idle" | "searching" | "done" | "error";
  truncated: boolean;
  error?: string;
};
const IDLE: TextState = { files: [], phase: "idle", truncated: false };
const NO_FILES: TextSearchFile[] = [];

type Props = {
  paneId: string;
  mode: ExplorerSearchMode;
  /** Absolute; results are relative to it. */
  root: string;
  showHidden: boolean;
  /** Escape: the parent closes the search and refocuses the tree. */
  onClose: () => void;
  /** The parent expands to the (absolute) path in the tree, selects it and closes the search. */
  onReveal: (path: string) => void;
};

/** The search bar and results; the parent places it over the explorer (`absolute inset-0`). */
export function ExplorerSearch({ paneId, mode, root, showHidden, onClose, onReveal }: Props) {
  const icons = useActiveIconSet();
  const [state, setState] = useState(() => ({ mode, ...recall(paneId, mode) }));
  // The other mode has its own query: switch to it while rendering.
  if (state.mode !== mode) setState({ mode, ...recall(paneId, mode) });
  const { query, caseSensitive, wholeWord, regex } = state;
  const update = (patch: Partial<Query>) => setState((current) => ({ ...current, ...patch }));

  useEffect(() => {
    remembered.set(`${paneId}:${state.mode}`, { query, caseSensitive, wholeWord, regex });
  }, [paneId, state.mode, query, caseSensitive, wholeWord, regex]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [mode]);

  const [active, setActive] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  /* Name mode */
  const indexKey = `${root}\0${showHidden}`;
  const [indexState, setIndexState] = useState<IndexState>();
  useEffect(() => {
    if (mode !== "name") return;
    let live = true;
    loadIndex(root, showHidden).then(
      (loaded) => live && setIndexState({ key: indexKey, loaded }),
      (error) => live && setIndexState({ key: indexKey, error: String(error) }),
    );
    return () => {
      live = false;
    };
  }, [mode, root, showHidden, indexKey]);
  const index = indexState?.key === indexKey ? indexState : undefined;
  const names = useMemo(
    () => (mode === "name" && index?.loaded ? searchNames(query, index.loaded.index) : []),
    [mode, query, index],
  );

  /* Text mode */
  const [text, setText] = useState<TextState>(IDLE);
  /** Set when a search starts: the highlight goes to the first match once there is one. */
  const fresh = useRef(false);
  useEffect(() => {
    if (mode !== "text") return;
    if (query === "") {
      setText(IDLE);
      return;
    }
    let stale = false;
    let handle: TextSearch | undefined;
    const timer = setTimeout(() => {
      fresh.current = true;
      setCollapsed(new Set());
      setText({ root, files: [], phase: "searching", truncated: false });
      const options = { query, regex, caseSensitive, wholeWord, showHidden, maxResults: MAX_RESULTS };
      searchText(root, options, (event) => {
        if (stale) return;
        if (event.type === "files") setText((current) => ({ ...current, files: [...current.files, ...event.files] }));
        else if (event.type === "done") setText((current) => ({ ...current, phase: "done", truncated: event.truncated }));
        else setText((current) => ({ ...current, phase: "error", error: event.message }));
      }).then(
        (started) => {
          if (stale) started.cancel();
          else handle = started;
        },
        (error) => {
          if (!stale) setText({ root, files: [], phase: "error", truncated: false, error: String(error) });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
      handle?.cancel();
    };
  }, [mode, root, showHidden, query, regex, caseSensitive, wholeWord]);

  // Results from another root (a linked terminal changed directory) are gone until the new search starts.
  const textFiles = text.root === root ? text.files : NO_FILES;
  const textRows = useMemo(() => (mode === "text" ? flattenResults(textFiles, collapsed) : []), [mode, textFiles, collapsed]);
  const count = mode === "name" ? names.length : textRows.length;
  const activeIndex = Math.max(0, Math.min(count - 1, active));

  // A new query starts at the top.
  useEffect(() => {
    if (mode === "name") setActive(0);
  }, [mode, names]);
  useEffect(() => {
    if (fresh.current && textRows.length > 0) {
      fresh.current = false;
      setActive(firstMatchIndex(textRows));
    }
  }, [textRows]);

  const absolute = (path: string) => joinPath(root, path);
  const open = (path: string, at?: { line: number; column: number }) => openFile(absolute(path), { fromPaneId: paneId, ...at });
  const toggleFile = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const keepFocus = () => requestAnimationFrame(() => inputRef.current?.focus());

  const actOn = (index: number, { modified = false, byKey = false } = {}) => {
    if (mode === "name") {
      const result = names[index];
      if (!result) return;
      if (!modified) onReveal(absolute(result.path));
      else if (!result.dir) open(result.path);
      return;
    }
    const row = textRows[index];
    if (!row) return;
    if (row.type === "file") {
      toggleFile(row.path);
      return;
    }
    open(row.path, { line: row.match.line, column: row.match.column });
    if (byKey) keepFocus();
  };

  const move = (to: number) => setActive(Math.max(0, Math.min(count - 1, to)));
  const page = () => Math.max(1, Math.floor((listRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (mode === "text" && event.altKey && event.metaKey) {
      const toggle = TOGGLE_KEYS[event.code];
      if (toggle) {
        event.preventDefault();
        event.stopPropagation();
        update({ [toggle]: !state[toggle] });
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.altKey || event.ctrlKey || (event.metaKey && event.key !== "Enter")) return;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case "ArrowDown":
        handled();
        move(activeIndex + 1);
        break;
      case "ArrowUp":
        handled();
        move(activeIndex - 1);
        break;
      case "PageDown":
        handled();
        move(activeIndex + page());
        break;
      case "PageUp":
        handled();
        move(activeIndex - page());
        break;
      case "Enter":
        handled();
        actOn(activeIndex, { modified: event.metaKey, byKey: true });
        break;
    }
  };

  const searching = mode === "name" ? query.trim() !== "" : query !== "";
  const listId = `explorer-search-${paneId}`;
  const optionId = (i: number) => `${listId}-${i}`;
  const Icon = mode === "name" ? Search : TextSearchIcon;

  return (
    <div
      className="explorer-search pointer-events-none absolute inset-0 z-[1] flex flex-col overflow-hidden"
      style={searching ? { background: "var(--pane-bg)", pointerEvents: "auto" } : undefined}
    >
      {/* Right padding leaves room for the pane's hover controls, as the header does. */}
      <div
        className="explorer-search-bar pointer-events-auto flex h-[30px] flex-none items-center gap-1.5 border-b border-line pr-14 pl-3"
        style={searching ? undefined : { background: "var(--pane-bg)" }}
      >
        <Icon size={12} strokeWidth={2} className="flex-none text-fg-dim" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          role="combobox"
          aria-expanded={searching}
          aria-controls={listId}
          aria-activedescendant={searching && count > 0 ? optionId(activeIndex) : undefined}
          aria-label={mode === "name" ? "Find files and folders" : "Search in files"}
          placeholder={mode === "name" ? "Find files and folders" : "Search in files"}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className="min-w-0 flex-1 bg-transparent text-ui text-fg-bright outline-none select-text placeholder:text-fg-faint"
          onChange={(event) => update({ query: event.target.value })}
          onKeyDown={onKeyDown}
          // The field's own menu (cut, copy, paste), not the pane's.
          onContextMenu={(event) => event.stopPropagation()}
        />
        {mode === "text" && (
          <div className="flex flex-none items-center gap-0.5">
            <Toggle label="Match case" shortcut="⌥⌘C" pressed={caseSensitive} onToggle={() => update({ caseSensitive: !caseSensitive })}>
              <CaseSensitive size={14} strokeWidth={1.75} />
            </Toggle>
            <Toggle label="Match whole word" shortcut="⌥⌘W" pressed={wholeWord} onToggle={() => update({ wholeWord: !wholeWord })}>
              <WholeWord size={14} strokeWidth={1.75} />
            </Toggle>
            <Toggle label="Use regular expression" shortcut="⌥⌘R" pressed={regex} onToggle={() => update({ regex: !regex })}>
              <Regex size={14} strokeWidth={1.75} />
            </Toggle>
          </div>
        )}
      </div>
      {searching && (
        <div className="pointer-events-auto flex min-h-0 flex-1 flex-col">
          <StatusLine mode={mode} index={index} names={names.length} text={text} />
          <ResultList
            id={listId}
            scrollRef={listRef}
            count={count}
            activeIndex={activeIndex}
            renderRow={(i, top) => {
              const props = { id: optionId(i), top, active: i === activeIndex, icons };
              if (mode === "name") {
                return (
                  <NameRow
                    key={names[i].path}
                    {...props}
                    result={names[i]}
                    // A click reveals the entry (closing the search); ⌘-click opens a file and keeps it open.
                    onClick={(event) => {
                      setActive(i);
                      actOn(i, { modified: event.metaKey });
                    }}
                    onOpen={() => !names[i].dir && open(names[i].path)}
                  />
                );
              }
              const row = textRows[i];
              return (
                <TextResultRow
                  key={row.key}
                  {...props}
                  row={row}
                  onClick={() => {
                    setActive(i);
                    actOn(i);
                    if (row.type === "file") keepFocus();
                  }}
                  onOpen={() => open(row.path)}
                />
              );
            }}
          />
          {mode === "name" && index?.loaded?.truncated && (
            <div className="flex-none border-t border-line px-3 py-1 text-meta text-fg-dim">
              Only the first {INDEX_LIMIT.toLocaleString()} entries are searched
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  shortcut,
  pressed,
  onToggle,
  children,
}: {
  label: string;
  shortcut: string;
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Tip content={`${label} ${shortcut}`} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        // Clicking must not take focus from the input.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggle}
        className={`flex size-5 items-center justify-center rounded-sm outline-none ${
          pressed ? "bg-accent-soft text-accent-fg" : "text-fg-dim hover:bg-hover hover:text-fg-mid"
        }`}
      >
        {children}
      </button>
    </Tip>
  );
}

function StatusLine({
  mode,
  index,
  names,
  text,
}: {
  mode: ExplorerSearchMode;
  index: IndexState | undefined;
  names: number;
  text: TextState;
}) {
  let content: ReactNode = null;
  let error = false;
  if (mode === "name") {
    if (!index) content = "Indexing…";
    else if (index.error) [content, error] = [index.error, true];
    else if (names === 0) content = "No matching files";
  } else if (text.phase === "error") {
    [content, error] = [text.error, true];
  } else if (text.phase === "searching" && text.files.length === 0) {
    content = "Searching…";
  } else if (text.phase === "done" && text.files.length === 0) {
    content = "No results";
  } else if (text.files.length > 0) {
    const summary = resultsSummary(countMatches(text.files), text.files.length);
    content = text.phase === "searching" ? `${summary} · Searching…` : text.truncated ? `${summary} · only the first ${MAX_RESULTS.toLocaleString()} are shown` : summary;
  }
  if (content === null) return null;
  return (
    <div role="status" className={`flex-none truncate px-3 py-1 text-meta ${error ? "text-err" : "text-fg-dim"}`}>
      {content}
    </div>
  );
}

function ResultList({
  id,
  scrollRef,
  count,
  activeIndex,
  renderRow,
}: {
  id: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  count: number;
  activeIndex: number;
  renderRow: (index: number, top: number) => ReactNode;
}) {
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  useEffect(() => {
    if (count > 0) virtualizer.scrollToIndex(activeIndex, { align: "auto" });
    // The virtualizer object is stable; only the highlight moving should scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);
  return (
    <div ref={scrollRef} id={id} role="listbox" className="min-h-0 flex-1 overflow-y-auto outline-none">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => renderRow(item.index, item.start))}
      </div>
    </div>
  );
}

type RowProps = {
  id: string;
  top: number;
  active: boolean;
  icons: { set: LoadedIconSet | null; light: boolean };
  onClick: (event: MouseEvent) => void;
  /** Double click: open the file (a folder does nothing). */
  onOpen: () => void;
};

const ROW =
  "explorer-row absolute inset-x-0 flex cursor-default items-center gap-1.5 pr-3 whitespace-nowrap text-ui";
const rowColor = (active: boolean) => (active ? "is-selected text-fg-bright" : "text-fg-mid");

/** `text` with the parts inside `ranges` standing out. */
function Highlighted({ text, ranges, hitClass }: { text: string; ranges: readonly Range[]; hitClass: string }) {
  return (
    <>
      {segments(text, ranges).map((part, i) =>
        part.hit ? (
          <span key={i} className={hitClass}>
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

const NAME_HIT = "font-semibold text-fg-bright";

function NameRow({ id, top, active, icons, result, onClick, onOpen }: RowProps & { result: NameResult }) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      title={result.path}
      className={`${ROW} ${rowColor(active)}`}
      style={{ top, height: ROW_HEIGHT, paddingLeft: PAD_LEFT }}
      // The input keeps focus.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      onDoubleClick={onOpen}
    >
      <FileIcon set={icons.set} light={icons.light} name={result.name} path={result.path} kind={result.dir ? "dir" : "file"} />
      <span className="max-w-[75%] flex-none truncate">
        <Highlighted text={result.name} ranges={result.nameRanges} hitClass={NAME_HIT} />
      </span>
      {result.parent && (
        <span className="min-w-0 flex-1 truncate text-meta text-fg-faint">
          <Highlighted text={result.parent} ranges={result.parentRanges} hitClass="text-fg-dim" />
        </span>
      )}
    </div>
  );
}

function TextResultRow({ id, top, active, icons, row, onClick, onOpen }: RowProps & { row: TextRow }) {
  if (row.type === "file") {
    const name = baseNameOf(row.path);
    const Chevron = row.collapsed ? ChevronRight : ChevronDown;
    return (
      <div
        id={id}
        role="option"
        aria-selected={active}
        aria-expanded={!row.collapsed}
        title={row.path}
        className={`${ROW} ${rowColor(active)}`}
        style={{ top, height: ROW_HEIGHT, paddingLeft: PAD_LEFT }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        onDoubleClick={onOpen}
      >
        <Chevron size={10} strokeWidth={2.25} className="flex-none text-fg-dim" aria-hidden="true" />
        <FileIcon set={icons.set} light={icons.light} name={name} path={row.path} kind="file" />
        <span className="max-w-[75%] flex-none truncate text-fg-bright">{name}</span>
        <span className="min-w-0 flex-1 truncate text-meta text-fg-faint">{parentOf(row.path)}</span>
        <span className="flex-none rounded-full bg-hover px-1.5 text-micro text-fg-dim">{row.count}</span>
      </div>
    );
  }
  const { match } = row;
  const preview = trimPreview(match.text, match.ranges);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      title={`${row.path}:${match.line}:${match.column}`}
      className={`${ROW} ${rowColor(active)}`}
      style={{ top, height: ROW_HEIGHT, paddingLeft: PAD_LEFT + CHEVRON_SPACE }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <span className="w-8 flex-none text-right text-meta text-fg-faint tabular-nums">{match.line}</span>
      <span className="min-w-0 flex-1 truncate text-meta">
        <Highlighted text={preview.text} ranges={preview.ranges} hitClass="explorer-search-hit" />
      </span>
    </div>
  );
}
