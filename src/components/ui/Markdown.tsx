import { type MouseEvent, useMemo } from "react";
import { openExternal } from "../../ipc/shell";
import { renderMarkdown } from "../../viewer/markdown";

/**
 * A sanitized Markdown block (`renderMarkdown`: marked + DOMPurify; images
 * stay inert). `compact` tightens the viewer's spacing for small panels.
 * Clicking an http(s) link opens it in the browser; other links do nothing.
 */
export function Markdown({ text, compact = false, className = "" }: { text: string; compact?: boolean; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as Element).closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:/i.test(href.trim())) openExternal(href.trim());
  };
  return (
    <div
      className={`markdown-body${compact ? " markdown-compact" : ""}${className ? ` ${className}` : ""}`}
      onClick={onClick}
      // Sanitized by DOMPurify in src/viewer/markdown.ts.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
