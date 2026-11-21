import { ArrowUpRight, ChevronRight } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { Markdown } from "../../components/ui/Markdown";
import { homeDirectory } from "../../ipc/system";
import { formatTokens, isAgentTool } from "../reduce";
import { focusTask, useSession } from "../store";
import type { Task, ToolCall as ToolCallModel, ToolStatus, TranscriptItem } from "../types";
import { formatElapsed, gistIsCode, mcpName, toolGist, toolLabel } from "./format";
import { PermissionPrompt } from "./PermissionPrompt";
import { ToolBody, ToolMeta, hasBody, opensExpanded } from "./tools";

/*
 * One tool call on the timeline: a row (name, gist, meta, elapsed time)
 * whose click toggles its card. A prompt waiting for the user sits right
 * under it. Agent/Task calls show a nested card for the subagent.
 */

const STATUS_WORD: Partial<Record<ToolStatus, string>> = { error: "Failed", denied: "Denied", cancelled: "Cancelled" };

/** Re-renders every second while `live`. */
export function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

const NO_TOOLS: Record<string, ToolCallModel> = {};

const isLive = (status: ToolStatus) => status === "running" || status === "pending" || status === "streaming";

function elapsedOf(tool: ToolCallModel, now: number): number {
  if (tool.endedAt) return tool.endedAt - tool.startedAt;
  if (tool.elapsed !== undefined) return Math.max(tool.elapsed * 1000, now - tool.startedAt);
  return now - tool.startedAt;
}

/** The dot's state for a call: `asking` when a prompt waits on it. */
export function dotState(status: ToolStatus, asking: boolean): string {
  if (asking) return "asking";
  if (isLive(status)) return "running";
  if (status === "done") return "ok";
  if (status === "error") return "err";
  return "warn";
}

function lastTool(items: TranscriptItem[] | undefined, tools: Record<string, ToolCallModel>): ToolCallModel | undefined {
  if (!items) return undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "tool" && tools[item.toolUseId]) return tools[item.toolUseId];
  }
  return undefined;
}

function AgentCard({ sessionKey, tool, task, cwd }: { sessionKey: string; tool: ToolCallModel; task: Task | undefined; cwd: string }) {
  const sub = useSession(sessionKey, (session) => session?.subTranscripts[tool.id]);
  const tools = useSession(sessionKey, (session) => session?.tools ?? NO_TOOLS);
  const [showReport, setShowReport] = useState(false);
  const running = task ? task.status === "running" || task.status === "pending" : isLive(tool.status);
  const now = useNow(running);
  const last = lastTool(sub, tools);
  const toolUses = task?.toolUses ?? sub?.filter((item) => item.kind === "tool").length ?? 0;
  const type = task?.subagentType ?? (typeof tool.input.subagent_type === "string" ? tool.input.subagent_type : "general-purpose");
  const elapsed = task?.durationMs ?? (task?.endedAt ? task.endedAt - task.startedAt : now - (task?.startedAt ?? tool.startedAt));
  const report = tool.status === "done" ? tool.result : undefined;
  const description = typeof tool.input.description === "string" ? tool.input.description : task?.description;
  const summary = task?.summary && task.summary !== description ? task.summary : undefined;
  const live = running ? (summary ?? (last ? `${toolLabel(last.name)}  ${toolGist(last, cwd, homeDirectory())}` : "Starting…")) : summary;

  return (
    <div className={`cc-agent${running ? " is-running" : ""}`}>
      <div className="cc-agent-head">
        <span className="cc-badge">{type}</span>
        {task?.backgrounded && <span className="cc-badge is-quiet">background</span>}
        <span className="cc-agent-counts cc-num">
          {[toolUses ? `${toolUses} tool${toolUses === 1 ? "" : "s"}` : undefined, task?.totalTokens ? `${formatTokens(task.totalTokens)} tokens` : undefined, formatElapsed(elapsed)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {live && (
        <div className="cc-agent-live">
          {running && <span className="cc-live-dot" />}
          <span className="cc-agent-live-text">{live}</span>
        </div>
      )}
      {report && showReport && (
        <div className="cc-agent-report">
          <Markdown text={report} compact />
        </div>
      )}
      <div className="cc-agent-foot">
        {report && (
          <button type="button" className="cc-link" onClick={() => setShowReport(!showReport)}>
            {showReport ? "Hide report" : "Show report"}
          </button>
        )}
        {task && (
          <button type="button" className="cc-link" onClick={() => focusTask(sessionKey, task.id)}>
            Open in Agents <ArrowUpRight size={10} />
          </button>
        )}
      </div>
    </div>
  );
}

export const ToolCall = memo(function ToolCall({ sessionKey, toolUseId, compact = false }: { sessionKey: string; toolUseId: string; compact?: boolean }) {
  const tool = useSession(sessionKey, (session) => session?.tools[toolUseId]);
  const cwd = useSession(sessionKey, (session) => session?.cwd ?? "");
  const permission = useSession(sessionKey, (session) => session?.permissions.find((request) => request.toolUseId === toolUseId));
  const task = useSession(sessionKey, (session) => (tool && isAgentTool(tool.name) ? Object.values(session?.tasks ?? {}).find((candidate) => candidate.toolUseId === toolUseId) : undefined));
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const now = useNow(tool ? isLive(tool.status) && !tool.endedAt : false);
  if (!tool) return null;

  const home = homeDirectory();
  const agent = isAgentTool(tool.name);
  const expanded = open ?? (opensExpanded(tool) && !compact);
  const canExpand = !agent && hasBody(tool);
  const gist = toolGist(tool, cwd, home);
  const mcp = mcpName(tool.name);
  const elapsed = elapsedOf(tool, now);
  const state = dotState(tool.status, Boolean(permission));
  const word = permission ? "Waiting for you" : STATUS_WORD[tool.status];

  return (
    <div className="cc-item cc-tool" data-dot={state}>
      <span className="cc-dot" aria-hidden="true" />
      <button type="button" className="cc-tool-row" aria-expanded={canExpand ? expanded : undefined} disabled={!canExpand} onClick={() => setOpen(!expanded)}>
        <span className="cc-tool-name">
          {mcp ? (
            <>
              <span className="cc-tool-server">{mcp.server}</span>
              <span className="cc-tool-sep">›</span>
              {mcp.tool}
            </>
          ) : (
            tool.name
          )}
        </span>
        {gist && <span className={`cc-tool-gist${gistIsCode(tool.name) ? " cc-mono" : ""}`}>{gist}</span>}
        <span className="cc-tool-end">
          <ToolMeta tool={tool} />
          {word && <span className={`cc-tool-word is-${state}`}>{word}</span>}
          {elapsed >= 1000 && <span className="cc-tool-time cc-num">{formatElapsed(elapsed)}</span>}
          {canExpand && <ChevronRight size={11} className="cc-chevron" aria-hidden="true" />}
        </span>
      </button>
      {agent && <AgentCard sessionKey={sessionKey} tool={tool} task={task} cwd={cwd} />}
      {permission && <PermissionPrompt sessionKey={sessionKey} request={permission} cwd={cwd} />}
      {expanded && canExpand && !permission && (
        <div className="cc-card">
          <ToolBody tool={tool} cwd={cwd} home={home} />
        </div>
      )}
    </div>
  );
});
