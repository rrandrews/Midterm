import { Check, Circle, CircleDot } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Markdown } from "../../components/ui/Markdown";
import { todosOf } from "../reduce";
import type { ToolCall } from "../types";
import { Diff } from "./Diff";
import { diffStats, relativeTo, toolDiff } from "./format";

/*
 * What a tool call shows when expanded (its card, with IN / OUT gutter
 * labels) and on its row (a short meta: "+4 −1", "3 files"). One renderer
 * per built-in tool; MCP and unknown tools get their input as JSON.
 */

const OUTPUT_LINES = 12;

/** Text output clipped to 12 lines, with "Show all". */
export function Output({ text, tone, mono = true }: { text: string; tone?: "err"; mono?: boolean }) {
  const [all, setAll] = useState(false);
  const lines = text.replace(/\n+$/, "").split("\n");
  const clipped = !all && lines.length > OUTPUT_LINES;
  return (
    <div className="cc-output">
      <pre className={`cc-pre${mono ? "" : " is-prose"}${tone ? ` text-${tone}` : ""}`}>{clipped ? lines.slice(0, OUTPUT_LINES).join("\n") : lines.join("\n")}</pre>
      {lines.length > OUTPUT_LINES && (
        <button type="button" className="cc-more" onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

/** One gutter row of a card: `IN` / `OUT` label and its content. */
export function Gutter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cc-gutter-row">
      <span className="cc-gutter">{label}</span>
      <div className="cc-gutter-body">{children}</div>
    </div>
  );
}

const rec = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function pretty(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

/** Output of a finished call: the result text (an error in `err`), or nothing yet. */
function ResultRow({ tool, render }: { tool: ToolCall; render?: (result: string) => ReactNode }) {
  if (tool.result === undefined || tool.result === "") return null;
  return <Gutter label="OUT">{tool.isError ? <Output text={tool.result} tone="err" /> : render ? render(tool.result) : <Output text={tool.result} />}</Gutter>;
}

/** Read's range: "lines 10–49", "from line 100", "lines 1–40"; `undefined` for the whole file. */
export function readRange(offset: number | undefined, limit: number | undefined): string | undefined {
  if (offset === undefined && limit === undefined) return undefined;
  const from = offset ?? 1;
  return limit === undefined ? `from line ${from}` : `lines ${from}–${from + limit - 1}`;
}

/** Strips Read's `cat -n` line numbers ("    12→text" or "    12\ttext"). */
export function stripLineNumbers(result: string): string {
  const lines = result.split("\n");
  if (!lines.slice(0, 3).every((line) => line === "" || /^\s*\d+[→\t]/.test(line))) return result;
  return lines.map((line) => line.replace(/^\s*\d+[→\t]/, "")).join("\n");
}

function Todos({ input }: { input: unknown }) {
  const todos = todosOf(input) ?? [];
  return (
    <ul className="cc-checklist">
      {todos.map((todo, index) => (
        <li key={index} className={`is-${todo.status}`}>
          {todo.status === "completed" ? <Check size={11} /> : todo.status === "in_progress" ? <CircleDot size={11} /> : <Circle size={11} />}
          <span>{todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}</span>
        </li>
      ))}
    </ul>
  );
}

/** The expanded card's content for a call. */
export function ToolBody({ tool, cwd, home }: { tool: ToolCall; cwd: string; home?: string }) {
  const input = tool.input;
  const structured = rec(tool.structured);
  switch (tool.name) {
    case "Bash": {
      const stdout = text(structured.stdout);
      const stderr = text(structured.stderr);
      const output = stdout !== undefined || stderr !== undefined ? [stdout, stderr].filter(Boolean).join("\n") : tool.result;
      return (
        <>
          <Gutter label="IN">
            <pre className="cc-pre is-command">{text(input.command) ?? ""}</pre>
          </Gutter>
          {output ? (
            <Gutter label="OUT">
              <Output text={output} tone={tool.isError ? "err" : undefined} />
            </Gutter>
          ) : (
            tool.status === "done" && (
              <Gutter label="OUT">
                <span className="cc-faint">No output</span>
              </Gutter>
            )
          )}
          {structured.interrupted === true && <div className="cc-card-note text-warn">Interrupted</div>}
        </>
      );
    }
    case "Edit":
    case "MultiEdit":
    case "Write": {
      // The path is on the row: the body is the diff (and an error), never empty (see `hasBody`).
      const diff = toolDiff(tool);
      return (
        <>
          {diff && diff.length > 0 && <Diff lines={diff} />}
          {tool.isError && <ResultRow tool={tool} />}
        </>
      );
    }
    case "Read": {
      const offset = typeof input.offset === "number" ? input.offset : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      return (
        <>
          <Gutter label="IN">
            <span className="cc-mono">{relativeTo(text(input.file_path) ?? "", cwd, home)}</span>
            {readRange(offset, limit) && <span className="cc-faint"> · {readRange(offset, limit)}</span>}
          </Gutter>
          <ResultRow tool={tool} render={(result) => <Output text={stripLineNumbers(result)} />} />
        </>
      );
    }
    case "Grep":
    case "Glob": {
      const files = Array.isArray(structured.filenames) ? (structured.filenames as unknown[]).filter((name): name is string => typeof name === "string") : undefined;
      const content = text(structured.content);
      return (
        <>
          <Gutter label="IN">
            <span className="cc-mono">{text(input.pattern)}</span>
            {[text(input.path) && relativeTo(text(input.path) as string, cwd, home), text(input.glob), text(input.type)].filter(Boolean).map((part) => (
              <span key={part} className="cc-faint">
                {"  "}
                {part}
              </span>
            ))}
          </Gutter>
          {content ? (
            <Gutter label="OUT">
              <Output text={content} />
            </Gutter>
          ) : files && files.length > 0 ? (
            <Gutter label="OUT">
              <Output text={files.map((file) => relativeTo(file, cwd, home)).join("\n")} />
            </Gutter>
          ) : (
            <ResultRow tool={tool} />
          )}
        </>
      );
    }
    case "TodoWrite":
      return (
        <div className="cc-card-pad">
          <Todos input={input} />
        </div>
      );
    case "WebFetch":
      return (
        <>
          <Gutter label="IN">
            <span className="cc-mono">{text(input.url)}</span>
            {text(input.prompt) && <div className="cc-dim">{text(input.prompt)}</div>}
          </Gutter>
          <ResultRow tool={tool} render={(result) => <Output text={result} mono={false} />} />
        </>
      );
    case "WebSearch":
      return (
        <>
          <Gutter label="IN">{text(input.query)}</Gutter>
          <ResultRow tool={tool} render={(result) => <Output text={result} mono={false} />} />
        </>
      );
    // The task tools: their own view when there is data for it, else what they answered (errors, replayed lists).
    case "TaskCreate":
      return text(input.description) && !tool.isError ? (
        <div className="cc-card-pad">
          <div className="text-fg-soft">{text(input.subject)}</div>
          <div className="cc-dim cc-prose">{text(input.description)}</div>
        </div>
      ) : (
        <ResultRow tool={tool} />
      );
    case "TaskList": {
      const tasks = taskListOf(tool);
      return tasks.length > 0 ? (
        <div className="cc-card-pad">
          <Todos input={{ todos: tasks.map((task) => ({ content: `#${text(task.id) ?? "?"} ${text(task.subject) ?? ""}`, status: task.status })) }} />
        </div>
      ) : (
        <ResultRow tool={tool} />
      );
    }
    case "TaskGet": {
      const task = taskOf(tool);
      return task ? (
        <div className="cc-card-pad">
          <Todos input={{ todos: [{ content: `#${text(task.id) ?? "?"} ${text(task.subject) ?? ""}`, status: task.status }] }} />
          {text(task.description) && <div className="cc-dim cc-prose">{text(task.description)}</div>}
        </div>
      ) : (
        <ResultRow tool={tool} />
      );
    }
    case "TaskUpdate":
      return <ResultRow tool={tool} />;
    case "ExitPlanMode":
      return (
        <div className="cc-card-pad">
          <Markdown text={text(input.plan) ?? text(structured.plan) ?? ""} compact />
        </div>
      );
    case "AskUserQuestion": {
      const answers = rec(rec(tool.structured).answers ?? input.answers);
      const questions = Array.isArray(input.questions) ? input.questions.map(rec) : [];
      return (
        <div className="cc-card-pad cc-qa">
          {questions.map((question, index) => (
            <div key={index}>
              <div className="cc-dim">{text(question.question)}</div>
              <div className="text-fg-bright">{text(answers[text(question.question) ?? ""]) ?? "—"}</div>
            </div>
          ))}
          {tool.isError && <ResultRow tool={tool} />}
        </div>
      );
    }
    default:
      return (
        <>
          {Object.keys(input).length > 0 && (
            <Gutter label="IN">
              <Output text={JSON.stringify(input, null, 2)} />
            </Gutter>
          )}
          <ResultRow tool={tool} render={(result) => <Output text={pretty(result)} />} />
        </>
      );
  }
}

/** The short meta on a call's row: "+4 −1", "3 files", "120 lines". */
export function ToolMeta({ tool }: { tool: ToolCall }) {
  const structured = rec(tool.structured);
  switch (tool.name) {
    case "Edit":
    case "MultiEdit":
    case "Write": {
      const diff = toolDiff(tool);
      if (!diff?.length) return null;
      const { added, removed } = diffStats(diff);
      return (
        <span className="cc-tool-meta cc-num">
          <span className="text-ok">+{added}</span> <span className="text-err">−{removed}</span>
        </span>
      );
    }
    case "Grep":
    case "Glob": {
      if (tool.status !== "done") return null;
      const matches = typeof structured.numMatches === "number" ? structured.numMatches : undefined;
      const files = typeof structured.numFiles === "number" ? structured.numFiles : undefined;
      const count = matches ?? files;
      if (count === undefined) return null;
      return <span className="cc-tool-meta">{matches !== undefined ? `${count} match${count === 1 ? "" : "es"}` : `${count} file${count === 1 ? "" : "s"}`}</span>;
    }
    case "Read": {
      if (tool.status !== "done" || !tool.result) return null;
      const lines = tool.result.replace(/\n+$/, "").split("\n").length;
      return <span className="cc-tool-meta">{lines} lines</span>;
    }
    default:
      return null;
  }
}

/** Whether the call opens expanded: edits show their diff. */
export function opensExpanded(tool: ToolCall): boolean {
  return (tool.name === "Edit" || tool.name === "MultiEdit" || tool.name === "Write") && tool.status !== "streaming" && hasBody(tool);
}

/** TaskList's tasks, when its structured result has them. */
function taskListOf(tool: ToolCall): Record<string, unknown>[] {
  const tasks = rec(tool.structured).tasks;
  return Array.isArray(tasks) ? tasks.map(rec) : [];
}

/** TaskGet's task, when its structured result has one. */
function taskOf(tool: ToolCall): Record<string, unknown> | undefined {
  const task = rec(tool.structured).task;
  return task && typeof task === "object" ? rec(task) : undefined;
}

/** Whether a call has anything to show when expanded. Task updates say it all on their row. */
export function hasBody(tool: ToolCall): boolean {
  if (tool.isError && tool.result) return true;
  switch (tool.name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
      return Boolean(toolDiff(tool)?.length);
    // A task update says it all on its row (its errors are above).
    case "TaskUpdate":
      return false;
    case "TaskGet":
      return Boolean(taskOf(tool) || tool.result?.trim());
    case "TaskCreate":
      return Boolean(text(tool.input.description) || tool.result?.trim());
    case "TaskList":
      return taskListOf(tool).length > 0 || Boolean(tool.result?.trim());
    default:
      return Object.keys(tool.input).length > 0 || Boolean(tool.result);
  }
}
