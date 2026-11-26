import { SSH_SCHEME, isRemotePath, normalizePosixPath, resolveLocation } from "../files/location";

/*
 * Where links and images in a rendered Markdown file point. Pure;
 * unit-tested in links.test.ts.
 */

export type LinkTarget =
  | { type: "external"; url: string }
  | { type: "file"; path: string; line?: number }
  | { type: "anchor"; id: string };

/** Resolves `.` and `..` segments of an absolute path. */
export function normalizePath(path: string): string {
  return normalizePosixPath(path);
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A relative or absolute file reference, resolved against `baseDir` on the same host. */
function filePath(reference: string, baseDir: string): string | null {
  // Never fall back to the local filesystem for a malformed `ssh://` baseDir.
  if (baseDir.startsWith(SSH_SCHEME) && !isRemotePath(baseDir)) return null;
  return resolveLocation(decode(reference), baseDir);
}

/**
 * What clicking a link in a document in `baseDir` should do: open a web page
 * (http and https only), open a file (relative paths, absolute paths,
 * `file:` URLs for local docs; a `#L12` fragment names a line), or scroll to a
 * heading. `null` for anything else (`javascript:`, `mailto:`, or `file:` from
 * a remote SSH document which must not cross into the local filesystem).
 */
export function resolveLink(href: string, baseDir: string): LinkTarget | null {
  const link = href.trim();
  if (!link) return null;
  if (link.startsWith("#")) return { type: "anchor", id: decode(link.slice(1)) };
  if (SCHEME.test(link)) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return null;
    }
    if (url.protocol === "http:" || url.protocol === "https:") return { type: "external", url: url.href };
    if (url.protocol === "file:") {
      if (baseDir.startsWith(SSH_SCHEME)) return null;
      return { type: "file", path: normalizePath(decode(url.pathname)), ...lineOf(url.hash) };
    }
    return null;
  }
  const hashAt = link.indexOf("#");
  const beforeHash = hashAt === -1 ? link : link.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : link.slice(hashAt);
  const path = beforeHash.split("?")[0];
  if (!path) return hash ? { type: "anchor", id: decode(hash.slice(1)) } : null;
  const resolved = filePath(path, baseDir);
  return resolved ? { type: "file", path: resolved, ...lineOf(hash) } : null;
}

/** `#L12` (GitHub's line links) as a line number. */
function lineOf(hash: string): { line?: number } {
  const match = /^#L(\d+)/.exec(hash);
  return match ? { line: Number(match[1]) } : {};
}

/**
 * Where an image in a document in `baseDir` comes from: a file on the same
 * host to read, an inline `data:image/…` URL used as is, or `null` for
 * anything else (HTTP images are not loaded, and `file:` URLs inside remote
 * Markdown documents are blocked from accessing the local machine).
 */
export function resolveImage(src: string, baseDir: string): { type: "file"; path: string } | { type: "inline" } | null {
  const source = src.trim();
  if (!source) return null;
  if (/^data:image\//i.test(source)) return { type: "inline" };
  if (SCHEME.test(source)) {
    if (!/^file:/i.test(source) || baseDir.startsWith(SSH_SCHEME)) return null;
    try {
      return { type: "file", path: normalizePath(decode(new URL(source).pathname)) };
    } catch {
      return null;
    }
  }
  const path = source.split(/[?#]/)[0];
  if (!path) return null;
  const resolved = filePath(path, baseDir);
  return resolved ? { type: "file", path: resolved } : null;
}

/** GitHub's heading anchors: lower case, spaces to dashes, punctuation dropped. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
