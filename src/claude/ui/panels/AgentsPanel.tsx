import { ArrowLeft, Bot, Square } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { focusTask, stopTask, useSession } from "../../store";
import type { Task } from "../../types";
import { Transcript } from "../Transcript";
import { formatDuration, formatTokens } from "./format";
import { Badge, Button, Dot, Empty, ErrorLine, Heading, IconButton, Section, type Tone, Toolbar, useNow, useRowCommands } from "./shared";

/*
 * Agents: every background task and subagent of the session as a live tree
 * (by `parentTaskId`). Selecting one shows its own transcript. Below the
 * tree, the agents this session can start.
 */

const STATUS: Record<Task["status"], { tone: Tone; label: string; hollow?: boolean }> = {
  pending: { tone: "dim", label: "Pending", hollow: true },
  running: { tone: "accent", label: "Running" },
  paused: { tone: "warn", label: "Paused", hollow: true },
  completed: { tone: "ok", label: "Completed" },
  failed: { tone: "err", label: "Failed" },
  killed: { tone: "err", label: "Killed" },
  stopped: { tone: "warn", label: "Stopped" },
};

type Node = { task: Task; depth: number };

/** Tasks in tree order (parents before children, each level by start time), with their depth. */
function flatten(tasks: Record<string, Task>): Node[] {
  const children = new Map<string | undefined, Task[]>();
  for (const task of Object.values(tasks)) {
    const parent = task.parentTaskId && tasks[task.parentTaskId] ? task.parentTaskId : undefined;
    const list = children.get(parent) ?? [];
    list.push(task);
    children.set(parent, list);
  }
  const out: Node[] = [];
  const visit = (parent: string | undefined, depth: number, seen: Set<string>) => {
    for (const task of (children.get(parent) ?? []).sort((a, b) => a.startedAt - b.startedAt)) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      out.push({ task, depth });
      visit(task.id, depth + 1, seen);
    }
  };
  visit(undefined, 0, new Set());
  return out;
}

function elapsed(task: Task, now: number): number {
  if (task.status === "running" || task.status === "pending") return now - task.startedAt;
  return task.durationMs ?? (task.endedAt ?? now) - task.startedAt;
}

export function AgentsPanel({ sessionKey }: { sessionKey: string }) {
  const tasks = useSession(sessionKey, (session) => session?.tasks);
  const focused = useSession(sessionKey, (session) => (session?.focusedTask ? session.tasks[session.focusedTask] : undefined));
  const agents = useSession(sessionKey, (session) => session?.init?.agents);
  const nodes = useMemo(() => flatten(tasks ?? {}), [tasks]);
  const running = nodes.filter((node) => node.task.status === "running").length;
  const now = useNow(1000, running > 0);
  const commands = useRowCommands();

  const stop = (task: Task) => void commands.run(task.id, "stop", () => stopTask(sessionKey, task.id));

  // Moving between the list and a task replaces the focused button: keep focus in the panel.
  const list = useRef<HTMLUListElement>(null);
  const shown = useRef<string | undefined>(undefined);
  const focusedId = focused?.id;
  useEffect(() => {
    const was = shown.current;
    shown.current = focusedId;
    if (was === focusedId) return;
    const drawer = document.activeElement?.closest(".cp-drawer") ?? null;
    if (document.activeElement && document.activeElement !== document.body && !drawer) return;
    if (focusedId) document.querySelector<HTMLElement>(".cp-drawer .cp-back")?.focus({ preventScroll: true });
    else if (was) list.current?.querySelector<HTMLElement>(`[data-task="${CSS.escape(was)}"]`)?.focus({ preventScroll: true });
  }, [focusedId]);

  if (focused) return <TaskDetail sessionKey={sessionKey} task={focused} now={now} stop={stop} busy={!!commands.busy[focused.id]} error={commands.errors[focused.id]} />;

  return (
    <>
      <Toolbar>
        <span className="cp-toolbar-text">
          {nodes.length === 0 ? "Agents" : `${nodes.length} ${nodes.length === 1 ? "task" : "tasks"}`}
          {running > 0 && <span className="cp-accent"> · {running} running</span>}
        </span>
      </Toolbar>
      <div className="cp-body">
        {nodes.length === 0 ? (
          <Empty icon={<Bot size={18} />} title="No agents have run yet">
            Subagents and background tasks appear here live, with their own transcripts.
          </Empty>
        ) : (
          <ul ref={list} className="cp-tasks" aria-label="Tasks">
            {nodes.map(({ task, depth }) => {
              const status = STATUS[task.status] ?? STATUS.pending;
              const isRunning = task.status === "running";
              return (
                <li key={task.id} className="cp-task" style={{ paddingLeft: depth * 14 }} data-depth={depth || undefined}>
                  <button type="button" className="cp-task-main" data-task={task.id} onClick={() => focusTask(sessionKey, task.id)}>
                    <span className="cp-task-line">
                      <Dot tone={status.tone} pulse={isRunning} hollow={status.hollow} label={status.label} />
                      {(task.subagentType ?? task.taskType) && <Badge mono>{task.subagentType ?? task.taskType}</Badge>}
                      <span className="cp-task-desc">{task.description}</span>
                      <span className="cp-task-time">{formatDuration(elapsed(task, now))}</span>
                    </span>
                    <span className="cp-task-meta">
                      <TaskMeta task={task} />
                    </span>
                    {commands.errors[task.id] && <span className="cp-row-error">{commands.errors[task.id]}</span>}
                  </button>
                  {isRunning && (
                    <IconButton label="Stop" className="cp-task-stop" busy={!!commands.busy[task.id]} onClick={() => stop(task)}>
                      <Square size={9} fill="currentColor" />
                    </IconButton>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {agents && agents.length > 0 && (
          <>
            <Heading aside={<span className="cp-mono">{agents.length}</span>}>Available agents</Heading>
            <ul className="cp-agents">
              {agents.map((agent) => (
                <li key={agent.name} className="cp-agent">
                  <div className="cp-agent-head">
                    <span className="cp-mono cp-fg">{agent.name}</span>
                    {agent.model && agent.model !== "inherit" && <Badge mono>{agent.model}</Badge>}
                  </div>
                  <div className="cp-agent-desc" title={agent.description}>
                    {agent.description}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

function TaskMeta({ task }: { task: Task }) {
  const parts: ReactNode[] = [];
  if (task.totalTokens !== undefined) parts.push(<span key="t">{formatTokens(task.totalTokens)} tokens</span>);
  if (task.toolUses !== undefined) parts.push(<span key="u">{task.toolUses} {task.toolUses === 1 ? "tool" : "tools"}</span>);
  if (task.lastToolName && task.status === "running") parts.push(<span key="l" className="cp-mono cp-fg-mid">{task.lastToolName}</span>);
  if (task.status === "failed" && task.error) parts.push(<span key="e" className="cp-err">{task.error}</span>);
  if (parts.length === 0) parts.push(<span key="s">{STATUS[task.status]?.label ?? task.status}</span>);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index} className="cp-meta-part">
          {part}
        </span>
      ))}
    </>
  );
}

function TaskDetail({
  sessionKey,
  task,
  now,
  stop,
  busy,
  error,
}: {
  sessionKey: string;
  task: Task;
  now: number;
  stop: (task: Task) => void;
  busy: boolean;
  error?: string;
}) {
  const items = useSession(sessionKey, (session) => (task.toolUseId ? session?.subTranscripts[task.toolUseId] : undefined));
  const status = STATUS[task.status] ?? STATUS.pending;
  const isRunning = task.status === "running";

  return (
    <>
      <Toolbar>
        <button type="button" className="cp-back" onClick={() => focusTask(sessionKey, undefined)}>
          <ArrowLeft size={12} />
          All agents
        </button>
        <span className="cp-grow" />
        {isRunning && (
          <Button variant="danger" busy={busy} onClick={() => stop(task)}>
            <Square size={8} fill="currentColor" />
            Stop
          </Button>
        )}
      </Toolbar>
      <div className="cp-body cp-body-flush">
        <div className="cp-task-head">
          <div className="cp-task-line">
            <Dot tone={status.tone} pulse={isRunning} hollow={status.hollow} label={status.label} />
            {(task.subagentType ?? task.taskType) && <Badge mono>{task.subagentType ?? task.taskType}</Badge>}
            <span className="cp-task-status">{status.label}</span>
            <span className="cp-grow" />
            <span className="cp-task-time">{formatDuration(elapsed(task, now))}</span>
          </div>
          <div className="cp-task-title">{task.description}</div>
          <div className="cp-task-meta">
            <TaskMeta task={task} />
          </div>
          {error && <ErrorLine>{error}</ErrorLine>}
          {task.prompt && (
            <Section title="Prompt">
              <div className="cp-prose">{task.prompt}</div>
            </Section>
          )}
          {task.summary && task.summary !== task.description && (
            <Section title="Summary" defaultOpen>
              <div className="cp-prose">{task.summary}</div>
            </Section>
          )}
        </div>
        <div className="cp-task-transcript">
          {items && items.length > 0 ? (
            <Transcript sessionKey={sessionKey} items={items} compact />
          ) : (
            <p className="cp-note">{task.toolUseId ? (isRunning ? "Waiting for the agent’s first message…" : "No messages.") : "This task has no transcript."}</p>
          )}
        </div>
      </div>
    </>
  );
}
