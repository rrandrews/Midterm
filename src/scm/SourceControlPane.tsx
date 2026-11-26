import {
  AlertTriangle,
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Link2,
  List,
  ListTree,
  Loader2,
  Minus,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { openFile } from "../actions";
import { registerPaneActions } from "../commands/registry";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/Menu";
import { Tip } from "../components/ui/Tooltip";
import { baseName, joinPath } from "../explorer/tree";
import { fallbackHostLabel, isRemotePath, posixPathOf, remoteIdOf } from "../files/location";
import { FileIcon } from "../icons/FileIcon";
import { useActiveIconSet } from "../icons/state";
import { copyText } from "../ipc/clipboard";
import type { ScmDiffMode, ScmFileChange } from "../ipc/scm";
import { revealInFileManager } from "../ipc/shell";
import { homeDirectory } from "../ipc/system";
import { registerPaneFocuser } from "../layout/dock";
import type { PaneProps } from "../plugins/types";
import { displayLocation, reconnectConnection, useSshConnection } from "../ssh/connections";
import { BranchPicker } from "./BranchPicker";
import { CommitGraph } from "./CommitGraph";
import { ScmDiffPane } from "./DiffView";
import {
  applyScmSashDrag,
  availableScmBodyHeight,
  computeScmPaneHeights,
  SCM_COLLAPSE_BODY_PX,
  type ScmPaneHeights,
} from "./layout";
import { type ScmModel, type ScmSnapshot } from "./model";
import { acquireScm, openScmDiff, releaseScm, type SourceControlData } from "./registry";
import { StashList } from "./StashList";
import {
  buildChangeTree,
  flattenChangeTree,
  SCM_BADGE_CLASS,
  SCM_BADGE_LABEL,
  type ScmTreeNode,
  splitRelPath,
} from "./tree";

export function SourceControlPane({ paneId, data }: PaneProps) {
  const scData = data as SourceControlData;
  if (scData.diffTarget) {
    const t = scData.diffTarget;
    const targetKey = `${t.root}\0${t.mode}\0${t.commitHash ?? ""}\0${t.oldPath ?? ""}\0${t.filePath}`;
    return <ScmDiffPane key={targetKey} paneId={paneId} target={t} />;
  }
  return <SourceControlSidebarHost paneId={paneId} />;
}

function SourceControlSidebarHost({ paneId }: { paneId: string }) {
  const [model, setModel] = useState<ScmModel | null>(null);

  useEffect(() => {
    const acquired = acquireScm(paneId);
    acquired.attach();
    setModel(acquired);
    return () => releaseScm(acquired);
  }, [paneId]);

  return model ? <SourceControlView paneId={paneId} model={model} /> : null;
}

function SourceControlView({ paneId, model }: { paneId: string; model: ScmModel }) {
  const snap = useSyncExternalStore(model.subscribe, model.snapshot);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const accordionRef = useRef<HTMLDivElement>(null);
  const [accordionHeight, setAccordionHeight] = useState(0);
  const [draggingSash, setDraggingSash] = useState<0 | 1 | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const hasStatus = snap.status !== null;
  useEffect(() => {
    const el = accordionRef.current;
    if (!el) return;
    const measure = () => setAccordionHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasStatus]);

  const effectiveAccordionHeight = accordionHeight > 0 ? accordionHeight : 420;
  const paneHeights: ScmPaneHeights = useMemo(
    () => computeScmPaneHeights(effectiveAccordionHeight, snap.collapsedSections, snap.sectionWeights),
    [effectiveAccordionHeight, snap.collapsedSections, snap.sectionWeights],
  );

  const startSashDrag = (sashIndex: 0 | 1, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const startY = event.clientY;
    const containerHeight = accordionRef.current?.clientHeight || effectiveAccordionHeight;
    const startCollapsed = new Set(model.snapshot().collapsedSections);
    const startWeights = { ...model.snapshot().sectionWeights };
    const startHeights = computeScmPaneHeights(containerHeight, startCollapsed, startWeights);
    setDraggingSash(sashIndex);

    const onMove = (moveEvent: PointerEvent) => {
      const result = applyScmSashDrag({
        sashIndex,
        deltaY: moveEvent.clientY - startY,
        containerHeight,
        startHeights,
        startCollapsed,
        startWeights,
      });
      model.setSectionLayout(result.collapsed, result.weights);
    };
    const onEnd = () => {
      setDraggingSash(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const nudgeSash = (sashIndex: 0 | 1, direction: -1 | 1) => {
    const containerHeight = accordionRef.current?.clientHeight || effectiveAccordionHeight;
    const startCollapsed = new Set(model.snapshot().collapsedSections);
    const startWeights = { ...model.snapshot().sectionWeights };
    const startHeights = computeScmPaneHeights(containerHeight, startCollapsed, startWeights);
    const aboveKey = sashIndex === 0 ? "changes" : "graph";
    const belowKey = sashIndex === 0 ? "graph" : "stashes";
    const openingCollapsed =
      (direction > 0 && startCollapsed.has(aboveKey)) || (direction < 0 && startCollapsed.has(belowKey));
    const step = openingCollapsed ? SCM_COLLAPSE_BODY_PX + 16 : 24;
    const result = applyScmSashDrag({
      sashIndex,
      deltaY: direction * step,
      containerHeight,
      startHeights,
      startCollapsed,
      startWeights,
    });
    model.setSectionLayout(result.collapsed, result.weights);
  };

  const root = snap.status?.root ?? snap.root;
  const remoteId = remoteIdOf(root);
  const sshConn = useSshConnection(remoteId);
  const home = homeDirectory();
  const repoDisplay = displayLocation(root, home, { includeHost: false });
  const repoTitle = baseName(root) || repoDisplay;
  const hostLabel = remoteId ? (sshConn?.label ?? fallbackHostLabel(remoteId)) : null;
  const isDisconnected = Boolean(remoteId && (snap.disconnectedError || sshConn?.status === "disconnected"));

  useEffect(
    () =>
      registerPaneFocuser(paneId, () => {
        if (textareaRef.current) textareaRef.current.focus({ preventScroll: true });
        else rootRef.current?.focus({ preventScroll: true });
      }),
    [paneId],
  );

  useEffect(
    () =>
      registerPaneActions(paneId, {
        refresh: () => void model.refresh({ includeMeta: true }),
        commit: () => void model.commit(),
        stageAll: () => void model.stageAll(),
        unstageAll: () => void model.unstageAll(),
      }),
    [paneId, model],
  );

  const status = snap.status;
  const allUnstagedChanges = useMemo<ScmFileChange[]>(
    () => (status ? [...status.unstaged, ...status.untracked] : []),
    [status],
  );

  const totalPendingChanges =
    (status?.staged.length ?? 0) +
    (status?.unstaged.length ?? 0) +
    (status?.untracked.length ?? 0) +
    (status?.conflicted.length ?? 0);

  const firstLineLen = useMemo(() => {
    const nl = snap.commitMessage.indexOf("\n");
    return nl === -1 ? snap.commitMessage.length : nl;
  }, [snap.commitMessage]);

  const handleReconnect = async () => {
    if (!remoteId || reconnecting) return;
    setReconnecting(true);
    try {
      await reconnectConnection(remoteId);
    } catch (error) {
      model.showError(`Could not reconnect: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setReconnecting(false);
    }
  };

  const openChangeDiff = (change: ScmFileChange, mode: ScmDiffMode, newPane = false) => {
    if (!status) return;
    openScmDiff({
      fromPaneId: paneId,
      newPane,
      target: {
        root: status.root,
        filePath: change.path,
        oldPath: change.origPath,
        mode,
      },
    });
  };

  const openChangeFile = (change: ScmFileChange) => {
    openFile(joinPath(root, change.path), { fromPaneId: paneId });
  };

  // Decide the primary button behavior (VS Code pattern):
  // - If there are changes, a draft message, or Amend is active -> "Commit"
  // - Else if clean and unpushed/unpulled -> "Sync Changes" or "Publish Branch"
  const showPublishPrimary =
    Boolean(status) &&
    totalPendingChanges === 0 &&
    !snap.commitMessage.trim() &&
    !snap.amend &&
    !status!.upstream &&
    snap.commits.length > 0;
  const showSyncPrimary =
    Boolean(status) &&
    totalPendingChanges === 0 &&
    !snap.commitMessage.trim() &&
    !snap.amend &&
    Boolean(status!.upstream) &&
    (status!.ahead > 0 || status!.behind > 0);

  return (
    <div ref={rootRef} tabIndex={-1} className="scm-pane flex h-full min-h-0 flex-col outline-none select-none">
      {/* Header */}
      <div className="scm-header flex h-8 flex-none items-center gap-1.5 border-b border-line pl-2.5">
        <Tip content={displayLocation(root, home, { includeHost: true })} side="bottom">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <GitBranch size={13} className="flex-none text-fg-dim" />
            <span className="min-w-0 truncate text-menu font-semibold text-fg-bright">{repoTitle}</span>
            {hostLabel && (
              <span className="max-w-[84px] flex-none truncate rounded bg-raised px-1 py-px font-mono text-[9.5px] text-info">
                {hostLabel}
              </span>
            )}
            {snap.pinned && (
              <Tip content="Pinned to this folder (does not follow terminal)" side="bottom">
                <Pin size={11} role="img" aria-label="Pinned" className="flex-none text-fg-dim" />
              </Tip>
            )}
            {snap.link && !snap.pinned && (
              <Tip content="Linked to a terminal pane" side="bottom">
                <Link2 size={11} role="img" aria-label="Linked to terminal" className="flex-none text-accent" />
              </Tip>
            )}
          </div>
        </Tip>

        <div className="flex flex-none items-center gap-0.5">
          <Tip content={snap.viewMode === "tree" ? "Switch to list view" : "Switch to tree view"} side="bottom">
            <button
              type="button"
              aria-label={snap.viewMode === "tree" ? "Switch to list view" : "Switch to tree view"}
              onClick={() => model.setViewMode(snap.viewMode === "tree" ? "list" : "tree")}
              className="scm-icon-btn"
            >
              {snap.viewMode === "tree" ? <List size={13} /> : <ListTree size={13} />}
            </button>
          </Tip>

          <Tip content="Refresh" side="bottom">
            <button
              type="button"
              aria-label="Refresh source control"
              onClick={() => void model.refresh({ includeMeta: true })}
              className="scm-icon-btn"
            >
              <RefreshCw size={12} className={snap.loading ? "animate-spin" : ""} />
            </button>
          </Tip>

          {status && (
            <Menu>
              <Tip content="More source control actions" side="bottom">
                <MenuTrigger asChild>
                  <button type="button" aria-label="More source control actions" className="scm-icon-btn">
                    <MoreHorizontal size={13} />
                  </button>
                </MenuTrigger>
              </Tip>
              <MenuContent aria-label="Source control actions">
                <MenuItem onSelect={() => void model.fetch(false)}>Fetch</MenuItem>
                <MenuItem onSelect={() => void model.fetch(true)}>Fetch (Prune)</MenuItem>
                <MenuItem onSelect={() => void model.pull(false)}>Pull</MenuItem>
                <MenuItem onSelect={() => void model.pull(true)}>Pull (Rebase)</MenuItem>
                <MenuItem onSelect={() => void model.push()}>Push</MenuItem>
                <MenuItem onSelect={() => void model.push({ forceWithLease: true })}>Push (Force with Lease)</MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={() => void model.stageAll()}>Stage all changes</MenuItem>
                <MenuItem onSelect={() => void model.unstageAll()}>Unstage all changes</MenuItem>
                <MenuItem
                  danger
                  disabled={allUnstagedChanges.length === 0}
                  onSelect={() => void model.discardAll()}
                >
                  Discard all changes…
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  disabled={totalPendingChanges === 0}
                  onSelect={() => void model.stashPush(undefined, { includeUntracked: false })}
                >
                  Stash changes
                </MenuItem>
                <MenuItem
                  disabled={totalPendingChanges === 0}
                  onSelect={() => void model.stashPush(undefined, { includeUntracked: true })}
                >
                  Stash (include untracked)
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={snap.commits.length === 0} onSelect={() => void model.undoLastCommit()}>
                  Undo last commit
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      </div>

      {/* Status banners */}
      {isDisconnected && (
        <div className="flex items-center justify-between gap-2 border-b border-warn/25 bg-warn/10 px-2.5 py-1.5 text-meta text-warn">
          <span className="truncate">SSH disconnected ({hostLabel})</span>
          <button
            type="button"
            disabled={reconnecting}
            onClick={() => void handleReconnect()}
            className="flex-none rounded bg-warn/20 px-2 py-0.5 text-micro font-medium text-fg-bright hover:bg-warn/30 disabled:opacity-50"
          >
            {reconnecting ? "Connecting…" : "Reconnect"}
          </button>
        </div>
      )}

      {status && status.state !== "normal" && (
        <div className="flex items-center justify-between gap-2 border-b border-warn/30 bg-warn/12 px-2.5 py-1.5 text-meta">
          <div className="flex min-w-0 items-center gap-1.5 text-warn">
            <AlertTriangle size={12} className="flex-none" />
            <span className="truncate font-medium capitalize">{status.state} in progress</span>
          </div>
          <button
            type="button"
            disabled={Boolean(snap.busyAction)}
            onClick={() => void model.abortOperation()}
            className="flex-none rounded bg-err/15 px-2 py-0.5 text-micro font-medium text-err hover:bg-err/25 disabled:opacity-45"
          >
            Abort
          </button>
        </div>
      )}

      {snap.error && (
        <div className="flex items-start gap-1.5 border-b border-err/30 bg-err/10 px-2.5 py-1.5 text-micro text-err">
          <AlertTriangle size={12} className="mt-0.5 flex-none" />
          <span className="min-w-0 flex-1 break-words select-text">{snap.error}</span>
          <Tip content="Dismiss error" side="left">
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => model.clearError()}
              className="flex-none rounded p-0.5 text-err/80 hover:bg-err/15 hover:text-err"
            >
              <X size={11} />
            </button>
          </Tip>
        </div>
      )}

      {snap.notice && !snap.error && (
        <div className="flex items-center justify-between gap-2 border-b border-ok/25 bg-ok/10 px-2.5 py-1 text-micro text-ok">
          <span className="min-w-0 flex-1 truncate">{snap.notice}</span>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => model.clearNotice()}
            className="flex-none rounded p-0.5 hover:bg-ok/15"
          >
            <X size={10} />
          </button>
        </div>
      )}

      {/* Main scrollable content */}
      {snap.notARepo ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
          <FolderGit2 size={28} strokeWidth={1.5} className="text-fg-faint" />
          <div className="space-y-1">
            <div className="text-ui font-medium text-fg-bright">No Git repository</div>
            <div className="max-w-[230px] break-all text-meta text-fg-dim">
              {displayLocation(snap.root, home, { includeHost: true })} is not inside a Git repository.
            </div>
          </div>
          <button
            type="button"
            disabled={Boolean(snap.busyAction)}
            onClick={() => void model.initRepo()}
            className="flex h-7 items-center gap-1.5 rounded-[6px] bg-accent/20 px-3 text-menu font-medium text-accent-fg hover:bg-accent/30 disabled:opacity-45"
          >
            {snap.busyAction ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
            <span>Initialize Repository</span>
          </button>
        </div>
      ) : !status ? (
        snap.loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-meta text-fg-dim">
            <Loader2 size={14} className="animate-spin" />
            <span>Loading repository…</span>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 p-5 text-center">
            <AlertTriangle size={22} strokeWidth={1.6} className="text-warn" />
            <div className="space-y-1">
              <div className="text-ui font-medium text-fg-bright">
                {isDisconnected ? "SSH host disconnected" : "Unable to load Git status"}
              </div>
              {snap.error && <div className="max-w-[240px] break-words text-meta text-fg-dim">{snap.error}</div>}
            </div>
            {isDisconnected ? (
              <button
                type="button"
                disabled={reconnecting}
                onClick={() => void handleReconnect()}
                className="flex h-7 items-center gap-1.5 rounded-[6px] bg-warn/20 px-3 text-menu font-medium text-fg-bright hover:bg-warn/30 disabled:opacity-45"
              >
                {reconnecting ? "Connecting…" : "Reconnect"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void model.refresh({ includeMeta: true })}
                className="flex h-7 items-center gap-1.5 rounded-[6px] bg-raised px-3 text-menu text-fg-bright hover:bg-hover"
              >
                <RefreshCw size={12} />
                <span>Retry</span>
              </button>
            )}
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Commit box (fixed above the resizable Changes / Graph / Stashes accordion) */}
          <div className="flex flex-none flex-col gap-1.5 border-b border-line p-2">
            <div className="relative">
              <textarea
                ref={textareaRef}
                rows={2}
                value={snap.commitMessage}
                onChange={(e) => model.setCommitMessage(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void model.commit();
                  }
                }}
                placeholder={`Message (⌘↩ to commit${status.branch ? ` on "${status.branch}"` : ""})`}
                aria-label="Commit message"
                className="scm-commit-input block w-full resize-y rounded-[6px] border border-line-input bg-field px-2 py-1.5 font-sans text-menu leading-snug text-fg-bright placeholder:text-fg-faint outline-none select-text focus:border-accent"
              />
              {firstLineLen > 50 && (
                <Tip content="Subject line length (50–72 chars recommended)" side="left">
                  <span
                    className={`pointer-events-auto absolute right-1.5 bottom-1 rounded px-1 font-mono text-[9.5px] ${
                      firstLineLen > 72 ? "bg-err/15 text-err" : "bg-warn/15 text-warn"
                    }`}
                  >
                    {firstLineLen}
                  </span>
                </Tip>
              )}
            </div>

            <div className="flex items-center justify-between gap-1.5">
              {snap.busyAction ? (
                <span className="flex min-w-0 items-center gap-1 truncate text-micro text-fg-dim">
                  <Loader2 size={10} className="flex-none animate-spin" />
                  <span className="truncate">{snap.busyAction}</span>
                </span>
              ) : (
                <span className="flex-1" />
              )}

              <div className="ml-auto flex flex-none items-center gap-1">
                <Tip content="Amend the previous commit instead of creating a new one" side="bottom">
                  <button
                    type="button"
                    aria-pressed={snap.amend}
                    disabled={snap.commits.length === 0}
                    onClick={() => model.setAmend(!snap.amend)}
                    className={`flex h-6 items-center gap-1 rounded-[5px] border px-1.5 text-micro transition-colors disabled:opacity-35 ${
                      snap.amend
                        ? "border-accent/50 bg-accent/18 font-medium text-accent-fg"
                        : "border-line-strong bg-field text-fg-dim hover:bg-hover hover:text-fg-soft"
                    }`}
                  >
                    {snap.amend && <Check size={10} />}
                    <span>Amend</span>
                  </button>
                </Tip>

                <Tip content="Undo last commit (keep changes staged)" side="bottom">
                  <button
                    type="button"
                    aria-label="Undo last commit"
                    disabled={snap.commits.length === 0 || Boolean(snap.busyAction)}
                    onClick={() => void model.undoLastCommit()}
                    className="scm-icon-btn h-6 w-6 justify-center border border-line-strong bg-field disabled:opacity-35"
                  >
                    <Undo2 size={11} />
                  </button>
                </Tip>
              </div>
            </div>

            {/* Split primary Commit / Sync / Publish button */}
            <div className="flex h-7 overflow-hidden rounded-[6px] border border-accent/40 bg-accent/20 text-menu font-medium text-accent-fg">
              {showPublishPrimary ? (
                <button
                  type="button"
                  disabled={Boolean(snap.busyAction)}
                  onClick={() => void model.push({ setUpstream: true })}
                  className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 hover:bg-accent/15 disabled:opacity-45"
                >
                  <CloudUpload size={13} />
                  <span className="truncate">Publish Branch</span>
                </button>
              ) : showSyncPrimary ? (
                <button
                  type="button"
                  disabled={Boolean(snap.busyAction)}
                  onClick={() => void model.sync()}
                  className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 hover:bg-accent/15 disabled:opacity-45"
                >
                  <ArrowDownUp size={12} />
                  <span className="truncate">
                    Sync Changes {status.behind > 0 ? `↓${status.behind} ` : ""}
                    {status.ahead > 0 ? `↑${status.ahead}` : ""}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={Boolean(snap.busyAction) || !snap.commitMessage.trim()}
                  onClick={() => void model.commit()}
                  className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 hover:bg-accent/15 disabled:opacity-45"
                >
                  <Check size={13} />
                  <span className="truncate">{snap.amend ? "Commit (Amend)" : "Commit"}</span>
                </button>
              )}

              <Menu>
                <Tip content="More commit actions" side="bottom">
                  <MenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="More commit actions"
                      disabled={Boolean(snap.busyAction)}
                      className="flex w-7 flex-none items-center justify-center border-l border-accent/30 hover:bg-accent/15 disabled:opacity-45"
                    >
                      <ChevronDown size={12} />
                    </button>
                  </MenuTrigger>
                </Tip>
                <MenuContent aria-label="Commit actions">
                  <MenuItem disabled={!snap.commitMessage.trim()} onSelect={() => void model.commit()}>
                    Commit
                  </MenuItem>
                  <MenuItem disabled={!snap.commitMessage.trim()} onSelect={() => void model.commit({ push: true })}>
                    Commit & Push
                  </MenuItem>
                  <MenuItem disabled={!snap.commitMessage.trim()} onSelect={() => void model.commit({ sync: true })}>
                    Commit & Sync
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    disabled={!snap.commitMessage.trim() || snap.commits.length === 0}
                    onSelect={() => void model.commit({ amend: true })}
                  >
                    Commit (Amend)
                  </MenuItem>
                  <MenuItem disabled={snap.commits.length === 0} onSelect={() => void model.undoLastCommit()}>
                    Undo Last Commit
                  </MenuItem>
                </MenuContent>
              </Menu>
            </div>
          </div>

          {/* Resizable vertical accordion: Changes, Graph, Stashes */}
          <div ref={accordionRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <ChangesPane
              root={status.root}
              conflicted={status.conflicted}
              staged={status.staged}
              unstaged={allUnstagedChanges}
              model={model}
              snap={snap}
              collapsed={snap.collapsedSections.has("changes")}
              bodyHeight={paneHeights.changes}
              onToggleCollapse={() => model.toggleSection("changes")}
              onOpenDiff={openChangeDiff}
              onOpenFile={openChangeFile}
            />

            <div
              role="separator"
              tabIndex={0}
              aria-orientation="horizontal"
              aria-label="Resize Changes and Graph"
              aria-valuemin={0}
              aria-valuemax={Math.round(availableScmBodyHeight(effectiveAccordionHeight))}
              aria-valuenow={Math.round(paneHeights.changes)}
              data-dragging={draggingSash === 0 ? "true" : undefined}
              onPointerDown={(e) => startSashDrag(0, e)}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  nudgeSash(0, -1);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  nudgeSash(0, 1);
                }
              }}
              className="scm-sash"
            />

            <CommitGraph
              paneId={paneId}
              model={model}
              snap={snap}
              collapsed={snap.collapsedSections.has("graph")}
              bodyHeight={paneHeights.graph}
              onToggleCollapse={() => model.toggleSection("graph")}
            />

            <div
              role="separator"
              tabIndex={0}
              aria-orientation="horizontal"
              aria-label="Resize Graph and Stashes"
              aria-valuemin={0}
              aria-valuemax={Math.round(availableScmBodyHeight(effectiveAccordionHeight))}
              aria-valuenow={Math.round(paneHeights.graph)}
              data-dragging={draggingSash === 1 ? "true" : undefined}
              onPointerDown={(e) => startSashDrag(1, e)}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  nudgeSash(1, -1);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  nudgeSash(1, 1);
                }
              }}
              className="scm-sash"
            />

            <StashList
              paneId={paneId}
              model={model}
              snap={snap}
              collapsed={snap.collapsedSections.has("stashes")}
              bodyHeight={paneHeights.stashes}
              onToggleCollapse={() => model.toggleSection("stashes")}
            />
          </div>
        </div>
      )}

      {/* Bottom branch & remote sync bar */}
      {status && (
        <div className="scm-footer flex h-8 flex-none items-center justify-between gap-1 border-t border-line px-1.5">
          <div className="min-w-0 flex-1">
            <BranchPicker model={model} snap={snap} compact />
          </div>

          <div className="flex flex-none items-center gap-0.5">
            {status.upstream ? (
              <Tip
                content={`Sync with ${status.upstream} (${status.behind} behind, ${status.ahead} ahead)`}
                side="top"
              >
                <button
                  type="button"
                  aria-label="Sync changes"
                  disabled={Boolean(snap.busyAction)}
                  onClick={() => void model.sync()}
                  className="flex h-6 items-center gap-1 rounded-[5px] px-1.5 font-mono text-micro text-fg-muted hover:bg-hover hover:text-fg-bright disabled:opacity-40"
                >
                  <ArrowDownUp size={11} />
                  <span>
                    ↓{status.behind} ↑{status.ahead}
                  </span>
                </button>
              </Tip>
            ) : (
              <Tip content="Publish branch to remote" side="top">
                <button
                  type="button"
                  aria-label="Publish branch"
                  disabled={Boolean(snap.busyAction) || snap.commits.length === 0}
                  onClick={() => void model.push({ setUpstream: true })}
                  className="flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-micro text-accent hover:bg-hover disabled:opacity-40"
                >
                  <CloudUpload size={11} />
                  <span>Publish</span>
                </button>
              </Tip>
            )}

            <Tip content="Pull" side="top">
              <button
                type="button"
                aria-label="Pull"
                disabled={Boolean(snap.busyAction)}
                onClick={() => void model.pull(false)}
                className="scm-icon-btn h-6 w-6 justify-center disabled:opacity-40"
              >
                <ArrowDown size={11} />
              </button>
            </Tip>

            <Tip content="Push" side="top">
              <button
                type="button"
                aria-label="Push"
                disabled={Boolean(snap.busyAction)}
                onClick={() => void model.push()}
                className="scm-icon-btn h-6 w-6 justify-center disabled:opacity-40"
              >
                <ArrowUp size={11} />
              </button>
            </Tip>
          </div>
        </div>
      )}
    </div>
  );
}

type SectionKind = "conflicts" | "staged" | "changes";

/**
 * Top-level resizable Changes accordion pane. When only unstaged/untracked
 * changes exist, renders rows directly under its header; when conflicts or
 * staged changes are present, renders collapsible sub-groups inside its
 * scrollable body.
 */
function ChangesPane({
  root,
  conflicted,
  staged,
  unstaged,
  model,
  snap,
  collapsed,
  bodyHeight,
  onToggleCollapse,
  onOpenDiff,
  onOpenFile,
}: {
  root: string;
  conflicted: ScmFileChange[];
  staged: ScmFileChange[];
  unstaged: ScmFileChange[];
  model: ScmModel;
  snap: ScmSnapshot;
  collapsed: boolean;
  bodyHeight: number;
  onToggleCollapse: () => void;
  onOpenDiff: (change: ScmFileChange, mode: ScmDiffMode, newPane?: boolean) => void;
  onOpenFile: (change: ScmFileChange) => void;
}) {
  const busy = Boolean(snap.busyAction);
  const totalCount = conflicted.length + staged.length + unstaged.length;
  const hasMultipleGroups = conflicted.length > 0 || staged.length > 0;

  return (
    <section
      data-scm-section="changes"
      className="scm-section flex min-h-0 flex-none flex-col overflow-hidden"
    >
      <div className="scm-section-header group flex h-7 flex-none items-center pr-1.5 pl-2 hover:bg-hover">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-micro font-semibold tracking-wide text-fg-muted uppercase hover:text-fg-bright"
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span className="truncate">Changes</span>
          <span className="rounded-full bg-raised px-1.5 py-px font-mono text-[10px] font-normal text-fg-dim">
            {totalCount}
          </span>
        </button>

        {totalCount > 0 && (
          <div className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {unstaged.length > 0 && (
              <>
                <Tip content="Discard all changes" side="top">
                  <button
                    type="button"
                    aria-label="Discard all changes"
                    disabled={busy}
                    onClick={() => void model.discardAll()}
                    className="scm-row-btn hover:text-err!"
                  >
                    <RotateCcw size={12} />
                  </button>
                </Tip>
                <Tip content={conflicted.length > 0 ? "Stage unstaged changes" : "Stage all changes"} side="top">
                  <button
                    type="button"
                    aria-label="Stage all changes"
                    disabled={busy}
                    onClick={() =>
                      void (conflicted.length > 0 ? model.stage(unstaged.map((c) => c.path)) : model.stageAll())
                    }
                    className="scm-row-btn hover:text-ok!"
                  >
                    <Plus size={12} />
                  </button>
                </Tip>
              </>
            )}
            {unstaged.length === 0 && staged.length > 0 && (
              <Tip content="Unstage all changes" side="top">
                <button
                  type="button"
                  aria-label="Unstage all changes"
                  disabled={busy}
                  onClick={() => void model.unstageAll()}
                  className="scm-row-btn hover:text-warn!"
                >
                  <Minus size={12} />
                </button>
              </Tip>
            )}
          </div>
        )}
      </div>

      {!collapsed && (
        <div style={{ height: bodyHeight }} className="scm-section-body min-h-0 flex-none overflow-y-auto pb-1">
          {!hasMultipleGroups ? (
            <ChangeSection
              id="sub:changes"
              title="Changes"
              changes={unstaged}
              kind="changes"
              root={root}
              model={model}
              snap={snap}
              hideHeader
              onOpenDiff={(c, np) => onOpenDiff(c, c.status === "U" ? "untracked" : "unstaged", np)}
              onOpenFile={onOpenFile}
            />
          ) : (
            <>
              {conflicted.length > 0 && (
                <ChangeSection
                  id="sub:conflicts"
                  title="Merge Conflicts"
                  changes={conflicted}
                  kind="conflicts"
                  root={root}
                  model={model}
                  snap={snap}
                  onOpenDiff={(c) => onOpenFile(c)}
                  onOpenFile={onOpenFile}
                />
              )}
              {staged.length > 0 && (
                <ChangeSection
                  id="sub:staged"
                  title="Staged Changes"
                  changes={staged}
                  kind="staged"
                  root={root}
                  model={model}
                  snap={snap}
                  onOpenDiff={(c, np) => onOpenDiff(c, "staged", np)}
                  onOpenFile={onOpenFile}
                />
              )}
              <ChangeSection
                id="sub:unstaged"
                title="Unstaged Changes"
                changes={unstaged}
                kind="changes"
                root={root}
                model={model}
                snap={snap}
                onOpenDiff={(c, np) => onOpenDiff(c, c.status === "U" ? "untracked" : "unstaged", np)}
                onOpenFile={onOpenFile}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ChangeSection({
  id,
  title,
  changes,
  kind,
  root,
  model,
  snap,
  hideHeader = false,
  onOpenDiff,
  onOpenFile,
}: {
  id: string;
  title: string;
  changes: ScmFileChange[];
  kind: SectionKind;
  root: string;
  model: ScmModel;
  snap: ScmSnapshot;
  hideHeader?: boolean;
  onOpenDiff: (change: ScmFileChange, newPane?: boolean) => void;
  onOpenFile: (change: ScmFileChange) => void;
}) {
  const icons = useActiveIconSet();
  const collapsed = !hideHeader && snap.collapsedSections.has(id);
  const busy = Boolean(snap.busyAction);
  const remote = isRemotePath(root);

  const treeRows = useMemo<ScmTreeNode[]>(() => {
    if (snap.viewMode !== "tree") return [];
    return flattenChangeTree(buildChangeTree(changes), snap.collapsedDirs);
  }, [changes, snap.viewMode, snap.collapsedDirs]);

  const sortedFlat = useMemo(() => {
    if (snap.viewMode !== "list") return [];
    return [...changes].sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  }, [changes, snap.viewMode]);

  const discardSubset = (subset: ScmFileChange[]) => {
    const tracked = subset.filter((c) => c.status !== "U").map((c) => c.path);
    const untracked = subset.filter((c) => c.status === "U").map((c) => c.path);
    void model.discard(tracked, untracked);
  };

  /** Includes both sides (`path` and `origPath`) when unstaging a renamed file. */
  const unstageSubset = (subset: ScmFileChange[]) => {
    const paths = new Set<string>();
    for (const c of subset) {
      paths.add(c.path);
      if (c.origPath) paths.add(c.origPath);
    }
    void model.unstage(Array.from(paths));
  };

  const renderFileRow = (change: ScmFileChange, depth: number, showDir: boolean) => {
    const { name, dir } = splitRelPath(change.path);
    const fullPath = joinPath(root, change.path);
    const isDeleted = change.status === "D";

    return (
      <ContextMenu key={`${kind}:${change.path}`}>
        <ContextMenuTrigger asChild>
          <div
            style={depth > 0 ? { paddingLeft: 10 + depth * 12 } : undefined}
            className="scm-file-row group flex h-[25px] items-center gap-1.5 pr-1.5 pl-2.5 hover:bg-hover"
          >
            <Tip
              content={
                change.origPath
                  ? `${change.origPath} → ${change.path} (${SCM_BADGE_LABEL[change.status]})`
                  : `${change.path} (${SCM_BADGE_LABEL[change.status]})`
              }
              side="right"
              delay={500}
            >
              <button
                type="button"
                onClick={() => onOpenDiff(change, false)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none"
              >
                <FileIcon set={icons.set} light={icons.light} name={name} path={change.path} kind="file" />
                <span
                  className={`truncate text-menu ${
                    isDeleted ? "text-fg-dim line-through" : "text-fg-soft"
                  }`}
                >
                  {name}
                </span>
                {showDir && dir && <span className="min-w-0 flex-1 truncate text-micro text-fg-faint">{dir}</span>}
                {(!showDir || !dir) && <span className="flex-1" />}
              </button>
            </Tip>

            {/* Hover action buttons */}
            <div className="hidden flex-none items-center gap-0.5 group-hover:flex group-focus-within:flex">
              {kind === "conflicts" ? (
                <>
                  <Tip content="Accept Current (Ours)" side="top">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void model.resolveConflict(change.path, "ours");
                      }}
                      className="rounded px-1 py-0.5 text-[10px] font-medium text-ok hover:bg-ok/15 disabled:opacity-40"
                    >
                      Ours
                    </button>
                  </Tip>
                  <Tip content="Accept Incoming (Theirs)" side="top">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void model.resolveConflict(change.path, "theirs");
                      }}
                      className="rounded px-1 py-0.5 text-[10px] font-medium text-info hover:bg-info/15 disabled:opacity-40"
                    >
                      Theirs
                    </button>
                  </Tip>
                  <Tip content="Mark resolved (Stage)" side="top">
                    <button
                      type="button"
                      aria-label={`Stage ${change.path}`}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void model.stage([change.path]);
                      }}
                      className="scm-row-btn"
                    >
                      <Plus size={12} />
                    </button>
                  </Tip>
                </>
              ) : (
                <>
                  {!isDeleted && (
                    <Tip content="Open file" side="top">
                      <button
                        type="button"
                        aria-label={`Open ${change.path}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenFile(change);
                        }}
                        className="scm-row-btn"
                      >
                        <ExternalLink size={11} />
                      </button>
                    </Tip>
                  )}
                  {kind === "changes" && (
                    <>
                      <Tip content="Discard changes" side="top">
                        <button
                          type="button"
                          aria-label={`Discard ${change.path}`}
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            discardSubset([change]);
                          }}
                          className="scm-row-btn hover:text-err!"
                        >
                          <RotateCcw size={11} />
                        </button>
                      </Tip>
                      <Tip content="Stage changes" side="top">
                        <button
                          type="button"
                          aria-label={`Stage ${change.path}`}
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            void model.stage([change.path]);
                          }}
                          className="scm-row-btn hover:text-ok!"
                        >
                          <Plus size={12} />
                        </button>
                      </Tip>
                    </>
                  )}
                  {kind === "staged" && (
                    <Tip content="Unstage changes" side="top">
                      <button
                        type="button"
                        aria-label={`Unstage ${change.path}`}
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          unstageSubset([change]);
                        }}
                        className="scm-row-btn hover:text-warn!"
                      >
                        <Minus size={12} />
                      </button>
                    </Tip>
                  )}
                </>
              )}
            </div>

            <Tip content={SCM_BADGE_LABEL[change.status]} side="left">
              <span
                aria-label={SCM_BADGE_LABEL[change.status]}
                className={`w-3.5 flex-none text-center font-mono text-micro font-semibold ${SCM_BADGE_CLASS[change.status]}`}
              >
                {change.status}
              </span>
            </Tip>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent aria-label={change.path}>
          {kind !== "conflicts" && (
            <>
              <MenuItem onSelect={() => onOpenDiff(change, false)}>Open changes</MenuItem>
              <MenuItem onSelect={() => onOpenDiff(change, true)}>Open changes in new pane</MenuItem>
            </>
          )}
          {!isDeleted && <MenuItem onSelect={() => onOpenFile(change)}>Open file</MenuItem>}
          <MenuSeparator />
          {kind === "conflicts" && (
            <>
              <MenuItem onSelect={() => void model.resolveConflict(change.path, "ours")}>
                Accept current (Ours)
              </MenuItem>
              <MenuItem onSelect={() => void model.resolveConflict(change.path, "theirs")}>
                Accept incoming (Theirs)
              </MenuItem>
              <MenuItem onSelect={() => void model.stage([change.path])}>Mark resolved (Stage)</MenuItem>
            </>
          )}
          {kind === "changes" && (
            <>
              <MenuItem onSelect={() => void model.stage([change.path])}>Stage changes</MenuItem>
              <MenuItem danger onSelect={() => discardSubset([change])}>
                Discard changes…
              </MenuItem>
            </>
          )}
          {kind === "staged" && (
            <MenuItem onSelect={() => unstageSubset([change])}>Unstage changes</MenuItem>
          )}
          <MenuSeparator />
          <MenuItem onSelect={() => copyText(change.path)}>Copy relative path</MenuItem>
          <MenuItem onSelect={() => copyText(posixPathOf(fullPath))}>Copy path</MenuItem>
          {!remote && !isDeleted && (
            <MenuItem onSelect={() => revealInFileManager(fullPath)}>Reveal in Finder</MenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div className={hideHeader ? "" : "border-b border-line/60 last:border-b-0"}>
      {!hideHeader && (
        <div className="scm-subsection-header group flex h-6 items-center pr-1.5 pl-3 hover:bg-hover">
          <button
            type="button"
            onClick={() => model.toggleSection(id)}
            className="flex min-w-0 flex-1 items-center gap-1 text-left text-[10px] font-semibold tracking-wide text-fg-dim uppercase hover:text-fg-bright"
          >
            {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            <span className={`truncate ${kind === "conflicts" ? "text-err" : ""}`}>{title}</span>
            <span
              className={`rounded-full px-1.5 py-px font-mono text-[9.5px] font-normal ${
                kind === "conflicts" ? "bg-err/15 text-err" : "bg-raised text-fg-dim"
              }`}
            >
              {changes.length}
            </span>
          </button>

          {changes.length > 0 && (
            <div className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {kind === "changes" && (
                <>
                  <Tip content="Discard all unstaged changes" side="top">
                    <button
                      type="button"
                      aria-label="Discard all unstaged changes"
                      disabled={busy}
                      onClick={() => discardSubset(changes)}
                      className="scm-row-btn hover:text-err!"
                    >
                      <RotateCcw size={11} />
                    </button>
                  </Tip>
                  <Tip content="Stage all unstaged changes" side="top">
                    <button
                      type="button"
                      aria-label="Stage all unstaged changes"
                      disabled={busy}
                      onClick={() => void model.stage(changes.map((c) => c.path))}
                      className="scm-row-btn hover:text-ok!"
                    >
                      <Plus size={11} />
                    </button>
                  </Tip>
                </>
              )}
              {kind === "staged" && (
                <Tip content="Unstage all changes" side="top">
                  <button
                    type="button"
                    aria-label="Unstage all changes"
                    disabled={busy}
                    onClick={() => void model.unstageAll()}
                    className="scm-row-btn hover:text-warn!"
                  >
                    <Minus size={11} />
                  </button>
                </Tip>
              )}
            </div>
          )}
        </div>
      )}

      {!collapsed && (
        <div className={hideHeader ? "" : "pb-0.5"}>
          {changes.length === 0 ? (
            <div className="px-3 py-2 text-meta text-fg-faint">
              {kind === "changes" && !hideHeader ? "No unstaged changes" : "Working tree clean"}
            </div>
          ) : snap.viewMode === "list" ? (
            sortedFlat.map((change) => renderFileRow(change, 0, true))
          ) : (
            treeRows.map((node) => {
              if (node.kind === "file") {
                return renderFileRow(node.change, node.depth, false);
              }
              const dirCollapsed = snap.collapsedDirs.has(node.path);
              return (
                <div
                  key={`dir:${kind}:${node.path}`}
                  style={{ paddingLeft: 10 + node.depth * 12 }}
                  className="group flex h-[25px] items-center gap-1 pr-1.5 hover:bg-hover"
                >
                  <button
                    type="button"
                    onClick={() => model.toggleDir(node.path)}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left outline-none"
                  >
                    {dirCollapsed ? (
                      <ChevronRight size={12} className="flex-none text-fg-dim" />
                    ) : (
                      <ChevronDown size={12} className="flex-none text-fg-dim" />
                    )}
                    <FileIcon
                      set={icons.set}
                      light={icons.light}
                      name={node.label.split("/").pop() ?? node.label}
                      path={node.path}
                      kind="dir"
                      expanded={!dirCollapsed}
                    />
                    <span className="truncate text-menu text-fg-mid">{node.label}</span>
                    <span className="flex-none font-mono text-[10px] text-fg-faint">{node.files.length}</span>
                  </button>

                  <div className="hidden flex-none items-center gap-0.5 group-hover:flex group-focus-within:flex">
                    {kind === "changes" && (
                      <>
                        <Tip content={`Discard all changes in ${node.path}`} side="top">
                          <button
                            type="button"
                            aria-label={`Discard folder ${node.path}`}
                            disabled={busy}
                            onClick={() => discardSubset(node.files)}
                            className="scm-row-btn hover:text-err!"
                          >
                            <RotateCcw size={11} />
                          </button>
                        </Tip>
                        <Tip content={`Stage all changes in ${node.path}`} side="top">
                          <button
                            type="button"
                            aria-label={`Stage folder ${node.path}`}
                            disabled={busy}
                            onClick={() => void model.stage(node.files.map((f) => f.path))}
                            className="scm-row-btn hover:text-ok!"
                          >
                            <Plus size={12} />
                          </button>
                        </Tip>
                      </>
                    )}
                    {kind === "staged" && (
                      <Tip content={`Unstage all changes in ${node.path}`} side="top">
                        <button
                          type="button"
                          aria-label={`Unstage folder ${node.path}`}
                          disabled={busy}
                          onClick={() => unstageSubset(node.files)}
                          className="scm-row-btn hover:text-warn!"
                        >
                          <Minus size={12} />
                        </button>
                      </Tip>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
