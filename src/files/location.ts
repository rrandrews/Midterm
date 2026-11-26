/*
 * Uniform file-system location helpers for local paths (`/abs/...`) and remote
 * SSH URIs (`ssh://<remoteId>/<posixPath>`). Mirrors `src-tauri/src/ssh/location.rs`.
 *
 * Local paths stay plain POSIX strings for full backwards compatibility.
 * Remote locations keep an opaque `ssh://<remoteId>` authority prefix so
 * caches, open-file registries, watchers, and saved layouts never confuse
 * `/etc/hosts` on two different machines.
 *
 * Pure module — no I/O, no React. Unit-tested in `location.test.ts`.
 */

export const SSH_SCHEME = "ssh://";

export type Location =
  | { kind: "local"; path: string }
  | { kind: "remote"; remoteId: string; path: string };

const REMOTE_ID_RE = /^[A-Za-z0-9._@-]{1,128}$/;

/** Whether `id` is a valid opaque SSH remote identifier (matches Rust `validate_remote_id`). */
export function isValidRemoteId(id: string): boolean {
  return id !== "." && id !== ".." && REMOTE_ID_RE.test(id);
}

/** Resolves `.` and `..` segments of an absolute POSIX path. */
export function normalizePosixPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * Parses a local path or `ssh://<remoteId>/<posixPath>` URI.
 * Returns `null` for malformed `ssh://` URIs (missing path, invalid id, NUL)
 * or empty strings.
 */
export function parseLocation(raw: string): Location | null {
  if (!raw || raw.includes("\0")) return null;
  if (raw.startsWith(SSH_SCHEME)) {
    const rest = raw.slice(SSH_SCHEME.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    const remoteId = rest.slice(0, slash);
    if (!isValidRemoteId(remoteId)) return null;
    const rawPath = rest.slice(slash);
    const trimmed = rawPath.replace(/\/+$/, "");
    const path = trimmed.length === 0 ? "/" : trimmed;
    return { kind: "remote", remoteId, path };
  }
  return { kind: "local", path: raw };
}

/** Formats a remote location URI (`ssh://<remoteId>/<posixPath>`). */
export function formatRemoteLocation(remoteId: string, posixPath: string): string {
  const clean = posixPath.replace(/\/+$/, "");
  if (!clean || clean === "/") return `${SSH_SCHEME}${remoteId}/`;
  const rooted = clean.startsWith("/") ? clean : `/${clean}`;
  return `${SSH_SCHEME}${remoteId}${rooted}`;
}

/** Whether `raw` is a valid remote SSH location URI. */
export function isRemotePath(raw: string): boolean {
  return raw.startsWith(SSH_SCHEME) && parseLocation(raw)?.kind === "remote";
}

/** Returns the `remoteId` for a remote SSH location, or `null` for local paths. */
export function remoteIdOf(raw: string): string | null {
  const parsed = parseLocation(raw);
  return parsed?.kind === "remote" ? parsed.remoteId : null;
}

/**
 * Returns the clean POSIX path without any `ssh://<remoteId>` prefix.
 * Use this for user-facing clipboard copies, terminal pastes, shell `cd`
 * commands, and display when the host is shown separately.
 */
export function posixPathOf(raw: string): string {
  const parsed = parseLocation(raw);
  return parsed ? parsed.path : raw;
}

/** Whether `raw` is the filesystem root of its host (`/` or `ssh://<id>/`). */
export function isRootLocation(raw: string): boolean {
  if (raw === "/") return true;
  const parsed = parseLocation(raw);
  return parsed !== null && parsed.path === "/";
}

/** Whether `raw` is an absolute path on either the local machine or a remote host. */
export function isAbsoluteLocation(raw: string): boolean {
  if (raw.startsWith("/")) return true;
  return isRemotePath(raw);
}

/** Whether `a` and `b` reside on the same host (both local, or same `remoteId`). */
export function sameHost(a: string, b: string): boolean {
  const pa = parseLocation(a);
  const pb = parseLocation(b);
  if (!pa || !pb || pa.kind !== pb.kind) return false;
  return pa.kind === "local" || (pb.kind === "remote" && pa.remoteId === pb.remoteId);
}

/** Resolves `.` and `..` segments while preserving any `ssh://<remoteId>` prefix. */
export function normalizeLocation(raw: string): string {
  const parsed = parseLocation(raw);
  if (!parsed) return raw;
  const norm = normalizePosixPath(parsed.path);
  return parsed.kind === "remote" ? formatRemoteLocation(parsed.remoteId, norm) : norm;
}

/**
 * Resolves a relative or absolute POSIX `reference` against `baseDir`, keeping
 * `baseDir`'s host (local or remote).
 */
export function resolveLocation(reference: string, baseDir: string): string {
  const base = parseLocation(baseDir);
  if (!base) return normalizePosixPath(reference);
  const combined = reference.startsWith("/") ? reference : `${base.path}/${reference}`;
  const norm = normalizePosixPath(combined);
  return base.kind === "remote" ? formatRemoteLocation(base.remoteId, norm) : norm;
}

/**
 * Extracts a short readable host fallback from a deterministic `remoteId`
 * (`<slug>-<12-hex-hash>` -> `<slug>`), used only if the connection registry
 * doesn't have a richer label yet.
 */
export function fallbackHostLabel(remoteId: string): string {
  const match = /^(.+)-[0-9a-f]{12}$/.exec(remoteId);
  return match ? match[1] : remoteId;
}
