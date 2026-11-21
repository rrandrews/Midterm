import { ArrowUpRight, ChevronRight } from "lucide-react";
import { useState } from "react";
import { homeDirectory } from "../../../ipc/system";
import { openSessionFile, useSession } from "../../store";
import type { ChangedFile } from "../../types";
import { Diff } from "../Diff";
import { diffTexts, relativeTo } from "../format";

/*
 * Aggregated list of files modified during the Antigravity session, with
 * +N/-M line totals, expandable latest unified diff, and click-to-open in
 * Midterm's editor.
 */

const EMPTY: Record<string, ChangedFile> = {};

function FileRow({ sessionKey, file, cwd, home }: { sessionKey: string; file: ChangedFile; cwd: string; home?: string }) {
  const [open, setOpen] = useState(false);
  const rel = relativeTo(file.path, cwd, home);
  const lines = open && file.latestDiff ? diffTexts(file.latestDiff.oldText ?? "", file.latestDiff.newText) : [];

  return (
    <div className="ag-file-entry">
      <div className="ag-file-row">
        <button
          type="button"
          className="ag-file-toggle"
          aria-expanded={file.latestDiff ? open : undefined}
          disabled={!file.latestDiff}
          onClick={() => setOpen((v) => !v)}
        >
          {file.latestDiff && <ChevronRight size={11} className={`ag-chevron${open ? " is-open" : ""}`} />}
          <span className="ag-file-path ag-mono" title={file.path}>
            {rel}
          </span>
          <span className="ag-file-stats ag-num">
            {file.added > 0 && <span className="text-ok">+{file.added}</span>}
            {file.removed > 0 && <span className="text-err">−{file.removed}</span>}
          </span>
        </button>
        <button
          type="button"
          className="ag-icon-button"
          title="Open in editor"
          aria-label={`Open ${rel} in editor`}
          onClick={() => openSessionFile(sessionKey, file.path)}
        >
          <ArrowUpRight size={12} />
        </button>
      </div>
      {open && lines.length > 0 && (
        <div className="ag-file-diff">
          <Diff lines={lines} limit={30} />
        </div>
      )}
    </div>
  );
}

export function FilesPanel({ sessionKey }: { sessionKey: string }) {
  const filesMap = useSession(sessionKey, (s) => s?.changedFiles ?? EMPTY);
  const cwd = useSession(sessionKey, (s) => s?.cwd ?? "");
  const home = homeDirectory();
  const files = Object.values(filesMap);

  const totalAdded = files.reduce((acc, f) => acc + f.added, 0);
  const totalRemoved = files.reduce((acc, f) => acc + f.removed, 0);

  if (files.length === 0) {
    return <div className="ag-panel-empty">No files modified in this session yet.</div>;
  }

  return (
    <div className="ag-panel-section">
      <div className="ag-panel-summary">
        <span>
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <span className="ag-num ag-file-stats">
          {totalAdded > 0 && <span className="text-ok">+{totalAdded}</span>}
          {totalRemoved > 0 && <span className="text-err">−{totalRemoved}</span>}
        </span>
      </div>
      <div className="ag-files-list">
        {files.map((file) => (
          <FileRow key={file.path} sessionKey={sessionKey} file={file} cwd={cwd} home={home} />
        ))}
      </div>
    </div>
  );
}
