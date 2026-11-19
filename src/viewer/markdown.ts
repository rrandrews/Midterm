import DOMPurify from "dompurify";
import { marked } from "marked";

/*
 * Markdown to safe HTML for viewer panes: `marked` (GitHub-flavoured) and
 * DOMPurify. Inline styles and <style> are dropped, and image sources are
 * moved to `data-src`, so nothing is fetched until the viewer resolves them
 * (local files are read through the backend; remote images are not loaded).
 */

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src");
    node.removeAttribute("src");
    node.removeAttribute("srcset");
    if (src) node.setAttribute("data-src", src);
  } else if (node.tagName === "A") {
    node.removeAttribute("target");
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, async: false }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "button", "textarea", "select"],
    FORBID_ATTR: ["style"],
  });
}
