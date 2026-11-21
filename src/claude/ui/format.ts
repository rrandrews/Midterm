import { structuredPatch } from "diff";
import type { ModelInfo, PermissionMode } from "../protocol";
import type { ToolCall } from "../types";

/*
 * Labels and gists for the Claude Code pane: permission modes, models, a
 * tool call's one-line summary, paths relative to the session folder,
 * and line diffs for edits. Pure; unit-tested (format.test.ts).
 */

export const MODE_LABELS: Record<PermissionMode, string> = {
  default: "Ask before edits",
  acceptEdits: "Edit automatically",
  plan: "Plan mode",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Don't ask",
  auto: "Auto mode",
};

/** The modes ⇧⇥ cycles through, in order. */
export function modeCycle(allowBypass: boolean): PermissionMode[] {
  return allowBypass ? ["default", "acceptEdits", "plan", "bypassPermissions"] : ["default", "acceptEdits", "plan"];
}

export function nextMode(mode: PermissionMode, allowBypass: boolean): PermissionMode {
  const cycle = modeCycle(allowBypass);
  const index = cycle.indexOf(mode);
  return cycle[(index + 1) % cycle.length];
}

/** Models offered before the session reports its own. */
export const FALLBACK_MODELS: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", description: "The model your account defaults to" },
  { value: "opus", displayName: "Opus", description: "Most capable" },
  { value: "sonnet", displayName: "Sonnet", description: "Fast and capable" },
  { value: "haiku", displayName: "Haiku", description: "Fastest" },
];

/** A model's short name for the chip: "Opus 5.5" from "Opus 5.5", "Default (recommended)" → "Default". */
export function modelLabel(model: string | undefined, models: readonly ModelInfo[], resolved?: string): string {
  // The default model: name what it resolved to.
  if ((!model || model === "default") && resolved) return prettyModelId(resolved);
  const info = models.find((candidate) => candidate.value === (model ?? "default"));
  if (info) return info.displayName.replace(/\s*\(.*\)\s*$/, "");
  if (model) return model;
  return resolved ? prettyModelId(resolved) : "Default";
}

/** "claude-opus-5-5" → "Opus 5.5". */
export function prettyModelId(id: string): string {
  const match = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!match) return id;
  const family = match[1][0].toUpperCase() + match[1].slice(1);
  return match[3] && match[3].length < 3 ? `${family} ${match[2]}.${match[3]}` : `${family} ${match[2]}`;
}

export const EFFORT_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** `path` relative to `cwd` when inside it; `~` for the home folder otherwise. */
export function relativeTo(path: string, cwd: string, home?: string): string {
  if (!path) return path;
  const base = cwd.replace(/\/+$/, "");
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1).replace(/^\/+/, "");
  if (path === base) return ".";
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** `mcp__server__tool` → { server, tool }. */
export function mcpName(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1], tool: match[2] } : undefined;
}

/** The tool's name as shown: "Bash", "linear › list_issues". */
export function toolLabel(name: string): string {
  const mcp = mcpName(name);
  return mcp ? `${mcp.server} › ${mcp.tool}` : name;
}

/** A one-line gist of a call: the command, path, pattern, URL or description. */
export function toolGist(tool: Pick<ToolCall, "name" | "input">, cwd: string, home?: string): string {
  const input = tool.input;
  const path = (value: unknown) => (str(value) ? relativeTo(value as string, cwd, home) : undefined);
  switch (tool.name) {
    case "Bash":
      return str(input.command)?.split("\n")[0] ?? "";
    case "BashOutput":
    case "KillShell":
    case "TaskStop":
      return str(input.bash_id) ?? str(input.shell_id) ?? str(input.task_id) ?? "";
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return path(input.file_path) ?? path(input.notebook_path) ?? "";
    case "Grep":
      return [str(input.pattern), path(input.path) ?? str(input.glob)].filter(Boolean).join("  ");
    case "Glob":
      return [str(input.pattern), path(input.path)].filter(Boolean).join("  ");
    case "WebFetch":
      return str(input.url) ?? "";
    case "WebSearch":
      return str(input.query) ?? "";
    case "Agent":
    case "Task":
      return str(input.description) ?? "";
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const done = todos.filter((todo) => (todo as { status?: unknown })?.status === "completed").length;
      return todos.length ? `${done}/${todos.length} done` : "";
    }
    case "TaskCreate":
      return str(input.subject) ?? "";
    case "TaskUpdate": {
      const id = str(input.taskId);
      const status = str(input.status);
      const change = status ? `→ ${status === "in_progress" ? "in progress" : status}` : str(input.subject);
      return [id ? `#${id}` : undefined, change].filter(Boolean).join(" ");
    }
    case "TaskGet":
      return str(input.taskId) ? `#${input.taskId}` : "";
    case "TaskList":
      return "";
    case "ExitPlanMode":
      return "Plan ready for review";
    case "AskUserQuestion": {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      return str((questions[0] as { question?: unknown } | undefined)?.question) ?? "";
    }
    case "Skill":
    case "SlashCommand":
      return str(input.skill) ?? str(input.command) ?? "";
    default: {
      for (const key of ["description", "command", "file_path", "path", "query", "url", "pattern", "name", "title"]) {
        const value = str(input[key]);
        if (value) return key.includes("path") ? relativeTo(value, cwd, home) : value;
      }
      const json = JSON.stringify(input);
      return json === "{}" ? "" : json.length > 160 ? `${json.slice(0, 157)}…` : json;
    }
  }
}

/** Whether the gist reads as code (shown in mono). */
export function gistIsCode(name: string): boolean {
  return name === "Bash" || name === "Grep" || name === "Glob" || name === "BashOutput";
}

/* ---- Diffs ---- */

export type DiffLine = { type: "context" | "add" | "del" | "gap"; text: string; oldLine?: number; newLine?: number };

type Hunk = { oldStart: number; oldLines?: number; newStart: number; newLines?: number; lines: string[] };

/** Lines of the SDK's structured patch (Edit/Write `tool_use_result.structuredPatch`). */
export function diffFromPatch(hunks: readonly Hunk[]): DiffLine[] {
  const lines: DiffLine[] = [];
  hunks.forEach((hunk, index) => {
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

/** Context lines around each change. */
const DIFF_CONTEXT = 3;

/**
 * A line diff of two texts as hunks (jsdiff's Myers diff, `structuredPatch`).
 * Bounded: past the time limit it falls back to the changed middle between
 * the common first and last lines, still as one real hunk.
 */
export function diffTexts(before: string, after: string): DiffLine[] {
  const patch = structuredPatch("a", "b", before, after, undefined, undefined, { context: DIFF_CONTEXT, timeout: 250 });
  return patch ? diffFromPatch(patch.hunks) : diffAround(before, after);
}

/** The cheap fallback: one hunk of what changed between the common first and last lines. */
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
  for (let k = 0; k < Math.min(end, DIFF_CONTEXT); k++) lines.push({ type: "context", text: a[a.length - end + k], oldLine: a.length - end + k + 1, newLine: b.length - end + k + 1 });
  return lines;
}

/** Added and removed line counts. */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added++;
    else if (line.type === "del") removed++;
  }
  return { added, removed };
}

/** The diff of an Edit / MultiEdit / Write call: from its structured result when there is one, else from its input. */
export function toolDiff(tool: Pick<ToolCall, "name" | "input" | "structured">): DiffLine[] | undefined {
  // Tool calls are immutable in the store: one diff per call, however often it is asked for.
  if (diffCache.has(tool)) return diffCache.get(tool);
  const diff = computeToolDiff(tool);
  diffCache.set(tool, diff);
  return diff;
}

const diffCache = new WeakMap<object, DiffLine[] | undefined>();

/** Line numbers of a diff between snippets count from the snippet, not the file: dropped. */
const unnumbered = (lines: DiffLine[]): DiffLine[] => lines.map(({ oldLine: _old, newLine: _new, ...line }) => line);

function computeToolDiff(tool: Pick<ToolCall, "name" | "input" | "structured">): DiffLine[] | undefined {
  const structured = tool.structured as { structuredPatch?: unknown } | undefined;
  if (structured && Array.isArray(structured.structuredPatch) && structured.structuredPatch.length) return diffFromPatch(structured.structuredPatch as Hunk[]);
  const input = tool.input;
  // No patch (a replayed transcript, or a call that failed): the input's own texts.
  if (tool.name === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") return unnumbered(diffTexts(input.old_string, input.new_string));
  if (tool.name === "MultiEdit" && Array.isArray(input.edits)) {
    const lines: DiffLine[] = [];
    for (const edit of input.edits as { old_string?: unknown; new_string?: unknown }[]) {
      if (typeof edit?.old_string !== "string" || typeof edit.new_string !== "string") continue;
      if (lines.length) lines.push({ type: "gap", text: "" });
      lines.push(...unnumbered(diffTexts(edit.old_string, edit.new_string)));
    }
    return lines;
  }
  if (tool.name === "Write" && typeof input.content === "string") return diffTexts("", input.content);
  return undefined;
}

/** Elapsed time for a row: "2.1s", "1m 04s". */
export function formatElapsed(ms: number): string {
  if (ms < 100) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Context fill as a whole percent (0–100), if known. */
export function contextPercent(tokens: number | undefined, window: number | undefined): number | undefined {
  if (!tokens || !window) return undefined;
  return Math.min(100, Math.round((tokens / window) * 100));
}

/** "ok" / "warn" past 70% / "err" past 90%. */
export function levelOf(percent: number): "accent" | "warn" | "err" {
  return percent > 90 ? "err" : percent > 70 ? "warn" : "accent";
}
