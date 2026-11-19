import { type MouseEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { openFile, updatePaneData } from "../../actions";
import { registerPaneActions } from "../../commands/registry";
import "../../editor/commands";
import { EditorModel, type EditorSnapshot } from "../../editor/model";
import { type FileModel, acquireFileModel, releaseFileModel } from "../../editor/registry";
import { breadcrumbSegments } from "../../editor/text";
import { baseName, parentPath } from "../../explorer/tree";
import { isMarkdownPath } from "../../files/kinds";
import { openExternal } from "../../ipc/shell";
import { homeDirectory } from "../../ipc/system";
import { registerPaneFocuser } from "../../layout/dock";
import { PANE_LABELS } from "../../state/layout";
import { headingSlug, resolveImage, resolveLink } from "../../viewer/links";
import type { ViewerModel } from "../../viewer/model";

type FileKind = "editor" | "viewer";

/**
 * An editor or viewer pane. The file's state lives in a model owned by the
 * registry (src/editor/registry.ts); this component only shows it.
 */
export function FilePane({ paneId, kind, path }: { paneId: string; kind: FileKind; path?: string }) {
  if (!path) return <NoFile paneId={paneId} kind={kind} />;
  // A new kind or file means a new model, so start over.
  return <FileModelPane key={`${kind}:${path}`} paneId={paneId} kind={kind} path={path} />;
}

function FileModelPane({ paneId, kind, path }: { paneId: string; kind: FileKind; path: string }) {
  const [model, setModel] = useState<FileModel | null>(null);

  useEffect(() => {
    const acquired = acquireFileModel(paneId, kind, path);
    setModel(acquired);
    return () => releaseFileModel(acquired);
  }, [paneId, kind, path]);

  if (!model) return null;
  return model instanceof EditorModel ? (
    <CodeView paneId={paneId} model={model} />
  ) : (
    <DocumentView paneId={paneId} model={model} />
  );
}

/** Code in CodeMirror: editable in editors, read-only for text in viewers. */
function CodeView({ paneId, model }: { paneId: string; model: EditorModel }) {
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
      className="h-5 flex-none rounded-[4px] px-2 text-fg-soft hover:bg-white/[0.08]"
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What the pane shows instead of the file while it cannot be shown. */
function StatusMessage({
  status,
  path,
  size,
  error,
}: {
  status: string;
  path: string;
  size: number | null;
  error: string | null;
}) {
  if (status === "loading") return <div className="flex-1" />;
  const [title, detail] =
    status === "missing"
      ? ["File not found", path]
      : status === "binary"
        ? ["Binary file", size === null ? "Not shown" : `${formatSize(size)}, not shown`]
        : status === "tooLarge"
          ? ["Too large to open", size === null ? path : formatSize(size)]
          : ["Could not open the file", error ?? path];
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
      <div className="font-medium text-fg-mid">{title}</div>
      <div className="max-w-full truncate text-meta text-fg-dim" title={detail}>
        {detail}
      </div>
    </div>
  );
}

/** Rendered Markdown or an image, with the file name top-right as in the mockup. */
function DocumentView({ paneId, model }: { paneId: string; model: ViewerModel }) {
  const snap = useSyncExternalStore(model.subscribe, model.snapshot);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<string | null>(null);

  useEffect(() => {
    model.attach();
    return () => model.detach();
  }, [model]);

  useEffect(
    () => registerPaneFocuser(paneId, () => scrollRef.current?.focus({ preventScroll: true })),
    [paneId],
  );

  // Back where it was after a remount.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = model.scrollTop;
  }, [model, snap.html, snap.imageUrl]);

  // Images in the document: local files are read through the backend.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !snap.html) return;
    let cancelled = false;
    for (const img of content.querySelectorAll<HTMLImageElement>("img[data-src]")) {
      const source = resolveImage(img.dataset.src ?? "", parentPath(model.path));
      if (source?.type === "inline") img.src = img.dataset.src ?? "";
      else if (source?.type === "file") {
        void model.imageUrl(source.path).then((url) => {
          if (url && !cancelled) img.src = url;
        });
      }
    }
    return () => {
      cancelled = true;
    };
  }, [model, snap.html]);

  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as Element).closest("a");
    if (!anchor) return;
    event.preventDefault();
    const target = resolveLink(anchor.getAttribute("href") ?? "", parentPath(model.path));
    if (!target) return;
    if (target.type === "external") openExternal(target.url);
    else if (target.type === "anchor") {
      const headings = contentRef.current?.querySelectorAll("h1, h2, h3, h4, h5, h6") ?? [];
      const id = target.id.toLowerCase();
      const heading = [...headings].find((element) => headingSlug(element.textContent ?? "") === id);
      heading?.scrollIntoView({ block: "start" });
    } else if (isMarkdownPath(target.path) && !event.metaKey && target.line === undefined) {
      // Markdown links navigate within the viewer.
      updatePaneData(paneId, { path: target.path });
    } else {
      openFile(target.path, { fromPaneId: paneId, newPane: event.metaKey, line: target.line });
    }
  };

  const label = snap.mode === "image" && dimensions ? `${baseName(snap.path)} · ${dimensions}` : baseName(snap.path);

  return (
    <div className="relative h-full">
      <div className="viewer-name pointer-events-none absolute top-2 z-[1] font-mono text-micro text-fg-dim">
        {label}
      </div>
      <div
        ref={scrollRef}
        tabIndex={-1}
        className="h-full overflow-auto outline-none"
        onScroll={(event) => {
          model.scrollTop = event.currentTarget.scrollTop;
        }}
      >
        {snap.status !== "ready" ? (
          <div className="flex h-full flex-col">
            <StatusMessage status={snap.status} path={snap.path} size={snap.size} error={snap.error} />
          </div>
        ) : snap.mode === "markdown" ? (
          <div
            ref={contentRef}
            className="markdown-body px-[22px] py-[18px]"
            onClick={onClick}
            // Sanitized by DOMPurify in src/viewer/markdown.ts.
            dangerouslySetInnerHTML={{ __html: snap.html ?? "" }}
          />
        ) : (
          <div className="viewer-image flex h-full items-center justify-center p-6">
            {snap.imageUrl && (
              <img
                src={snap.imageUrl}
                alt={baseName(snap.path)}
                className="max-h-full max-w-full object-contain"
                onLoad={(event) =>
                  setDimensions(`${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`)
                }
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** An editor or viewer pane with no file (e.g. just changed to this type). */
function NoFile({ paneId, kind }: { paneId: string; kind: FileKind }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(
    () => registerPaneFocuser(paneId, () => ref.current?.focus({ preventScroll: true })),
    [paneId],
  );
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center outline-none"
    >
      <div className="font-medium text-fg-mid">{PANE_LABELS[kind]}</div>
      <div className="text-meta text-fg-dim">No file open. Open one from the explorer.</div>
    </div>
  );
}
