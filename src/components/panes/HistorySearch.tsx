import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { moveSelection, oneLine, searchMatches } from "../../terminal/historySearch";

/** Rows shown before the list scrolls. */
const VISIBLE_ROWS = 8;

/**
 * ⌃R reverse search over the editor's history, drawn above the editor. The
 * textarea keeps focus: while this is mounted a capture listener on it takes
 * the keys (typing edits the query, never the editor), so focus handling and
 * app shortcuts are untouched. ⏎/⇥ or a click `onPick`s a command, Esc/⌃G/⌃C
 * `onClose`s.
 */
export function HistorySearch({
  entries,
  initialQuery,
  inputRef,
  onPick,
  onClose,
}: {
  entries: readonly string[];
  initialQuery: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onPick: (command: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const matches = useMemo(() => searchMatches(entries, query), [entries, query]);
  const state = useRef({ query, selected, matches, onPick, onClose });
  state.current = { query, selected, matches, onPick, onClose };
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const edit = (next: string) => {
      setQuery(next);
      setSelected(0);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.altKey) return;
      const { query, selected, matches, onPick, onClose } = state.current;
      const key = event.key;
      const ctrl = event.ctrlKey;
      const lower = key.toLowerCase();
      if (key === "Escape" || (ctrl && (lower === "g" || lower === "c"))) onClose();
      else if (key === "Enter" || key === "Tab") {
        if (matches[selected]) onPick(matches[selected].entry);
        else onClose();
      } else if (key === "ArrowUp" || (ctrl && lower === "r")) setSelected(moveSelection(selected, 1, matches.length));
      else if (key === "ArrowDown" || (ctrl && lower === "s")) setSelected(moveSelection(selected, -1, matches.length));
      else if (key === "Backspace" && !ctrl) edit(query.slice(0, -1));
      else if (ctrl && lower === "u") edit("");
      else if (!ctrl && key.length === 1) edit(query + key);
      // Everything else is swallowed too (⌃D would send EOF), except bare
      // navigation and modifier keys, which are harmless.
      else if (!ctrl && key !== "Backspace" && key !== "Delete") return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData?.getData("text/plain");
      if (text) edit(state.current.query + oneLine(text));
    };
    input.addEventListener("keydown", onKey, true);
    input.addEventListener("paste", onPaste, true);
    return () => {
      input.removeEventListener("keydown", onKey, true);
      input.removeEventListener("paste", onPaste, true);
    };
  }, [inputRef]);

  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, matches]);

  return (
    <div className="blocks-search">
      <div className="blocks-search-query">
        <span className="text-fg-dim">history search: </span>
        <span className="text-fg-bright">{query}</span>
        <span className="blocks-search-caret" />
        {matches.length === 0 && <span className="ml-3 text-fg-faint">no match</span>}
      </div>
      {matches.length > 0 && (
        <div ref={list} className="blocks-search-list" role="listbox" style={{ maxHeight: `calc(${VISIBLE_ROWS} * var(--search-row))` }}>
          {matches.map((match, i) => (
            <div
              key={match.entry}
              role="option"
              aria-selected={i === selected}
              className="blocks-search-row"
              // mousedown, not click: the textarea must not lose focus.
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(match.entry);
              }}
            >
              <Highlighted text={oneLine(match.entry)} start={match.start} end={match.end} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Highlighted({ text, start, end }: { text: string; start: number; end: number }) {
  return (
    <>
      {text.slice(0, start)}
      <mark className="blocks-search-hit">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}
