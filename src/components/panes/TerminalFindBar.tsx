import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TerminalSession } from "../../terminal/session";

/*
 * Find in a terminal's scrollback (⌘F). ↩ / ⌘G next, ⇧↩ / ⇧⌘G previous,
 * Escape closes and returns the keyboard to the terminal.
 */

type FindBarProps = {
  session: TerminalSession;
  /** Bumped by ⌘F while open, to select the query again. */
  focusToken: number;
  /** Set by the bar: what ⌘G / ⇧⌘G should do while it is open. */
  stepRef: React.RefObject<((backwards: boolean) => void) | null>;
  onClose: () => void;
};

export function TerminalFindBar({ session, focusToken, stepRef, onClose }: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(session.selection.includes("\n") ? "" : session.selection);
  const [results, setResults] = useState<{ resultIndex: number; resultCount: number } | null>(null);

  useEffect(() => session.onSearchResults(setResults), [session]);
  useEffect(() => () => session.clearSearch(), [session]);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);
  useEffect(() => {
    if (query) session.find(query, { incremental: true });
    else {
      session.clearSearch();
      setResults(null);
    }
  }, [session, query]);

  const step = (backwards: boolean) => {
    if (query) session.find(query, { backwards });
  };
  stepRef.current = step;

  const count = results && query ? (results.resultCount === 0 ? "No results" : `${results.resultIndex + 1} of ${results.resultCount}`) : "";

  return (
    <div
      role="search"
      className="absolute top-1.5 right-14 z-20 flex h-7 items-center gap-1 rounded-md bg-popover pr-1 pl-2 shadow-menu"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        ref={inputRef}
        aria-label="Find in terminal"
        placeholder="Find"
        spellCheck={false}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        className="h-full w-44 bg-transparent text-ui text-fg outline-none placeholder:text-fg-faint"
      />
      <span className="min-w-14 text-right text-micro text-fg-dim">{count}</span>
      <button type="button" aria-label="Previous match" onClick={() => step(true)} className="flex p-1 text-fg-dim hover:text-fg">
        <ChevronUp size={13} />
      </button>
      <button type="button" aria-label="Next match" onClick={() => step(false)} className="flex p-1 text-fg-dim hover:text-fg">
        <ChevronDown size={13} />
      </button>
      <button type="button" aria-label="Close find" onClick={onClose} className="flex p-1 text-fg-dim hover:text-fg">
        <X size={13} />
      </button>
    </div>
  );
}
