import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Download, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Tip } from "../components/ui/Tooltip";
import { FileIcon } from "../icons/FileIcon";
import { useActiveIconSet } from "../icons/state";
import type { ScmCommitFile, ScmStash } from "../ipc/scm";
import type { ScmModel, ScmSnapshot } from "./model";
import { openScmDiff } from "./registry";
import { formatRelativeTime, SCM_BADGE_CLASS, SCM_BADGE_LABEL, splitRelPath } from "./tree";

type Props = {
  paneId: string;
  model: ScmModel;
  snap: ScmSnapshot;
  collapsed: boolean;
  bodyHeight: number;
  onToggleCollapse: () => void;
};

export function StashList({ paneId, model, snap, collapsed, bodyHeight, onToggleCollapse }: Props) {
  const icons = useActiveIconSet();
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [expandedOid, setExpandedOid] = useState<string | null>(null);
  const [loadingOid, setLoadingOid] = useState<string | null>(null);

  const canStash =
    Boolean(snap.status) &&
    (snap.status!.staged.length > 0 || snap.status!.unstaged.length > 0 || snap.status!.untracked.length > 0);

  const submitStash = async () => {
    const ok = await model.stashPush(message, { includeUntracked });
    if (ok) {
      setMessage("");
      setIncludeUntracked(false);
      setComposing(false);
    }
  };

  const toggleStash = async (stash: ScmStash) => {
    if (expandedOid === stash.oid) {
      setExpandedOid(null);
      return;
    }
    setExpandedOid(stash.oid);
    if (!snap.stashFiles[stash.oid]) {
      setLoadingOid(stash.oid);
      try {
        await model.loadStashFiles(stash);
      } catch (error) {
        model.showError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoadingOid((cur) => (cur === stash.oid ? null : cur));
      }
    }
  };

  const openStashFile = (stash: ScmStash, file: ScmCommitFile) => {
    if (!snap.status) return;
    openScmDiff({
      fromPaneId: paneId,
      target: {
        root: snap.status.root,
        filePath: file.path,
        oldPath: file.origPath,
        mode: "stash",
        commitHash: stash.reference,
        label: stash.reference,
      },
    });
  };

  return (
    <section
      data-scm-section="stashes"
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
          <span className="truncate">Stashes</span>
          {snap.stashes.length > 0 && (
            <span className="rounded-full bg-raised px-1.5 py-px font-mono text-[10px] font-normal text-fg-dim">
              {snap.stashes.length}
            </span>
          )}
        </button>

        <Tip content="Stash changes…" side="top">
          <button
            type="button"
            aria-label="Stash changes"
            disabled={!canStash || Boolean(snap.busyAction)}
            onClick={() => {
              if (collapsed) onToggleCollapse();
              setComposing((v) => !v);
            }}
            className="flex rounded p-1 text-fg-dim hover:bg-raised hover:text-fg-bright disabled:opacity-35"
          >
            <Plus size={12} />
          </button>
        </Tip>
      </div>

      {!collapsed && (
        <div style={{ height: bodyHeight }} className="scm-section-body min-h-0 flex-none overflow-y-auto pb-1">
          {composing && (
            <div className="mx-2 mb-1.5 flex flex-col gap-1.5 rounded-[6px] border border-line-strong bg-field p-2">
              <input
                autoFocus
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitStash();
                  else if (e.key === "Escape") {
                    e.stopPropagation();
                    setComposing(false);
                  }
                }}
                placeholder="Optional stash message…"
                aria-label="Stash message"
                className="h-6 rounded border border-line-input bg-popover px-2 text-meta text-fg-bright placeholder:text-fg-faint outline-none focus:border-accent"
              />
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-micro text-fg-muted">
                  <input
                    type="checkbox"
                    checked={includeUntracked}
                    onChange={(e) => setIncludeUntracked(e.target.checked)}
                    className="accent-[var(--color-accent)]"
                  />
                  <span>Include untracked</span>
                </label>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setComposing(false)}
                    className="h-6 rounded px-2 text-micro text-fg-muted hover:bg-hover hover:text-fg-bright"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(snap.busyAction)}
                    onClick={() => void submitStash()}
                    className="h-6 rounded bg-accent/20 px-2 text-micro font-medium text-accent-fg hover:bg-accent/30 disabled:opacity-40"
                  >
                    Stash
                  </button>
                </div>
              </div>
            </div>
          )}

          {snap.stashes.length === 0 ? (
            <div className="px-3 py-2 text-meta text-fg-faint">No stashes</div>
          ) : (
            snap.stashes.map((stash) => {
              const isExpanded = expandedOid === stash.oid;
              const files = snap.stashFiles[stash.oid];
              const isLoading = loadingOid === stash.oid && !files;

              return (
                <div key={stash.oid || stash.reference}>
                  <div className="group flex h-7 items-center gap-1 pr-1.5 pl-2 hover:bg-hover">
                    <button
                      type="button"
                      onClick={() => void toggleStash(stash)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <Archive size={12} className="flex-none text-fg-dim" />
                      <span className="min-w-0 flex-1 truncate text-menu text-fg-soft">{stash.message}</span>
                      {stash.branch && (
                        <span className="max-w-[70px] flex-none truncate rounded bg-raised px-1 py-px font-mono text-[9.5px] text-fg-dim">
                          {stash.branch}
                        </span>
                      )}
                      <span className="flex-none text-micro text-fg-faint group-hover:hidden">
                        {formatRelativeTime(stash.date)}
                      </span>
                    </button>

                    <div className="hidden flex-none items-center gap-0.5 group-hover:flex group-focus-within:flex">
                      <Tip content={`Pop ${stash.reference} (apply and remove)`} side="top">
                        <button
                          type="button"
                          aria-label={`Pop ${stash.reference}`}
                          disabled={Boolean(snap.busyAction)}
                          onClick={() => void model.stashApply(stash.index, true)}
                          className="flex rounded p-1 text-fg-dim hover:bg-raised hover:text-fg-bright disabled:opacity-40"
                        >
                          <ArchiveRestore size={12} />
                        </button>
                      </Tip>
                      <Tip content={`Apply ${stash.reference} (keep stash)`} side="top">
                        <button
                          type="button"
                          aria-label={`Apply ${stash.reference}`}
                          disabled={Boolean(snap.busyAction)}
                          onClick={() => void model.stashApply(stash.index, false)}
                          className="flex rounded p-1 text-fg-dim hover:bg-raised hover:text-fg-bright disabled:opacity-40"
                        >
                          <Download size={12} />
                        </button>
                      </Tip>
                      <Tip content={`Drop ${stash.reference}`} side="top">
                        <button
                          type="button"
                          aria-label={`Drop ${stash.reference}`}
                          disabled={Boolean(snap.busyAction)}
                          onClick={() => void model.stashDrop(stash)}
                          className="flex rounded p-1 text-fg-dim hover:bg-err/15 hover:text-err disabled:opacity-40"
                        >
                          <Trash2 size={12} />
                        </button>
                      </Tip>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-y border-line/60 bg-field/60 py-1 pr-2 pl-6">
                      {isLoading ? (
                        <div className="flex items-center gap-1.5 py-1 text-micro text-fg-faint">
                          <Loader2 size={11} className="animate-spin" />
                          <span>Loading stash files…</span>
                        </div>
                      ) : files && files.length > 0 ? (
                        files.map((file) => {
                          const { name, dir } = splitRelPath(file.path);
                          return (
                            <button
                              key={file.path}
                              type="button"
                              onClick={() => openStashFile(stash, file)}
                              className="flex h-6 w-full items-center gap-1.5 rounded px-1 text-left hover:bg-hover"
                            >
                              <FileIcon set={icons.set} light={icons.light} name={name} path={file.path} kind="file" />
                              <span className="truncate text-meta text-fg-soft">{name}</span>
                              {dir && <span className="min-w-0 flex-1 truncate text-micro text-fg-faint">{dir}</span>}
                              {!dir && <span className="flex-1" />}
                              <span
                                aria-label={SCM_BADGE_LABEL[file.status]}
                                className={`w-3 flex-none text-center font-mono text-micro font-semibold ${SCM_BADGE_CLASS[file.status]}`}
                              >
                                {file.status}
                              </span>
                            </button>
                          );
                        })
                      ) : (
                        <div className="py-1 text-micro text-fg-faint">No file changes in this stash</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
