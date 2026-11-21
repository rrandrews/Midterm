import { useLayoutEffect, useRef } from "react";
import type { Candidate } from "../../terminal/completion";

/** Entries rendered at most; the rest are counted. */
export const MAX_SHOWN = 200;

/**
 * The ⇥ completion matches above the blocks input editor (see
 * `useCompletion`): one name per row, directories with a trailing `/`,
 * the selected one kept in view. The editor keeps focus and the keys.
 */
export function CompletionList({
  matches,
  selected,
  onPick,
}: {
  matches: readonly Candidate[];
  selected: number;
  onPick: (candidate: Candidate) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const shown = matches.slice(0, MAX_SHOWN);

  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, matches]);

  return (
    <div className="blocks-complete">
      <div ref={list} className="blocks-complete-list" role="listbox" aria-label="Completions">
        {shown.map((candidate, i) => (
          <div
            key={candidate.name}
            role="option"
            aria-selected={i === selected}
            className="blocks-complete-row"
            // mousedown, not click: the textarea must not lose focus.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(candidate);
            }}
          >
            {candidate.name}
            {candidate.dir && <span className="text-fg-dim">/</span>}
          </div>
        ))}
      </div>
      <div className="blocks-complete-count">
        {matches.length > MAX_SHOWN ? `${MAX_SHOWN} of ${matches.length}` : `${matches.length} matches`} · ⇥ next · ⏎ take ·
        esc closes
      </div>
    </div>
  );
}
