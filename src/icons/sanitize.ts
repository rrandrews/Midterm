import createDOMPurify, { type DOMPurify } from "dompurify";

/*
 * Icon SVG from theme and icon set files is untrusted. The main guarantee
 * is how it is drawn: as an image (`<img src="data:…">` or a CSS mask),
 * where SVG runs no script and loads nothing. This is a second layer, so a
 * stored icon is harmless even if it ends up somewhere else:
 *
 * - DOMPurify with the SVG profile, without <style>, <foreignObject>,
 *   <image>, <a> and <script>;
 * - then the icon is dropped unless its root is <svg>, every href points
 *   inside the document (`#id`) and every `url(…)` is `url(#id)`.
 *
 * A dedicated DOMPurify instance: the default one carries the Markdown
 * viewer's hooks (src/viewer/markdown.ts).
 */

/** Largest icon accepted, in characters. */
export const MAX_ICON_LENGTH = 64 * 1024;

const SVG_NS = "http://www.w3.org/2000/svg";

let purifier: DOMPurify | null = null;

function instance(): DOMPurify {
  purifier ??= createDOMPurify(window);
  return purifier;
}

const LOCAL_URL = /url\(\s*(['"]?)#[^)]*\1\s*\)/gi;

function safeAttributes(element: Element): boolean {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim();
    if ((name === "href" || name.endsWith(":href")) && !value.startsWith("#")) return false;
    if (/url\s*\(/i.test(value.replace(LOCAL_URL, ""))) return false;
  }
  return true;
}

/** Sanitized SVG markup (with an `xmlns`, so it renders as a data URL), or null when it is not a safe SVG icon. */
export function sanitizeSvg(text: string): string | null {
  if (typeof text !== "string" || text.length > MAX_ICON_LENGTH) return null;
  let clean = instance().sanitize(text.trim(), {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["style", "foreignObject", "image", "a", "script"],
  });
  clean = clean.trim();
  if (!/^<svg[\s>]/i.test(clean)) return null;
  if (!/^<svg[^>]*\sxmlns=/i.test(clean)) clean = clean.replace(/^<svg/i, `<svg xmlns="${SVG_NS}"`);
  const doc = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) return null;
  if (!safeAttributes(root)) return null;
  for (const element of Array.from(root.getElementsByTagName("*"))) if (!safeAttributes(element)) return null;
  return clean;
}

/** A data URL drawing the (already sanitized) SVG. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
