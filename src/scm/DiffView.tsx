import { diffWordsWithSpace } from "diff";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Columns2,
  ExternalLink,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openFile } from "../actions";
import { confirm } from "../components/ui/ConfirmDialog";
import { Tip } from "../components/ui/Tooltip";
import { joinPath } from "../explorer/tree";
import { FileIcon } from "../icons/FileIcon";
import { useActiveIconSet } from "../icons/state";
import * as scm from "../ipc/scm";
import type { ScmDiff, ScmDiffHunk, ScmDiffLine } from "../ipc/scm";
import { registerPaneFocuser } from "../layout/dock";
import { notifyRepoChange, subscribeRepoChange } from "./model";
import type { ScmDiffTarget } from "./registry";
import { buildHunkPatch, splitRelPath } from "./tree";

type LayoutMode = "unified" | "split";
type WordSpan = { value: string; changed: boolean };

type SplitRow = {
  left: (ScmDiffLine & { spans?: WordSpan[] }) | null;
  right: (ScmDiffLine & { spans?: WordSpan[] }) | null;
};

type UnifiedRow = ScmDiffLine & { spans?: WordSpan[] };

const WORD_DIFF_MAX_LEN = 800;

function stripDisplayCr(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

function computeWordHighlights(delText: string, addText: string): { left: WordSpan[]; right: WordSpan[] } | null {
  if (delText.length > WORD_DIFF_MAX_LEN || addText.length > WORD_DIFF_MAX_LEN) return null;
  // Use `diffWordsWithSpace` so whitespace and indentation changes stay faithful on both sides.
  const parts = diffWordsWithSpace(delText, addText);
  const left: WordSpan[] = [];
  const right: WordSpan[] = [];
  for (const part of parts) {
    if (part.removed) left.push({ value: part.value, changed: true });
    else if (part.added) right.push({ value: part.value, changed: true });
    else {
      left.push({ value: part.value, changed: false });
      right.push({ value: part.value, changed: false });
    }
  }
  return { left, right };
}

/** Pairs consecutive deletion and addition blocks for inline word highlights and split alignment. */
function pairHunkLines(lines: readonly ScmDiffLine[]): { unified: UnifiedRow[]; split: SplitRow[] } {
  const unified: UnifiedRow[] = [];
  const split: SplitRow[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].kind === "context") {
      unified.push(lines[i]);
      split.push({ left: lines[i], right: lines[i] });
      i += 1;
      continue;
    }
    const dels: ScmDiffLine[] = [];
    const adds: ScmDiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") {
      dels.push(lines[i]);
      i += 1;
    }
    while (i < lines.length && lines[i].kind === "add") {
      adds.push(lines[i]);
      i += 1;
    }

    const pairCount = Math.min(dels.length, adds.length);
    const delSpans: (WordSpan[] | undefined)[] = new Array(dels.length);
    const addSpans: (WordSpan[] | undefined)[] = new Array(adds.length);
    for (let k = 0; k < pairCount; k++) {
      const hl = computeWordHighlights(stripDisplayCr(dels[k].content), stripDisplayCr(adds[k].content));
      if (hl) {
        delSpans[k] = hl.left;
        addSpans[k] = hl.right;
      }
    }

    for (let k = 0; k < dels.length; k++) unified.push({ ...dels[k], spans: delSpans[k] });
    for (let k = 0; k < adds.length; k++) unified.push({ ...adds[k], spans: addSpans[k] });

    const maxLen = Math.max(dels.length, adds.length);
    for (let k = 0; k < maxLen; k++) {
      split.push({
        left: k < dels.length ? { ...dels[k], spans: delSpans[k] } : null,
        right: k < adds.length ? { ...adds[k], spans: addSpans[k] } : null,
      });
    }
  }

  return { unified, split };
}

function renderLineContent(line: ScmDiffLine & { spans?: WordSpan[] }, tone: "add" | "del" | "context") {
  if (!line.spans) return stripDisplayCr(line.content) || " ";
  return line.spans.map((seg, idx) =>
    seg.changed ? (
      <span
        key={idx}
        className={tone === "add" ? "scm-word-add" : tone === "del" ? "scm-word-del" : ""}
      >
        {seg.value}
      </span>
    ) : (
      <span key={idx}>{seg.value}</span>
    ),
  );
}

function modeBadge(target: ScmDiffTarget): string {
  switch (target.mode) {
    case "unstaged":
      return "Working Tree";
    case "staged":
      return "Staged";
    case "untracked":
      return "Untracked";
    case "commit":
      return target.label ?? target.commitHash?.slice(0, 7) ?? "Commit";
    case "stash":
      return target.label ?? target.commitHash ?? "Stash";
  }
}

export function ScmDiffPane({ paneId, target }: { paneId: string; target: ScmDiffTarget }) {
  const icons = useActiveIconSet();
  const [diff, setDiff] = useState<ScmDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutMode>("unified");
  const [activeHunk, setActiveHunk] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);
  const loadGen = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGen.current += 1;
    };
  }, []);

  const loadDiff = useCallback(
    async (silent = false) => {
      const gen = ++loadGen.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const res = await scm.scmDiff(target.root, target.filePath, target.mode, {
          commitHash: target.commitHash,
          oldPath: target.oldPath,
        });
        if (!mountedRef.current || gen !== loadGen.current) return;
        setDiff(res);
        setLoading(false);
        setActiveHunk((prev) => (res.hunks.length === 0 ? 0 : Math.min(prev, res.hunks.length - 1)));
      } catch (err) {
        if (!mountedRef.current || gen !== loadGen.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    },
    [target.root, target.filePath, target.mode, target.commitHash, target.oldPath],
  );

  useEffect(() => {
    void loadDiff(false);
  }, [loadDiff]);

  useEffect(() => {
    return subscribeRepoChange(target.root, () => {
      void loadDiff(true);
    });
  }, [target.root, loadDiff]);

  useEffect(
    () => registerPaneFocuser(paneId, () => containerRef.current?.focus({ preventScroll: true })),
    [paneId],
  );

  const stats = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const h of diff?.hunks ?? []) {
      for (const l of h.lines) {
        if (l.kind === "add") adds += 1;
        else if (l.kind === "del") dels += 1;
      }
    }
    return { adds, dels };
  }, [diff]);

  const preparedHunks = useMemo(
    () => (diff?.hunks ?? []).map((hunk) => ({ hunk, ...pairHunkLines(hunk.lines) })),
    [diff],
  );

  const jumpToHunk = useCallback(
    (delta: 1 | -1) => {
      const count = diff?.hunks.length ?? 0;
      if (count === 0) return;
      const next = (activeHunk + delta + count) % count;
      setActiveHunk(next);
      hunkRefs.current[next]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    [activeHunk, diff?.hunks.length],
  );

  const runAction = async (label: string, fn: () => Promise<void>) => {
    if (busy || !mountedRef.current) return;
    setBusy(label);
    setError(null);
    try {
      await fn();
      notifyRepoChange(target.root);
      if (mountedRef.current) await loadDiff(true);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const applyHunk = async (hunkIndex: number, cached: boolean, reverse: boolean) => {
    if (!diff || diff.path !== target.filePath) return;
    const patch = buildHunkPatch(diff, hunkIndex);
    if (!patch) return;
    if (!cached && reverse) {
      const ok = await confirm({
        title: `Revert hunk #${hunkIndex + 1}?`,
        message: "This permanently reverts this hunk in your working tree.",
        action: "Revert hunk",
      });
      if (!ok || !mountedRef.current) return;
    }
    const label = cached ? (reverse ? "Unstaging hunk…" : "Staging hunk…") : "Reverting hunk…";
    await runAction(label, () => scm.scmApplyPatch(target.root, patch, cached, reverse));
  };

  const stageFile = () => runAction("Staging file…", () => scm.scmStage(target.root, [target.filePath]));
  const unstageFile = () => {
    const renameFrom = diff?.oldPath ?? target.oldPath;
    const files = renameFrom && renameFrom !== target.filePath ? [target.filePath, renameFrom] : [target.filePath];
    return runAction("Unstaging file…", () => scm.scmUnstage(target.root, files));
  };
  const openInEditor = () => {
    const absPath = joinPath(target.root, target.filePath);
    const hunk = diff?.hunks[activeHunk];
    const line = hunk ? Math.max(1, hunk.newStart || hunk.oldStart) : undefined;
    openFile(absPath, { fromPaneId: paneId, line });
  };

  const { name, dir } = splitRelPath(target.filePath);
  const oldPath = diff?.oldPath ?? target.oldPath;
  const hunkCount = diff?.hunks.length ?? 0;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.altKey && e.key === "ArrowDown") || (!e.metaKey && !e.ctrlKey && e.key === "]")) {
          e.preventDefault();
          jumpToHunk(1);
        } else if ((e.altKey && e.key === "ArrowUp") || (!e.metaKey && !e.ctrlKey && e.key === "[")) {
          e.preventDefault();
          jumpToHunk(-1);
        }
      }}
      className="scm-diff flex h-full min-h-0 flex-col outline-none"
    >
      {/* Top toolbar */}
      <div className="scm-diff-header flex h-9 flex-none items-center gap-2 border-b border-line px-3">
        <FileIcon set={icons.set} light={icons.light} name={name} path={target.filePath} kind="file" />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Tip content={oldPath ? `${oldPath} → ${target.filePath}` : target.filePath} side="bottom">
            <span className="truncate text-ui font-medium text-fg-bright">{name}</span>
          </Tip>
          {dir && <span className="min-w-0 truncate text-meta text-fg-faint">{dir}</span>}
          {oldPath && oldPath !== target.filePath && (
            <span className="hidden truncate rounded bg-info/12 px-1.5 py-px font-mono text-micro text-info sm:inline">
              ← {oldPath}
            </span>
          )}
          <span className="flex-none rounded bg-raised px-1.5 py-0.5 font-mono text-micro text-fg-muted">
            {modeBadge(target)}
          </span>
          {(stats.adds > 0 || stats.dels > 0) && (
            <span className="flex flex-none items-center gap-1 font-mono text-micro">
              {stats.adds > 0 && <span className="text-ok">+{stats.adds}</span>}
              {stats.dels > 0 && <span className="text-err">-{stats.dels}</span>}
            </span>
          )}
        </div>

        <div className="flex flex-none items-center gap-1">
          {hunkCount > 1 && (
            <div className="flex items-center rounded-[5px] border border-line-strong bg-field">
              <Tip content="Previous change (⌥↑)" side="bottom">
                <button
                  type="button"
                  aria-label="Previous change"
                  onClick={() => jumpToHunk(-1)}
                  className="flex h-6 w-6 items-center justify-center text-fg-dim hover:bg-hover hover:text-fg-bright"
                >
                  <ArrowUp size={12} />
                </button>
              </Tip>
              <span className="px-1 font-mono text-micro text-fg-dim">
                {activeHunk + 1}/{hunkCount}
              </span>
              <Tip content="Next change (⌥↓)" side="bottom">
                <button
                  type="button"
                  aria-label="Next change"
                  onClick={() => jumpToHunk(1)}
                  className="flex h-6 w-6 items-center justify-center text-fg-dim hover:bg-hover hover:text-fg-bright"
                >
                  <ArrowDown size={12} />
                </button>
              </Tip>
            </div>
          )}

          <div className="flex items-center rounded-[5px] border border-line-strong bg-field p-0.5">
            <Tip content="Unified diff" side="bottom">
              <button
                type="button"
                aria-label="Unified diff"
                aria-pressed={layout === "unified"}
                onClick={() => setLayout("unified")}
                className={`flex h-5 items-center gap-1 rounded px-1.5 text-micro ${
                  layout === "unified" ? "bg-selected text-fg-bright" : "text-fg-dim hover:text-fg-soft"
                }`}
              >
                <Rows2 size={11} />
                <span className="hidden md:inline">Unified</span>
              </button>
            </Tip>
            <Tip content="Side-by-side split diff" side="bottom">
              <button
                type="button"
                aria-label="Side-by-side diff"
                aria-pressed={layout === "split"}
                onClick={() => setLayout("split")}
                className={`flex h-5 items-center gap-1 rounded px-1.5 text-micro ${
                  layout === "split" ? "bg-selected text-fg-bright" : "text-fg-dim hover:text-fg-soft"
                }`}
              >
                <Columns2 size={11} />
                <span className="hidden md:inline">Split</span>
              </button>
            </Tip>
          </div>

          {(target.mode === "unstaged" || target.mode === "untracked") && (
            <Tip content="Stage entire file" side="bottom">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void stageFile()}
                className="flex h-6 items-center gap-1 rounded-[5px] bg-ok/15 px-2 text-micro font-medium text-ok hover:bg-ok/25 disabled:opacity-45"
              >
                <Plus size={12} />
                <span>Stage</span>
              </button>
            </Tip>
          )}
          {target.mode === "staged" && (
            <Tip content="Unstage entire file" side="bottom">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void unstageFile()}
                className="flex h-6 items-center gap-1 rounded-[5px] bg-warn/15 px-2 text-micro font-medium text-warn hover:bg-warn/25 disabled:opacity-45"
              >
                <Minus size={12} />
                <span>Unstage</span>
              </button>
            </Tip>
          )}

          {!diff?.isDeleted && (
            <Tip content="Open file in editor" side="bottom">
              <button
                type="button"
                aria-label="Open file in editor"
                onClick={openInEditor}
                className="flex h-6 w-6 items-center justify-center rounded-[5px] text-fg-dim hover:bg-hover hover:text-fg-bright"
              >
                <ExternalLink size={13} />
              </button>
            </Tip>
          )}

          <Tip content="Refresh diff" side="bottom">
            <button
              type="button"
              aria-label="Refresh diff"
              onClick={() => void loadDiff(false)}
              className="flex h-6 w-6 items-center justify-center rounded-[5px] text-fg-dim hover:bg-hover hover:text-fg-bright"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            </button>
          </Tip>
        </div>
      </div>

      {/* Diagnostic / warning notices */}
      {error && (
        <div className="flex items-center gap-2 border-b border-err/30 bg-err/10 px-3 py-1.5 text-meta text-err">
          <AlertTriangle size={13} className="flex-none" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
        </div>
      )}

      {diff?.nonUtf8 && (
        <div className="flex items-center gap-2 border-b border-warn/25 bg-warn/10 px-3 py-1.5 text-meta text-warn">
          <AlertTriangle size={13} className="flex-none" />
          <span>Non-UTF-8 file — read-only preview. Stage or discard the entire file instead of individual hunks.</span>
        </div>
      )}

      {diff?.typeChanged && (
        <div className="flex items-center gap-2 border-b border-info/25 bg-info/10 px-3 py-1.5 text-meta text-info">
          <AlertTriangle size={13} className="flex-none" />
          <span>File type changed (e.g. file ↔ symlink) — stage or discard the entire file to apply.</span>
        </div>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[19px] select-text">
        {loading && !diff ? (
          <div className="flex h-full items-center justify-center gap-2 text-meta text-fg-dim">
            <Loader2 size={14} className="animate-spin" />
            <span>Loading diff…</span>
          </div>
        ) : diff?.binary ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-fg-dim">
            <div className="text-ui font-medium text-fg-soft">Binary file</div>
            <div className="text-meta">Inline text diff is not available for binary files.</div>
          </div>
        ) : diff?.tooLarge && diff.hunks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 p-6 text-center text-fg-dim">
            <div className="text-ui font-medium text-fg-soft">Diff too large to preview inline</div>
            <div className="text-meta">Open the file in the editor to inspect it directly.</div>
            <button
              type="button"
              onClick={openInEditor}
              className="mt-1 h-7 rounded-[5px] bg-raised px-3 text-menu text-fg-bright hover:bg-hover"
            >
              Open in editor
            </button>
          </div>
        ) : preparedHunks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center text-fg-dim">
            <div className="text-ui font-medium text-fg-soft">No changes</div>
            <div className="text-meta">This file has no differences in the {modeBadge(target)} view.</div>
          </div>
        ) : (
          <div className="pb-6">
            {diff?.tooLarge && (
              <div className="border-b border-warn/25 bg-warn/10 px-3 py-1.5 font-sans text-meta text-warn">
                Diff output was truncated to keep the preview responsive — hunk staging is disabled.
              </div>
            )}

            {preparedHunks.map(({ hunk, unified, split }, hunkIdx) => (
              <HunkBlock
                key={`${hunk.header}:${hunkIdx}`}
                refCb={(el) => {
                  hunkRefs.current[hunkIdx] = el;
                }}
                hunk={hunk}
                hunkIdx={hunkIdx}
                layout={layout}
                unified={unified}
                split={split}
                canStageHunk={Boolean(diff?.patchable) && target.mode === "unstaged"}
                canUnstageHunk={Boolean(diff?.patchable) && target.mode === "staged"}
                busy={Boolean(busy)}
                onStage={() => void applyHunk(hunkIdx, true, false)}
                onRevert={() => void applyHunk(hunkIdx, false, true)}
                onUnstage={() => void applyHunk(hunkIdx, true, true)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HunkBlock({
  refCb,
  hunk,
  hunkIdx,
  layout,
  unified,
  split,
  canStageHunk,
  canUnstageHunk,
  busy,
  onStage,
  onRevert,
  onUnstage,
}: {
  refCb: (el: HTMLDivElement | null) => void;
  hunk: ScmDiffHunk;
  hunkIdx: number;
  layout: LayoutMode;
  unified: UnifiedRow[];
  split: SplitRow[];
  canStageHunk: boolean;
  canUnstageHunk: boolean;
  busy: boolean;
  onStage: () => void;
  onRevert: () => void;
  onUnstage: () => void;
}) {
  return (
    <div ref={refCb} className="scm-hunk border-b border-line/70">
      <div className="scm-hunk-header sticky top-0 z-10 flex h-7 items-center justify-between gap-2 border-y border-line/80 px-3 font-mono text-micro text-fg-dim select-none">
        <span className="min-w-0 truncate">{hunk.header}</span>
        <div className="flex flex-none items-center gap-1 font-sans">
          {canStageHunk && (
            <>
              <Tip content={`Revert hunk #${hunkIdx + 1}`} side="top">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onRevert}
                  className="flex h-5 items-center gap-1 rounded px-1.5 text-micro text-fg-mid hover:bg-err/15 hover:text-err disabled:opacity-40"
                >
                  <RotateCcw size={10} />
                  <span>Revert</span>
                </button>
              </Tip>
              <Tip content={`Stage hunk #${hunkIdx + 1}`} side="top">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onStage}
                  className="flex h-5 items-center gap-1 rounded bg-ok/15 px-1.5 text-micro font-medium text-ok hover:bg-ok/25 disabled:opacity-40"
                >
                  <Plus size={10} />
                  <span>Stage Hunk</span>
                </button>
              </Tip>
            </>
          )}
          {canUnstageHunk && (
            <Tip content={`Unstage hunk #${hunkIdx + 1}`} side="top">
              <button
                type="button"
                disabled={busy}
                onClick={onUnstage}
                className="flex h-5 items-center gap-1 rounded bg-warn/15 px-1.5 text-micro font-medium text-warn hover:bg-warn/25 disabled:opacity-40"
              >
                <Minus size={10} />
                <span>Unstage Hunk</span>
              </button>
            </Tip>
          )}
        </div>
      </div>

      {layout === "unified" ? (
        <table className="w-full border-collapse">
          <tbody>
            {unified.map((line, idx) => (
              <tr
                key={idx}
                className={
                  line.kind === "add"
                    ? "scm-line-add"
                    : line.kind === "del"
                      ? "scm-line-del"
                      : "scm-line-ctx"
                }
              >
                <td className="scm-gutter w-11 px-1.5 text-right text-fg-faint select-none">
                  {line.oldLine ?? ""}
                </td>
                <td className="scm-gutter w-11 border-r border-line/60 px-1.5 text-right text-fg-faint select-none">
                  {line.newLine ?? ""}
                </td>
                <td
                  className={`w-5 text-center select-none ${
                    line.kind === "add" ? "text-ok" : line.kind === "del" ? "text-err" : "text-fg-faint"
                  }`}
                >
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                </td>
                <td className="pr-3 whitespace-pre-wrap break-all">
                  {renderLineContent(line, line.kind)}
                  {line.noNewline && (
                    <span className="ml-1.5 rounded bg-raised px-1 text-[10px] text-fg-dim">no newline</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-10" />
            <col className="w-[calc(50%-2.5rem)]" />
            <col className="w-10" />
            <col className="w-[calc(50%-2.5rem)]" />
          </colgroup>
          <tbody>
            {split.map((row, idx) => (
              <tr key={idx}>
                <td
                  className={`scm-gutter px-1.5 text-right text-fg-faint select-none ${
                    row.left?.kind === "del" ? "scm-line-del" : row.left === null ? "scm-line-empty" : ""
                  }`}
                >
                  {row.left?.oldLine ?? ""}
                </td>
                <td
                  className={`border-r border-line/80 px-2 whitespace-pre-wrap break-all ${
                    row.left?.kind === "del" ? "scm-line-del" : row.left === null ? "scm-line-empty" : ""
                  }`}
                >
                  {row.left ? renderLineContent(row.left, row.left.kind) : ""}
                </td>
                <td
                  className={`scm-gutter px-1.5 text-right text-fg-faint select-none ${
                    row.right?.kind === "add" ? "scm-line-add" : row.right === null ? "scm-line-empty" : ""
                  }`}
                >
                  {row.right?.newLine ?? ""}
                </td>
                <td
                  className={`px-2 whitespace-pre-wrap break-all ${
                    row.right?.kind === "add" ? "scm-line-add" : row.right === null ? "scm-line-empty" : ""
                  }`}
                >
                  {row.right ? renderLineContent(row.right, row.right.kind) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
