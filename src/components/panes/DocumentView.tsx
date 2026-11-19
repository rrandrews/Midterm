import { type MouseEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { openFile, updatePaneData } from "../../actions";
import { baseName, parentPath } from "../../explorer/tree";
import { isMarkdownPath } from "../../files/kinds";
import { openExternal } from "../../ipc/shell";
import { registerPaneFocuser } from "../../layout/dock";
import { headingSlug, resolveImage, resolveLink } from "../../viewer/links";
import type { ViewerModel } from "../../viewer/model";
import { StatusMessage } from "./FileStatus";

/** Rendered Markdown or an image, with the file name top-right as in the mockup. */
export function DocumentView({ paneId, model }: { paneId: string; model: ViewerModel }) {
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
  }, [model, snap.html, snap.revision]);

  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as Element).closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? anchor.dataset.fileHref ?? "";
    const target = resolveLink(href, parentPath(model.path));
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

