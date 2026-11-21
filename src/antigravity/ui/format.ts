import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk/unstable";
import { structuredPatch } from "diff";
import type { AcpToolCall } from "../types";

/*
 * Formatting, ACP configOption helpers, relative paths, and Myers line diffs
 * for the Antigravity ACP pane. Pure; unit-tested (format.test.ts).
 */

/** `path` relative to `cwd` when inside it; `~` for home otherwise. */
export function relativeTo(path: string, cwd: string, home?: string): string {
  if (!path) return path;
  const base = cwd.replace(/\/+$/, "");
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1).replace(/^\/+/, "");
  if (path === base) return ".";
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/** Elapsed duration: "2.1s", "1m 04s". */
export function formatElapsed(ms: number): string {
  if (ms < 100) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Compact token count: "950", "12.4k", "1.0M". */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 1 : 2)}M`;
}

/** Formats ACP `Cost` (`USD`, `EUR`, or custom units such as `credits`). */
export function formatCost(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  if (code === "USD") return amount < 0.01 && amount > 0 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
  if (code === "EUR") return `€${amount.toFixed(2)}`;
  return `${amount.toFixed(2)} ${currency}`;
}

/** Relative timestamp for History ("just now", "4m ago", "2h ago", "3d ago"). */
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Context window fill percentage (0–100). */
export function contextPercent(used: number | undefined, size: number | undefined): number | undefined {
  if (used === undefined || !size || size <= 0) return undefined;
  return Math.min(100, Math.round((used / size) * 100));
}

export function levelOf(percent: number): "accent" | "warn" | "err" {
  return percent > 90 ? "err" : percent > 70 ? "warn" : "accent";
}

/* ---- ACP Config Options ---- */

export function isGroupedOptions(options: SessionConfigSelectOption[] | SessionConfigSelectGroup[]): options is SessionConfigSelectGroup[] {
  return options.length > 0 && "group" in options[0] && "options" in options[0];
}

/** Flattens grouped or ungrouped select options into a flat array. */
export function flattenSelectOptions(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== "select") return [];
  if (isGroupedOptions(option.options)) return option.options.flatMap((group) => group.options);
  return option.options;
}

/** Finds a config option by semantic category, falling back to its id. */
export function findConfigOption(options: readonly SessionConfigOption[], category: string): SessionConfigOption | undefined {
  return options.find((o) => o.category === category) ?? options.find((o) => o.id === category);
}

/** Human label for a select option's current value. */
export function selectCurrentLabel(option: SessionConfigOption): string {
  if (option.type !== "select") return option.currentValue ? "On" : "Off";
  const match = flattenSelectOptions(option).find((o) => o.value === option.currentValue);
  return match?.name ?? option.currentValue;
}

/** Tone class for known mode ids (`plan`, `accept-edits`, `bypass`, `default`). */
export function modeTone(modeId: string | undefined): "plan" | "accept" | "bypass" | "default" {
  const id = (modeId ?? "").toLowerCase();
  if (id.includes("plan")) return "plan";
  if (id.includes("bypass") || id.includes("yolo") || id.includes("danger")) return "bypass";
  if (id.includes("accept") || id.includes("auto") || id.includes("edit")) return "accept";
  return "default";
}

/* ---- Tool formatting ---- */

export const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Mode",
  other: "Tool",
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
const rec = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Extracts a concise one-line gist for a tool call when its title alone isn't enough. */
export function toolGist(tool: Pick<AcpToolCall, "title" | "kind" | "locations" | "rawInput" | "content">, cwd: string, home?: string): string {
  const diff = tool.content.find((c): c is Extract<ToolCallContent, { type: "diff" }> => c.type === "diff");
  if (diff?.path) {
    const rel = relativeTo(diff.path, cwd, home);
    if (!tool.title.includes(rel)) return rel;
  }
  if (tool.locations.length > 0) {
    const loc = tool.locations[0];
    const rel = relativeTo(loc.path, cwd, home);
    const suffix = loc.line ? `:${loc.line}` : "";
    if (!tool.title.includes(rel)) return `${rel}${suffix}`;
  }
  const input = rec(tool.rawInput);
  for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description"]) {
    const val = str(input[key]);
    if (!val) continue;
    const formatted = key.includes("path") ? relativeTo(val, cwd, home) : val.split("\n")[0];
    if (!tool.title.includes(formatted)) return formatted;
  }
  return "";
}

export function gistIsCode(kind: ToolKind): boolean {
  return kind === "execute" || kind === "search" || kind === "read" || kind === "edit" || kind === "delete" || kind === "move";
}

/* ---- Diffs ---- */

export type DiffLine = { type: "context" | "add" | "del" | "gap"; text: string; oldLine?: number; newLine?: number };

const DIFF_CONTEXT = 3;

export function diffTexts(before: string, after: string): DiffLine[] {
  const patch = structuredPatch("a", "b", before, after, undefined, undefined, { context: DIFF_CONTEXT, timeout: 250 });
  if (!patch) return diffAround(before, after);
  const lines: DiffLine[] = [];
  patch.hunks.forEach((hunk, index) => {
    if (index > 0) lines.push({ type: "gap", text: "" });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      const sign = raw[0];
      const text = raw.slice(1);
      if (sign === "+") lines.push({ type: "add", text, newLine: newLine++ });
      else if (sign === "-") lines.push({ type: "del", text, oldLine: oldLine++ });
      else if (sign === "\\") continue;
      else lines.push({ type: "context", text, oldLine: oldLine++, newLine: newLine++ });
    }
  });
  return lines;
}

export function diffAround(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const from = Math.max(0, start - DIFF_CONTEXT);
  const lines: DiffLine[] = [];
  for (let i = from; i < start; i++) lines.push({ type: "context", text: a[i], oldLine: i + 1, newLine: i + 1 });
  for (let i = start; i < a.length - end; i++) lines.push({ type: "del", text: a[i], oldLine: i + 1 });
  for (let j = start; j < b.length - end; j++) lines.push({ type: "add", text: b[j], newLine: j + 1 });
  for (let k = 0; k < Math.min(end, DIFF_CONTEXT); k++) {
    lines.push({ type: "context", text: a[a.length - end + k], oldLine: a.length - end + k + 1, newLine: b.length - end + k + 1 });
  }
  return lines;
}

export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added++;
    else if (line.type === "del") removed++;
  }
  return { added, removed };
}

/** Extracts all ACP `diff` blocks from a tool call, computing line diffs (cached). */
const diffCache = new WeakMap<object, { path: string; lines: DiffLine[]; added: number; removed: number }[]>();

export function toolDiffs(content: readonly ToolCallContent[]): { path: string; lines: DiffLine[]; added: number; removed: number }[] {
  const cached = diffCache.get(content);
  if (cached) return cached;
  const out: { path: string; lines: DiffLine[]; added: number; removed: number }[] = [];
  for (const item of content) {
    if (item.type !== "diff") continue;
    const lines = diffTexts(item.oldText ?? "", item.newText);
    const { added, removed } = diffStats(lines);
    out.push({ path: item.path, lines, added, removed });
  }
  diffCache.set(content, out);
  return out;
}
