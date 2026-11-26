import { Check, ChevronDown, ChevronRight, Copy, Loader2, Tag } from "lucide-react";
import { useMemo, useState } from "react";
import { Tip } from "../components/ui/Tooltip";
import { FileIcon } from "../icons/FileIcon";
import { useActiveIconSet } from "../icons/state";
import { copyText } from "../ipc/clipboard";
import type { ScmCommit, ScmCommitFile, ScmRef } from "../ipc/scm";
import { computeGraphLayout, GRAPH_LANE_COLORS, type GraphRowLayout } from "./graph";
import type { ScmModel, ScmSnapshot } from "./model";
import { openScmDiff } from "./registry";
import {
  formatCompactRelativeTime,
  formatRelativeTime,
  SCM_BADGE_CLASS,
  SCM_BADGE_LABEL,
  splitRelPath,
} from "./tree";

const LANE_WIDTH = 12;
const MAX_VISIBLE_LANES = 8;
const ROW_HEIGHT = 28;
const DOT_RADIUS = 3.2;

function laneX(lane: number): number {
  return 8 + Math.min(lane, MAX_VISIBLE_LANES - 1) * LANE_WIDTH;
}

function graphColumnWidth(maxLanes: number): number {
  const cols = Math.max(1, Math.min(maxLanes, MAX_VISIBLE_LANES));
  return Math.max(18, 14 + (cols - 1) * LANE_WIDTH);
}

function GraphCell({ row, maxLanes }: { row: GraphRowLayout; maxLanes: number }) {
  const width = graphColumnWidth(maxLanes);
  const midY = ROW_HEIGHT / 2;
  const cx = laneX(row.lane);
  const dotColor = GRAPH_LANE_COLORS[row.colorIndex % GRAPH_LANE_COLORS.length];

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      className="flex-none overflow-hidden"
      aria-hidden="true"
    >
      {row.incoming.map((edge, idx) => {
        const x1 = laneX(edge.fromLane);
        const x2 = laneX(edge.toLane);
        const stroke = GRAPH_LANE_COLORS[edge.colorIndex % GRAPH_LANE_COLORS.length];
        if (x1 === x2) {
          return <line key={`in-${idx}`} x1={x1} y1={0} x2={x2} y2={midY} stroke={stroke} strokeWidth={1.6} />;
        }
        return (
          <path
            key={`in-${idx}`}
            d={`M ${x1} 0 C ${x1} ${midY * 0.65}, ${x2} ${midY * 0.35}, ${x2} ${midY}`}
            fill="none"
            stroke={stroke}
            strokeWidth={1.6}
          />
        );
      })}

      {row.outgoing.map((edge, idx) => {
        const x1 = laneX(edge.fromLane);
        const x2 = laneX(edge.toLane);
        const stroke = GRAPH_LANE_COLORS[edge.colorIndex % GRAPH_LANE_COLORS.length];
        if (x1 === x2) {
          return (
            <line key={`out-${idx}`} x1={x1} y1={midY} x2={x2} y2={ROW_HEIGHT} stroke={stroke} strokeWidth={1.6} />
          );
        }
        return (
          <path
            key={`out-${idx}`}
            d={`M ${x1} ${midY} C ${x1} ${midY + midY * 0.65}, ${x2} ${midY + midY * 0.35}, ${x2} ${ROW_HEIGHT}`}
            fill="none"
            stroke={stroke}
            strokeWidth={1.6}
          />
        );
      })}

      {row.isHead && (
        <circle cx={cx} cy={midY} r={DOT_RADIUS + 2.4} fill="none" stroke={dotColor} strokeWidth={1.2} opacity={0.55} />
      )}
      <circle
        cx={cx}
        cy={midY}
        r={DOT_RADIUS}
        fill={row.isMerge ? "var(--color-app)" : dotColor}
        stroke={dotColor}
        strokeWidth={row.isMerge ? 1.8 : 1}
      />
    </svg>
  );
}

/**
 * Continuous vertical rails rendered alongside an expanded commit detail panel
 * so opening a commit never breaks or obscures active graph lines passing down.
 */
function GraphContinuationCell({ row, maxLanes }: { row: GraphRowLayout; maxLanes: number }) {
  const width = graphColumnWidth(maxLanes);
  // Deduplicate outgoing rails by their destination lane so each active rail is drawn once.
  const rails: { lane: number; colorIndex: number }[] = [];
  const seen = new Set<number>();
  for (const edge of row.outgoing) {
    if (seen.has(edge.toLane)) continue;
    seen.add(edge.toLane);
    rails.push({ lane: edge.toLane, colorIndex: edge.colorIndex });
  }

  return (
    <div style={{ width }} className="scm-graph-continuation relative flex-none self-stretch" aria-hidden="true">
      <svg
        width={width}
        viewBox={`0 0 ${width} 100`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-hidden"
      >
        {rails.map((rail) => {
          const x = laneX(rail.lane);
          const stroke = GRAPH_LANE_COLORS[rail.colorIndex % GRAPH_LANE_COLORS.length];
          return (
            <line
              key={rail.lane}
              x1={x}
              y1={0}
              x2={x}
              y2={100}
              stroke={stroke}
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
    </div>
  );
}

function RefPill({ item }: { item: ScmRef }) {
  const cls =
    item.kind === "head"
      ? "bg-accent/20 text-accent-fg border-accent/40 font-semibold"
      : item.kind === "branch"
        ? "bg-ok/12 text-ok border-ok/30"
        : item.kind === "remote"
          ? "bg-info/12 text-info border-info/30"
          : "bg-warn/12 text-warn border-warn/30";
  return (
    <span
      className={`inline-flex max-w-[112px] flex-none items-center gap-0.5 truncate rounded border px-1 py-px font-mono text-[9.5px] leading-tight ${cls}`}
    >
      {item.kind === "tag" && <Tag size={8} className="flex-none" />}
      <span className="truncate">{item.name}</span>
    </span>
  );
}

type Props = {
  paneId: string;
  model: ScmModel;
  snap: ScmSnapshot;
  collapsed: boolean;
  bodyHeight: number;
  onToggleCollapse: () => void;
};

export function CommitGraph({ paneId, model, snap, collapsed, bodyHeight, onToggleCollapse }: Props) {
  const icons = useActiveIconSet();
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [loadingHash, setLoadingHash] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const layout = useMemo(() => computeGraphLayout(snap.commits), [snap.commits]);
  const maxLanes = useMemo(() => layout.reduce((acc, r) => Math.max(acc, r.laneCount), 1), [layout]);

  const toggleCommit = async (commit: ScmCommit) => {
    if (expandedHash === commit.hash) {
      setExpandedHash(null);
      return;
    }
    setExpandedHash(commit.hash);
    if (!snap.commitFiles[commit.hash]) {
      setLoadingHash(commit.hash);
      try {
        await model.loadCommitFiles(commit.hash);
      } catch (error) {
        model.showError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoadingHash((cur) => (cur === commit.hash ? null : cur));
      }
    }
  };

  const openFileDiff = (commit: ScmCommit, file: ScmCommitFile) => {
    if (!snap.status) return;
    openScmDiff({
      fromPaneId: paneId,
      target: {
        root: snap.status.root,
        filePath: file.path,
        oldPath: file.origPath,
        mode: "commit",
        commitHash: commit.hash,
        label: commit.shortHash,
      },
    });
  };

  const copySha = (hash: string) => {
    void copyText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash((cur) => (cur === hash ? null : cur)), 1400);
  };

  return (
    <section
      data-scm-section="graph"
      className="scm-section flex min-h-0 flex-none flex-col overflow-hidden"
    >
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        className="scm-section-header flex h-7 flex-none w-full items-center gap-1.5 px-2 text-left text-micro font-semibold tracking-wide text-fg-muted uppercase hover:bg-hover hover:text-fg-bright"
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <span className="min-w-0 flex-1 truncate">Graph</span>
        {snap.commits.length > 0 && (
          <span className="rounded-full bg-raised px-1.5 py-px font-mono text-[10px] font-normal text-fg-dim">
            {snap.commits.length}
            {snap.hasMoreCommits ? "+" : ""}
          </span>
        )}
      </button>

      {!collapsed && (
        <div style={{ height: bodyHeight }} className="scm-section-body min-h-0 flex-none overflow-y-auto pb-1">
          {snap.commits.length === 0 ? (
            <div className="px-3 py-2 text-meta text-fg-faint">No commits yet</div>
          ) : (
            snap.commits.map((commit, index) => {
              const row = layout[index];
              const isExpanded = expandedHash === commit.hash;
              const files = snap.commitFiles[commit.hash];
              const isLoadingFiles = loadingHash === commit.hash && !files;
              // Omit local branch badges (`head` and `branch`) from the dense title line;
              // tags and remotes remain visible, and all refs show inside the expanded panel.
              const titleRefs = commit.refs.filter((r) => r.kind !== "head" && r.kind !== "branch");

              return (
                <div key={commit.hash} className={isExpanded ? "bg-selected/25" : ""}>
                  <Tip
                    content={`${commit.shortHash} · ${commit.subject} — ${commit.author} (${formatRelativeTime(commit.date)})`}
                    side="right"
                    delay={550}
                  >
                    <button
                      type="button"
                      onClick={() => void toggleCommit(commit)}
                      className="scm-commit-row flex h-[28px] w-full items-center gap-1.5 pr-2 pl-1 text-left hover:bg-hover"
                    >
                      <GraphCell row={row} maxLanes={maxLanes} />
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        {titleRefs.slice(0, 2).map((refItem) => (
                          <RefPill key={`${refItem.kind}:${refItem.name}`} item={refItem} />
                        ))}
                        {titleRefs.length > 2 && (
                          <span className="flex-none font-mono text-[9.5px] text-fg-faint">
                            +{titleRefs.length - 2}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-menu text-fg-soft">{commit.subject}</span>
                        <span className="flex-none text-micro text-fg-faint">
                          {formatCompactRelativeTime(commit.date)}
                        </span>
                      </div>
                    </button>
                  </Tip>

                  {isExpanded && (
                    <div className="scm-commit-details flex items-stretch gap-1.5 pr-2 pl-1">
                      <GraphContinuationCell row={row} maxLanes={maxLanes} />
                      <div className="my-1 min-w-0 flex-1 rounded-[6px] border border-line/80 bg-field/85 px-2.5 py-2 text-meta">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1 select-text">
                            <div className="font-medium break-words text-fg-bright">{commit.subject}</div>
                            {commit.body && (
                              <pre className="mt-1 font-sans text-micro whitespace-pre-wrap break-words text-fg-mid">
                                {commit.body}
                              </pre>
                            )}
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-micro text-fg-dim">
                              <span>{commit.author}</span>
                              <span>·</span>
                              <span className="font-mono text-fg-muted">{commit.shortHash}</span>
                              <span>·</span>
                              <span>{formatRelativeTime(commit.date)}</span>
                            </div>
                            {commit.refs.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {commit.refs.map((refItem) => (
                                  <RefPill key={`full:${refItem.kind}:${refItem.name}`} item={refItem} />
                                ))}
                              </div>
                            )}
                          </div>
                          <Tip content={copiedHash === commit.hash ? "Copied SHA" : "Copy commit SHA"} side="left">
                            <button
                              type="button"
                              aria-label="Copy commit SHA"
                              onClick={() => copySha(commit.hash)}
                              className="flex flex-none rounded p-1 text-fg-dim hover:bg-hover hover:text-fg-bright"
                            >
                              {copiedHash === commit.hash ? (
                                <Check size={12} className="text-ok" />
                              ) : (
                                <Copy size={12} />
                              )}
                            </button>
                          </Tip>
                        </div>

                        <div className="mt-2 border-t border-line/70 pt-1.5">
                          {isLoadingFiles ? (
                            <div className="flex items-center gap-1.5 py-1 text-micro text-fg-faint">
                              <Loader2 size={11} className="animate-spin" />
                              <span>Loading changed files…</span>
                            </div>
                          ) : files && files.length > 0 ? (
                            <div className="flex flex-col">
                              {files.map((file) => {
                                const { name, dir } = splitRelPath(file.path);
                                return (
                                  <Tip
                                    key={file.path}
                                    content={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                                    side="right"
                                    delay={450}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => openFileDiff(commit, file)}
                                      className="flex h-6 w-full items-center gap-1.5 rounded px-1 text-left hover:bg-hover"
                                    >
                                      <FileIcon
                                        set={icons.set}
                                        light={icons.light}
                                        name={name}
                                        path={file.path}
                                        kind="file"
                                      />
                                      <span className="truncate text-meta text-fg-soft">{name}</span>
                                      {dir && (
                                        <span className="min-w-0 flex-1 truncate text-micro text-fg-faint">{dir}</span>
                                      )}
                                      {!dir && <span className="flex-1" />}
                                      {!file.binary && (file.additions !== undefined || file.deletions !== undefined) && (
                                        <span className="flex flex-none items-center gap-1 font-mono text-[10px]">
                                          {(file.additions ?? 0) > 0 && (
                                            <span className="text-ok">+{file.additions}</span>
                                          )}
                                          {(file.deletions ?? 0) > 0 && (
                                            <span className="text-err">-{file.deletions}</span>
                                          )}
                                        </span>
                                      )}
                                      <span
                                        aria-label={SCM_BADGE_LABEL[file.status]}
                                        className={`w-3 flex-none text-center font-mono text-micro font-semibold ${SCM_BADGE_CLASS[file.status]}`}
                                      >
                                        {file.status}
                                      </span>
                                    </button>
                                  </Tip>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="py-1 text-micro text-fg-faint">No file changes in this commit</div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}

          {snap.hasMoreCommits && (
            <div className="px-2 pt-1.5">
              <button
                type="button"
                disabled={snap.loadingMoreCommits}
                onClick={() => void model.loadMoreCommits()}
                className="flex h-6 w-full items-center justify-center gap-1.5 rounded-[5px] border border-line-strong bg-field text-meta text-fg-mid hover:bg-hover hover:text-fg-bright disabled:opacity-45"
              >
                {snap.loadingMoreCommits && <Loader2 size={11} className="animate-spin" />}
                <span>{snap.loadingMoreCommits ? "Loading…" : "Load more commits"}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
