import { useState } from "react";
import type { DiffLine } from "./format";

/*
 * A unified diff: line number, sign, text. Added lines tinted `ok`, removed
 * `err`, hunks separated by a gap row. Long diffs show their first lines
 * with "Show all".
 */

const LIMIT = 40;

export function Diff({ lines, limit = LIMIT }: { lines: DiffLine[]; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, limit);
  return (
    <div className="cc-diff" role="table" aria-label="Changes">
      {shown.map((line, index) =>
        line.type === "gap" ? (
          <div key={index} className="cc-diff-gap" role="row">
            ⋯
          </div>
        ) : (
          <div key={index} className={`cc-diff-line is-${line.type}`} role="row">
            <span className="cc-diff-num">{line.type === "del" ? line.oldLine : line.newLine}</span>
            <span className="cc-diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "−" : ""}</span>
            <span className="cc-diff-text">{line.text || " "}</span>
          </div>
        ),
      )}
      {lines.length > limit && (
        <button type="button" className="cc-more" onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}
