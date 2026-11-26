import { Check, ChevronDown, GitBranch, GitMerge, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Tip } from "../components/ui/Tooltip";
import type { ScmBranch } from "../ipc/scm";
import type { ScmModel, ScmSnapshot } from "./model";
import { formatRelativeTime } from "./tree";

type Props = {
  model: ScmModel;
  snap: ScmSnapshot;
  compact?: boolean;
};

export function BranchPicker({ model, snap, compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const status = snap.status;
  const branchLabel = status?.branch ?? (status?.headOid ? `detached (${status.headOid.slice(0, 7)})` : "HEAD");

  useEffect(() => {
    if (!open) {
      setQuery("");
      setCreating(false);
      setNewName("");
      setRenaming(null);
      setRenameValue("");
      return;
    }
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (creating) requestAnimationFrame(() => createRef.current?.focus());
  }, [creating]);

  useEffect(() => {
    if (renaming) requestAnimationFrame(() => renameRef.current?.select());
  }, [renaming]);

  const { locals, remotes } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (b: ScmBranch) => !q || b.name.toLowerCase().includes(q) || b.commitSubject.toLowerCase().includes(q);
    const localList = snap.branches.filter((b) => !b.remote && matches(b));
    const remoteList = snap.branches.filter((b) => Boolean(b.remote) && matches(b));
    return { locals: localList, remotes: remoteList };
  }, [snap.branches, query]);

  const startCreate = () => {
    setRenaming(null);
    setNewName(query.trim().replace(/\s+/g, "-"));
    setCreating(true);
  };

  const submitCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const ok = await model.checkout(trimmed, { create: true });
    if (ok) setOpen(false);
  };

  const submitRename = async (oldName: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === oldName) {
      setRenaming(null);
      return;
    }
    const ok = await model.renameBranch(oldName, trimmed);
    if (ok) setRenaming(null);
  };

  const switchTo = async (name: string) => {
    const ok = await model.checkout(name);
    if (ok) setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip content={`Switch branch (${branchLabel})`} side="top" disabled={open}>
        <Popover.Trigger asChild>
          <button
            type="button"
            disabled={!status || Boolean(snap.busyAction)}
            className={`scm-branch-trigger flex min-w-0 items-center gap-1.5 rounded-[5px] text-left text-fg-soft outline-none hover:bg-hover hover:text-fg-bright disabled:opacity-45 ${
              compact ? "h-6 px-1.5 text-meta" : "h-7 px-2 text-menu"
            }`}
          >
            <GitBranch size={12} strokeWidth={1.9} className="flex-none text-accent" />
            <span className="min-w-0 truncate font-medium">{branchLabel}</span>
            <ChevronDown size={11} className="flex-none text-fg-dim" />
          </button>
        </Popover.Trigger>
      </Tip>

      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 flex w-[308px] max-w-[92vw] flex-col rounded-lg bg-popover p-2 shadow-menu outline-none select-none"
        >
          <div className="flex items-center gap-1.5 rounded-[6px] border border-line-input bg-field px-2 py-1">
            <Search size={12} className="flex-none text-fg-dim" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setOpen(false);
                } else if (e.key === "Enter" && locals.length === 0 && remotes.length === 0 && query.trim()) {
                  startCreate();
                }
              }}
              placeholder="Filter branches…"
              aria-label="Filter branches"
              className="min-w-0 flex-1 bg-transparent text-menu text-fg-bright placeholder:text-fg-faint outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setQuery("")}
                className="flex rounded p-0.5 text-fg-dim hover:bg-hover hover:text-fg-bright"
              >
                <X size={11} />
              </button>
            )}
          </div>

          {creating ? (
            <div className="mt-2 flex flex-col gap-1.5 rounded-[6px] border border-line-strong bg-field p-2">
              <div className="text-micro font-medium text-fg-muted">Create new branch from {branchLabel}</div>
              <input
                ref={createRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitCreate();
                  else if (e.key === "Escape") {
                    e.stopPropagation();
                    setCreating(false);
                  }
                }}
                placeholder="feature/my-branch"
                aria-label="New branch name"
                className="h-7 rounded-[5px] border border-line-input bg-popover px-2 font-mono text-menu text-fg-bright placeholder:text-fg-faint outline-none focus:border-accent"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="h-6 rounded-[5px] px-2 text-meta text-fg-muted hover:bg-hover hover:text-fg-bright"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!newName.trim() || Boolean(snap.busyAction)}
                  onClick={() => void submitCreate()}
                  className="h-6 rounded-[5px] bg-accent/20 px-2.5 text-meta font-medium text-accent-fg hover:bg-accent/30 disabled:opacity-40"
                >
                  Create & switch
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={startCreate}
              className="mt-1.5 flex h-7 w-full items-center gap-2 rounded-[5px] px-2 text-left text-menu text-accent hover:bg-hover"
            >
              <Plus size={13} />
              <span className="truncate">
                {query.trim() ? `Create branch “${query.trim()}”…` : "Create new branch…"}
              </span>
            </button>
          )}

          <div className="mt-1.5 max-h-[280px] overflow-y-auto pr-0.5">
            {locals.length > 0 && (
              <div className="mb-1">
                <div className="px-2 py-1 text-micro font-medium tracking-wide text-fg-faint uppercase">
                  Local ({locals.length})
                </div>
                {locals.map((b) => {
                  const isRenaming = renaming === b.name;
                  return (
                    <div
                      key={b.name}
                      className="scm-branch-row group flex items-center gap-1.5 rounded-[5px] px-2 py-1 hover:bg-hover"
                    >
                      {isRenaming ? (
                        <div className="flex min-w-0 flex-1 items-center gap-1">
                          <input
                            ref={renameRef}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void submitRename(b.name);
                              else if (e.key === "Escape") {
                                e.stopPropagation();
                                setRenaming(null);
                              }
                            }}
                            aria-label={`Rename branch ${b.name}`}
                            className="h-6 min-w-0 flex-1 rounded border border-accent bg-field px-1.5 font-mono text-meta text-fg-bright outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => void submitRename(b.name)}
                            className="rounded px-1.5 py-0.5 text-micro font-medium text-accent hover:bg-accent-soft"
                          >
                            Save
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              if (!b.current) void switchTo(b.name);
                              else setOpen(false);
                            }}
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none"
                          >
                            <span className="flex w-3.5 flex-none justify-center text-accent">
                              {b.current ? <Check size={12} /> : <GitBranch size={11} className="text-fg-dim" />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className={`truncate font-mono text-menu ${
                                    b.current ? "font-semibold text-fg-bright" : "text-fg-soft"
                                  }`}
                                >
                                  {b.name}
                                </span>
                                {(b.ahead > 0 || b.behind > 0) && (
                                  <span className="flex-none font-mono text-micro text-fg-dim">
                                    {b.ahead > 0 ? `↑${b.ahead}` : ""}
                                    {b.behind > 0 ? `↓${b.behind}` : ""}
                                  </span>
                                )}
                              </div>
                              {b.commitSubject && (
                                <div className="truncate text-micro text-fg-faint">
                                  {b.commitHash} · {b.commitSubject}
                                  {b.commitDate ? ` · ${formatRelativeTime(b.commitDate)}` : ""}
                                </div>
                              )}
                            </div>
                          </button>

                          <div className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            {!b.current && (
                              <Tip content={`Merge ${b.name} into ${branchLabel}`} side="top">
                                <button
                                  type="button"
                                  aria-label={`Merge ${b.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpen(false);
                                    void model.mergeBranch(b.name);
                                  }}
                                  className="flex rounded p-1 text-fg-dim hover:bg-raised hover:text-fg-bright"
                                >
                                  <GitMerge size={12} />
                                </button>
                              </Tip>
                            )}
                            <Tip content="Rename branch" side="top">
                              <button
                                type="button"
                                aria-label={`Rename ${b.name}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCreating(false);
                                  setRenameValue(b.name);
                                  setRenaming(b.name);
                                }}
                                className="flex rounded p-1 text-fg-dim hover:bg-raised hover:text-fg-bright"
                              >
                                <Pencil size={12} />
                              </button>
                            </Tip>
                            {!b.current && (
                              <Tip content="Delete branch" side="top">
                                <button
                                  type="button"
                                  aria-label={`Delete ${b.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void model.deleteBranch(b.name);
                                  }}
                                  className="flex rounded p-1 text-fg-dim hover:bg-err/15 hover:text-err"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </Tip>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {remotes.length > 0 && (
              <div>
                <div className="px-2 py-1 text-micro font-medium tracking-wide text-fg-faint uppercase">
                  Remote ({remotes.length})
                </div>
                {remotes.map((b) => (
                  <button
                    key={b.name}
                    type="button"
                    onClick={() => void switchTo(b.name)}
                    className="flex w-full items-center gap-1.5 rounded-[5px] px-2 py-1 text-left hover:bg-hover"
                  >
                    <GitBranch size={11} className="flex-none text-info" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-menu text-fg-mid">{b.name}</div>
                      {b.commitSubject && (
                        <div className="truncate text-micro text-fg-faint">
                          {b.commitHash} · {b.commitSubject}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {locals.length === 0 && remotes.length === 0 && (
              <div className="px-2 py-4 text-center text-meta text-fg-faint">No matching branches</div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
