import DOMPurify from "dompurify";
import { marked } from "marked";

/*
 * Markdown to safe HTML for viewer panes: `marked` (GitHub-flavoured) and
 * DOMPurify. Inline styles and <style> are dropped, and nothing in the
 * result loads anything by itself: every resource attribute is removed
 * except an image's source, which is kept inert in `data-src` for the
 * viewer to resolve (local files are read through the backend; remote
 * images are not loaded). `file:` links, which the sanitizer would strip,
 * are kept in `data-file-href`.
 */

/** Attributes through which an element can fetch something. */
const RESOURCE_ATTRIBUTES = ["src", "srcset", "poster", "background", "data", "href", "xlink:href", "action", "formaction"];

DOMPurify.addHook("beforeSanitizeAttributes", (node) => {
  if (!(node instanceof Element)) return;
  if (node.tagName === "A") {
    const href = node.getAttribute("href");
    if (href && /^file:/i.test(href.trim())) {
      node.setAttribute("data-file-href", href);
      node.removeAttribute("href");
    }
    node.removeAttribute("target");
    return;
  }
  const src = node.tagName === "IMG" ? node.getAttribute("src") : null;
  for (const name of RESOURCE_ATTRIBUTES) node.removeAttribute(name);
  if (src) node.setAttribute("data-src", src);
});

const FORBID_TAGS = [
  "style",
  "form",
  "button",
  "textarea",
  "select",
  "video",
  "audio",
  "source",
  "track",
  "picture",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "svg",
  "math",
];

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, async: false }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS, FORBID_ATTR: ["style"] });
}
