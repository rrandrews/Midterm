import { redact } from "../ai/context";
import * as scm from "../ipc/scm";
import type { ScmCommit, ScmCommitFile, ScmDiff, ScmDiffMode, ScmFileChange, ScmStatus } from "../ipc/scm";
import type { Settings } from "../settings/schema";
import { getSettings } from "../settings/settings";

/*
 * Commit message generation prompt helpers and bounded, secret-redacted Git
 * diff context assembly for Source Control.
 */

export const COMMIT_PROMPT_SETTING_KEY = "commitPrompt";

export const DEFAULT_COMMIT_PROMPT = [
  "Write a concise, clear Git commit message for the changes below.",
  "- Use an imperative, present-tense subject line (at most 72 characters) with no trailing period.",
  "- Match the repository's commit style (for example, conventional commits if used in recent commits).",
  "- For non-trivial changes, include a blank line followed by brief bullet points explaining what changed and why.",
  "- Output only the commit message itself — no surrounding code fences, quotes, or commentary.",
].join("\n");

/** Total combined budget for system instructions + repository diff prompt. */
export const MAX_PROMPT_CHARS = 24_000;
/** Maximum length allowed for custom system instructions so diff context always fits. */
export const MAX_SYSTEM_PROMPT_CHARS = 8_000;
const MAX_DIFF_FILES = 24;
const MAX_SINGLE_FILE_CHARS = 6_000;
const MAX_FILE_LIST_CHARS = 6_000;
const MAX_META_LINE_CHARS = 200;
const RECENT_COMMITS_LIMIT = 5;
const NOTICE_RESERVE_CHARS = 160;

const LOCKFILE_RE =
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|Podfile\.lock|go\.sum)$|\.min\.(?:js|css)$/i;

/** Files whose diff bodies are omitted entirely (filenames remain listed) to prevent secret leaks. */
const SENSITIVE_FILE_RE =
  /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]+)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.[^/]+)?|(?:[^/]*\.)?(?:pem|key|p12|pfx|jks|keystore)|[^/]*(?:secrets?|credentials?)\.(?:ya?ml|json|toml|ini|env|conf))$/i;

const YAML_FILE_RE = /\.ya?ml$/i;
const YAML_MAPPING_LINE_RE = /^[ \t]*(?:-[ \t]+)?(?:(?:"[^"\n]+"|'[^'\n]+'|[^#:\s][^:\n]*?)\s*:(?:\s|$))/;
const ORPHAN_PEM_END_RE = /^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/;
const PEM_BASE64_LINE_RE = /^[A-Za-z0-9+/]{48,}={0,2}$/;

/** The active system prompt for commit message generation (falls back to `DEFAULT_COMMIT_PROMPT`). */
export function resolveCommitPrompt(settings: Settings = getSettings()): string {
  const raw = settings.plugins["source-control"]?.settings?.[COMMIT_PROMPT_SETTING_KEY];
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  return DEFAULT_COMMIT_PROMPT;
}

/** Whether the user has saved a custom prompt different from `DEFAULT_COMMIT_PROMPT`. */
export function isCustomCommitPrompt(settings: Settings = getSettings()): boolean {
  const raw = settings.plugins["source-control"]?.settings?.[COMMIT_PROMPT_SETTING_KEY];
  return typeof raw === "string" && raw.trim().length > 0 && raw.trim() !== DEFAULT_COMMIT_PROMPT.trim();
}

/** Strips accidental markdown code fences or outer quotes from an AI-generated commit message. */
export function cleanGeneratedCommitMessage(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").trim();
  // Unwrap a single outer markdown fenced block (```text ... ``` or ``` ... ```).
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  // Unwrap accidental matching outer quotes on a single-line subject.
  if (!text.includes("\n") && text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

function redactAndClip(text: string, maxChars: number): string {
  const safe = redact(text);
  if (safe.length <= maxChars) return safe;
  return `${safe.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Redacts a side of a hunk (without diff `+`/`-` prefixes) while keeping a
 * 1-to-1 line count so multiline JSON/YAML assignments and PEM keys spanning
 * diff lines are caught cleanly before diff markers are re-attached.
 */
function redactPreservingLines(
  lines: readonly string[],
  opts: { isYaml: boolean; midFile: boolean },
): string[] {
  if (lines.length === 0) return [];
  const working = [...lines];

  // If a mid-file hunk starts inside an indented YAML block scalar whose parent
  // key (`password: |`) fell above Git's 3-line context, mask leading indented
  // non-mapping lines until a mapping key or unindented line appears.
  if (opts.isYaml && opts.midFile) {
    for (let i = 0; i < working.length; i++) {
      const line = working[i];
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      if (indent === 0 || YAML_MAPPING_LINE_RE.test(line)) break;
      working[i] = `${line.slice(0, indent)}[redacted]`;
    }
  }

  // Mask orphan PEM tails (when `-----BEGIN PRIVATE KEY-----` fell above the hunk)
  // and runs of 3+ raw base64 PEM-body lines in mid-file hunks.
  let joined = working.join("\n");
  if (opts.midFile && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(joined)) {
    joined = joined.replace(ORPHAN_PEM_END_RE, (m) =>
      m
        .split("\n")
        .map(() => "[redacted]")
        .join("\n"),
    );
  }
  const pemLines = joined.split("\n");
  if (opts.midFile && pemLines.length === working.length) {
    let runStart = -1;
    for (let i = 0; i <= pemLines.length; i++) {
      const isB64 = i < pemLines.length && PEM_BASE64_LINE_RE.test(pemLines[i].trim());
      if (isB64) {
        if (runStart === -1) runStart = i;
      } else {
        if (runStart !== -1 && i - runStart >= 3) {
          for (let k = runStart; k < i; k++) pemLines[k] = "[redacted]";
        }
        runStart = -1;
      }
    }
    joined = pemLines.join("\n");
  }

  const redacted = redact(joined, { preserveLineCount: true }).split("\n");
  if (redacted.length === lines.length) return redacted;
  // Never fall back to unredacted per-line text if line count ever diverges.
  return lines.map(() => "[redacted]");
}

function formatDiffSnippet(diff: ScmDiff, sourceLabel?: string): string {
  const safeOld = diff.oldPath ? redact(diff.oldPath) : undefined;
  const safePath = redact(diff.path);
  const headerPath = safeOld ? `${safeOld} -> ${safePath}` : safePath;
  const tag = sourceLabel ? ` (${sourceLabel})` : "";
  if (diff.binary) return `diff -- ${headerPath}${tag}\n[binary file]\n`;
  if (diff.tooLarge && diff.hunks.length === 0) return `diff -- ${headerPath}${tag}\n[diff too large to include]\n`;
  if (diff.hunks.length === 0) return "";

  const isYaml = YAML_FILE_RE.test(diff.path);
  const lines: string[] = [
    `--- ${diff.isNew ? "/dev/null" : `a/${safeOld ?? safePath}`}${tag}`,
    `+++ ${diff.isDeleted ? "/dev/null" : `b/${safePath}`}`,
  ];
  for (const hunk of diff.hunks) {
    // Emit numeric range only (omit Git's trailing context source line after `@@`).
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    const oldSide: string[] = [];
    const newSide: string[] = [];
    for (const line of hunk.lines) {
      const text = line.content.replace(/\r$/, "");
      if (line.kind !== "add") oldSide.push(text);
      if (line.kind !== "del") newSide.push(text);
    }
    const redactedOld = redactPreservingLines(oldSide, { isYaml, midFile: hunk.oldStart > 1 });
    const redactedNew = redactPreservingLines(newSide, { isYaml, midFile: hunk.newStart > 1 });
    let oi = 0;
    let ni = 0;
    for (const line of hunk.lines) {
      const raw = line.content.replace(/\r$/, "");
      if (line.kind === "del") {
        lines.push(`-${redactedOld[oi++]}`);
      } else if (line.kind === "add") {
        lines.push(`+${redactedNew[ni++]}`);
      } else {
        const ro = redactedOld[oi++];
        const rn = redactedNew[ni++];
        const chosen = ro === rn ? ro : ro === raw ? rn : rn === raw ? ro : "[redacted]";
        lines.push(` ${chosen}`);
      }
    }
  }
  const formatted = lines.join("\n");
  if (formatted.length > MAX_SINGLE_FILE_CHARS) {
    const suffix = "\n… (file diff truncated)\n";
    return `${formatted.slice(0, MAX_SINGLE_FILE_CHARS - suffix.length)}${suffix}`;
  }
  return `${formatted}\n`;
}

type DiffFetcher = (
  root: string,
  filePath: string,
  mode: ScmDiffMode,
  options?: { commitHash?: string; oldPath?: string },
) => Promise<ScmDiff>;

type CommitFilesFetcher = (root: string, hash: string) => Promise<ScmCommitFile[]>;

type DiffTargetEntry = {
  path: string;
  origPath?: string;
  status: string;
  mode: ScmDiffMode;
  commitHash?: string;
  sourceLabel?: string;
};

function buildBoundedFileList(entries: readonly DiffTargetEntry[], maxChars: number): string {
  const header = `Changed files (${entries.length}):`;
  const lines: string[] = [header];
  let chars = header.length;
  let included = 0;

  for (const entry of entries) {
    const rawPath = entry.origPath ? `${entry.origPath} -> ${entry.path}` : entry.path;
    const tag = entry.sourceLabel ? ` (${entry.sourceLabel})` : "";
    const line = `- [${entry.status}] ${redactAndClip(rawPath, MAX_META_LINE_CHARS)}${tag}`;
    const remainingEntries = entries.length - included - 1;
    const reserve = remainingEntries > 0 ? 48 : 0;
    if (included > 0 && chars + 1 + line.length + reserve > maxChars) {
      break;
    }
    lines.push(line);
    chars += 1 + line.length;
    included += 1;
  }

  const omitted = entries.length - included;
  if (omitted > 0) {
    lines.push(`… (${omitted} more file(s) omitted)`);
  }
  return lines.join("\n");
}

function enforceBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = "\n… (context truncated)";
  if (maxChars <= suffix.length) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - suffix.length)}${suffix}`;
}

/**
 * Collects a bounded, secret-redacted plain-text prompt describing the
 * repository's changes for commit message generation.
 *
 * - When `amend` is enabled: includes BOTH HEAD's commit baseline AND any staged
 *   changes (including when both touch the same file, matching `git commit --amend`;
 *   unstaged and untracked files are ignored).
 * - Otherwise: prefers staged changes, falling back to unstaged+untracked.
 * - Strictly enforces `maxChars` across the entire returned string and aborts
 *   immediately between diff fetches if `shouldAbort()` becomes true.
 */
export async function buildCommitMessageContext({
  status,
  commits,
  amend,
  maxChars = MAX_PROMPT_CHARS,
  shouldAbort,
  fetchDiff = scm.scmDiff,
  fetchCommitFiles = scm.scmCommitFiles,
}: {
  status: ScmStatus;
  commits: readonly ScmCommit[];
  amend: boolean;
  maxChars?: number;
  shouldAbort?: () => boolean;
  fetchDiff?: DiffFetcher;
  fetchCommitFiles?: CommitFilesFetcher;
}): Promise<string | null> {
  if (shouldAbort?.() || maxChars <= 0) return null;

  let scopeLabel: string;
  let entries: DiffTargetEntry[] = [];

  if (amend) {
    if (!status.headOid) return null;
    const headOid = status.headOid;
    const headFiles = await fetchCommitFiles(status.root, headOid);
    if (shouldAbort?.()) return null;

    const hasStaged = status.staged.length > 0;
    const headEntries: DiffTargetEntry[] = headFiles.map((f) => ({
      path: f.path,
      origPath: f.origPath,
      status: f.status,
      mode: "commit" as const,
      commitHash: headOid,
      sourceLabel: hasStaged ? "HEAD" : undefined,
    }));
    const stagedEntries: DiffTargetEntry[] = status.staged.map((f: ScmFileChange) => ({
      path: f.path,
      origPath: f.origPath,
      status: f.status,
      mode: "staged" as const,
      sourceLabel: "staged amend",
    }));

    scopeLabel = hasStaged
      ? `Amending HEAD (${headOid.slice(0, 7)}) with staged changes`
      : `Amending HEAD (${headOid.slice(0, 7)})`;
    // Keep HEAD's original changes alongside staged amend edits (even for the same file)
    // so the model understands the full resulting amended commit.
    entries = [...headEntries, ...stagedEntries];
  } else if (status.staged.length > 0) {
    scopeLabel = "Staged changes";
    entries = status.staged.map((f: ScmFileChange) => ({
      path: f.path,
      origPath: f.origPath,
      status: f.status,
      mode: "staged" as const,
    }));
  } else if (status.unstaged.length > 0 || status.untracked.length > 0) {
    scopeLabel = "Working tree changes (unstaged & untracked)";
    entries = [
      ...status.unstaged.map((f: ScmFileChange) => ({
        path: f.path,
        origPath: f.origPath,
        status: f.status,
        mode: "unstaged" as const,
      })),
      ...status.untracked.map((f: ScmFileChange) => ({
        path: f.path,
        status: f.status,
        mode: "untracked" as const,
      })),
    ];
  } else {
    return null;
  }

  if (entries.length === 0) return null;

  const sections: string[] = [];
  sections.push(`Branch: ${redactAndClip(status.branch ?? "(detached HEAD)", MAX_META_LINE_CHARS)}`);
  sections.push(`Scope: ${redactAndClip(scopeLabel, MAX_META_LINE_CHARS)}`);

  const recentSubjects = commits
    .map((c) => c.subject.trim())
    .filter(Boolean)
    .slice(0, RECENT_COMMITS_LIMIT);
  if (recentSubjects.length > 0) {
    sections.push(
      `Recent commits:\n${recentSubjects.map((s) => `- ${redactAndClip(s, MAX_META_LINE_CHARS)}`).join("\n")}`,
    );
  }

  const fileListBudget = Math.min(MAX_FILE_LIST_CHARS, Math.max(400, Math.floor(maxChars * 0.3)));
  sections.push(buildBoundedFileList(entries, fileListBudget));

  // Prioritize non-lockfile, non-sensitive source files when fetching full diffs.
  const sensitive = entries.filter((e) => SENSITIVE_FILE_RE.test(e.path));
  const lockfiles = entries.filter((e) => !SENSITIVE_FILE_RE.test(e.path) && LOCKFILE_RE.test(e.path));
  const regular = entries.filter((e) => !SENSITIVE_FILE_RE.test(e.path) && !LOCKFILE_RE.test(e.path));
  const toFetch = regular.slice(0, MAX_DIFF_FILES);

  const baseChars = sections.join("\n\n").length;
  const diffHeaderChars = "\n\nDiffs:\n".length;
  const maxDiffChars = Math.max(0, maxChars - baseChars - diffHeaderChars - NOTICE_RESERVE_CHARS);
  let usedDiffChars = 0;
  const diffParts: string[] = [];
  let omittedCount = Math.max(0, regular.length - toFetch.length);

  for (let i = 0; i < toFetch.length; i++) {
    if (shouldAbort?.()) return null;
    const remaining = maxDiffChars - usedDiffChars;
    if (remaining <= 200) {
      omittedCount += toFetch.length - i;
      break;
    }
    const entry = toFetch[i];
    try {
      const diff = await fetchDiff(status.root, entry.path, entry.mode, {
        commitHash: entry.commitHash,
        oldPath: entry.origPath,
      });
      if (shouldAbort?.()) return null;
      const snippet = formatDiffSnippet(diff, entry.sourceLabel);
      if (!snippet) continue;
      const separator = diffParts.length > 0 ? 1 : 0;
      const avail = maxDiffChars - usedDiffChars - separator;
      if (snippet.length > avail) {
        const truncSuffix = "\n… (remaining diffs truncated)";
        if (avail > truncSuffix.length + 120) {
          const part = `${snippet.slice(0, avail - truncSuffix.length)}${truncSuffix}`;
          diffParts.push(part);
          usedDiffChars += separator + part.length;
        } else {
          omittedCount += 1;
        }
        omittedCount += toFetch.length - i - 1;
        break;
      }
      diffParts.push(snippet);
      usedDiffChars += separator + snippet.length;
    } catch {
      if (shouldAbort?.()) return null;
      omittedCount += 1;
    }
  }

  if (shouldAbort?.()) return null;

  if (sensitive.length > 0) {
    diffParts.push(`[${sensitive.length} sensitive/secret file diff(s) omitted]`);
  }
  if (lockfiles.length > 0) {
    diffParts.push(`[${lockfiles.length} lockfile/minified file diff(s) omitted]`);
  }
  if (omittedCount > 0) {
    diffParts.push(`[${omittedCount} additional file diff(s) omitted due to size limit]`);
  }

  if (diffParts.length > 0) {
    sections.push(`Diffs:\n${diffParts.join("\n")}`);
  }

  return enforceBudget(sections.join("\n\n"), maxChars);
}
