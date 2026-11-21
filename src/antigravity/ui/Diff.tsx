import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import type { DiffLine } from "./format";

/*
 * Unified diff viewer: line number, sign, text. Added lines tinted `ok`,
 * removed `err`. Optional clickable file header opens the file in Midterm's
 * editor.
 */

const LIMIT = 40;

export function Diff({
  lines,
  limit = LIMIT,
  header,
  onOpenFile,
}: {
  lines: DiffLine[];
  limit?: number;
  header?: { label: string; added: number; removed: number };
  onOpenFile?: () => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, limit);
  return (
    <div className="ag-diff" role="table" aria-label="Changes">
      {header && (
        <div className="ag-diff-head">
          {onOpenFile ? (
            <button type="button" className="ag-diff-path ag-mono" title="Open in editor" onClick={onOpenFile}>
              <span>{header.label}</span>
              <ArrowUpRight size={10} />
            </button>
          ) : (
            <span className="ag-diff-path ag-mono">{header.label}</span>
          )}
          <span className="ag-diff-stats ag-num">
            {header.added > 0 && <span className="text-ok">+{header.added}</span>}
            {header.removed > 0 && <span className="text-err">−{header.removed}</span>}
          </span>
        </div>
      )}
      {shown.map((line, index) =>
        line.type === "gap" ? (
          <div key={index} className="ag-diff-gap" role="row">
            ⋯
          </div>
        ) : (
          <div key={index} className={`ag-diff-line is-${line.type}`} role="row">
            <span className="ag-diff-num">{line.type === "del" ? line.oldLine : line.newLine}</span>
            <span className="ag-diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "−" : ""}</span>
            <span className="ag-diff-text">{line.text || " "}</span>
          </div>
        ),
      )}
      {lines.length > limit && (
        <button type="button" className="ag-more" onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}
