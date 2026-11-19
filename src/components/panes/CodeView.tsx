import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { registerPaneActions } from "../../commands/registry";
import type { EditorModel, EditorSnapshot } from "../../editor/model";
import { breadcrumbSegments } from "../../editor/text";
import { homeDirectory } from "../../ipc/system";
import { registerPaneFocuser } from "../../layout/dock";
import { StatusMessage } from "./FileStatus";

/** Code in CodeMirror: editable in editors, read-only for text in viewers. */
export function CodeView({ paneId, model }: { paneId: string; model: EditorModel }) {
  const snap = useSyncExternalStore(model.subscribe, model.snapshot);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const ready = snap.status === "ready";

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    model.attach(body);
    return () => model.detach();
  }, [model]);

  useEffect(
    () =>
      registerPaneFocuser(paneId, () => {
        if (ready) model.focus();
        else rootRef.current?.focus({ preventScroll: true });
      }),
    [paneId, model, ready],
  );

  useEffect(() => {
    if (!ready) return;
    return registerPaneActions(paneId, {
      find: model.find,
      findNext: model.findNext,
      findPrevious: model.findPrevious,
      goToLine: model.goToLine,
      save: model.readOnly ? undefined : model.save,
    });
  }, [paneId, model, ready]);

  return (
    <div ref={rootRef} tabIndex={-1} className="flex h-full flex-col outline-none">
      <Breadcrumbs snap={snap} />
      <EditorNotice model={model} snap={snap} />
      <div ref={bodyRef} className="min-h-0 flex-1" hidden={!ready} />
      {!ready && <StatusMessage status={snap.status} path={snap.path} size={snap.size} error={snap.error} />}
    </div>
  );
}

/** The 28px path row from the mockup: `src › components › SplitNode.tsx`. */
function Breadcrumbs({ snap }: { snap: EditorSnapshot }) {
  const segments = breadcrumbSegments(snap.path, { repoRoot: snap.repoRoot, home: homeDirectory() });
  const last = segments.length - 1;
  return (
    <div
      className="flex h-7 flex-none items-center gap-1.5 overflow-hidden pr-16 pl-4 text-crumb whitespace-nowrap text-fg-dim"
      title={snap.path}
    >
      {segments.map((segment, index) => (
        <span key={index} className={`flex items-center gap-1.5 ${index === last ? "min-w-0" : "flex-none"}`}>
          {index > 0 && <span aria-hidden="true">›</span>}
          <span className={index === last ? "truncate text-fg-soft" : undefined}>{segment}</span>
        </span>
      ))}
      {snap.dirty && (
        <span className="flex-none text-fg-mid" title="Unsaved changes" aria-label="Unsaved changes">
          ●
        </span>
      )}
      {snap.readOnly && <span className="flex-none text-fg-faint">read-only</span>}
    </div>
  );
}

function NoticeButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="h-5 flex-none rounded-[4px] px-2 text-fg-soft hover:bg-fg-bright/8"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Non-modal notices: the file changed on disk, or saving failed. */
function EditorNotice({ model, snap }: { model: EditorModel; snap: EditorSnapshot }) {
  let text: string;
  let actions: ReactNode;
  if (snap.external === "changed") {
    text = "Changed on disk. You have unsaved changes.";
    actions = (
      <>
        <NoticeButton onClick={model.revert}>Reload</NoticeButton>
        <NoticeButton onClick={() => void model.keepMine()}>Keep mine</NoticeButton>
      </>
    );
  } else if (snap.external === "deleted") {
    text = model.readOnly ? "Deleted on disk." : "Deleted on disk. Saving creates it again.";
    actions = null;
  } else if (snap.error && snap.status === "ready") {
    text = snap.error;
    actions = <NoticeButton onClick={model.dismissError}>Dismiss</NoticeButton>;
  } else {
    return null;
  }
  return (
    <div className="flex h-7 flex-none items-center gap-2 border-y border-warn/20 bg-warn/10 pr-2 pl-4 text-meta text-warn">
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      {actions}
    </div>
  );
}

