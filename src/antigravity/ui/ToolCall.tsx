import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk/unstable";
import {
  ArrowUpRight,
  ChevronRight,
  Eye,
  FilePen,
  Globe,
  MoveRight,
  Search,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";
import { homeDirectory } from "../../ipc/system";
import { openSessionFile, useSession } from "../store";
import type { AcpToolCall, AcpToolStatus } from "../types";
import { Diff } from "./Diff";
import { formatElapsed, gistIsCode, relativeTo, TOOL_KIND_LABELS, toolDiffs, toolGist } from "./format";
import { PermissionPrompt } from "./PermissionPrompt";

/*
 * ACP tool call timeline row + expandable card: displays ToolKind icon, title,
 * relative path gist, clickable file locations (opens in Midterm's editor),
 * native ACP diffs, clipped text output, and inline permission prompts.
 */

const OUTPUT_LINES = 12;

const KIND_ICONS: Record<ToolKind, typeof Wrench> = {
  read: Eye,
  edit: FilePen,
  delete: Trash2,
  move: MoveRight,
  search: Search,
  execute: Terminal,
  think: Sparkles,
  fetch: Globe,
  switch_mode: SlidersHorizontal,
  other: Wrench,
};

const STATUS_WORD: Partial<Record<AcpToolStatus, string>> = {
  failed: "Failed",
  denied: "Denied",
  cancelled: "Cancelled",
};

const isLive = (status: AcpToolStatus) => status === "pending" || status === "in_progress";

export function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

function dotState(status: AcpToolStatus, asking: boolean): string {
  if (asking) return "asking";
  if (isLive(status)) return "running";
  if (status === "completed") return "ok";
  if (status === "failed") return "err";
  return "warn";
}

function ClippedOutput({ text, tone }: { text: string; tone?: "err" }) {
  const [all, setAll] = useState(false);
  const lines = text.replace(/\n+$/, "").split("\n");
  const clipped = !all && lines.length > OUTPUT_LINES;
  return (
    <div className="ag-output">
      <pre className={`ag-pre${tone ? ` text-${tone}` : ""}`}>{clipped ? lines.slice(0, OUTPUT_LINES).join("\n") : lines.join("\n")}</pre>
      {lines.length > OUTPUT_LINES && (
        <button type="button" className="ag-more" onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

function Gutter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ag-gutter-row">
      <span className="ag-gutter">{label}</span>
      <div className="ag-gutter-body">{children}</div>
    </div>
  );
}

function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentTextBlocks(content: readonly ToolCallContent[]): string[] {
  const out: string[] = [];
  for (const item of content) {
    if (item.type !== "content") continue;
    const block = item.content;
    if (block.type === "text" && block.text) out.push(block.text);
    else if (block.type === "resource" && "text" in block.resource && block.resource.text) out.push(block.resource.text);
    else if (block.type === "resource_link") out.push(block.uri);
  }
  return out;
}

function hasCardBody(tool: AcpToolCall): boolean {
  if (tool.content.length > 0) return true;
  if (tool.rawInput !== undefined && tool.rawInput !== null) {
    if (typeof tool.rawInput === "object" && Object.keys(tool.rawInput as Record<string, unknown>).length === 0) {
      // empty object
    } else {
      return true;
    }
  }
  return tool.rawOutput !== undefined && tool.rawOutput !== null && tool.rawOutput !== "";
}

function ToolBody({ sessionKey, tool, cwd, home }: { sessionKey: string; tool: AcpToolCall; cwd: string; home?: string }) {
  const diffs = toolDiffs(tool.content);
  const texts = contentTextBlocks(tool.content);
  const inputObj =
    typeof tool.rawInput === "object" && tool.rawInput !== null && !Array.isArray(tool.rawInput)
      ? (tool.rawInput as Record<string, unknown>)
      : undefined;
  const command =
    tool.kind === "execute" && inputObj && (typeof inputObj.command === "string" || typeof inputObj.cmd === "string")
      ? String(inputObj.command ?? inputObj.cmd)
      : undefined;
  const hasInput =
    command !== undefined ||
    (tool.rawInput !== undefined &&
      tool.rawInput !== null &&
      !(inputObj && Object.keys(inputObj).length === 0));
  const tone = tool.status === "failed" ? "err" : undefined;

  return (
    <>
      {diffs.map((diff, idx) => (
        <Diff
          key={`${diff.path}:${idx}`}
          lines={diff.lines}
          header={{ label: relativeTo(diff.path, cwd, home), added: diff.added, removed: diff.removed }}
          onOpenFile={() => openSessionFile(sessionKey, diff.path)}
        />
      ))}
      {diffs.length === 0 && hasInput && (
        <Gutter label="IN">
          {command ? <pre className="ag-pre is-command">{command}</pre> : <ClippedOutput text={prettyJson(tool.rawInput)} />}
        </Gutter>
      )}
      {texts.length > 0 && (
        <Gutter label="OUT">
          <ClippedOutput text={texts.join("\n")} tone={tone} />
        </Gutter>
      )}
      {texts.length === 0 && diffs.length === 0 && tool.rawOutput !== undefined && tool.rawOutput !== null && tool.rawOutput !== "" && (
        <Gutter label="OUT">
          <ClippedOutput text={prettyJson(tool.rawOutput)} tone={tone} />
        </Gutter>
      )}
    </>
  );
}

export const ToolCall = memo(function ToolCall({ sessionKey, toolCallId }: { sessionKey: string; toolCallId: string }) {
  const tool = useSession(sessionKey, (s) => s?.tools[toolCallId]);
  const cwd = useSession(sessionKey, (s) => s?.cwd ?? "");
  const permission = useSession(sessionKey, (s) => s?.permissions.find((p) => p.toolCall.toolCallId === toolCallId));
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const now = useNow(tool ? isLive(tool.status) && !tool.endedAt : false);
  if (!tool) return null;

  const home = homeDirectory();
  const diffs = toolDiffs(tool.content);
  const totalAdded = diffs.reduce((acc, d) => acc + d.added, 0);
  const totalRemoved = diffs.reduce((acc, d) => acc + d.removed, 0);
  const canExpand = hasCardBody(tool);
  const defaultExpanded = diffs.length > 0;
  const expanded = open ?? defaultExpanded;
  const gist = toolGist(tool, cwd, home);
  const elapsed = (tool.endedAt ?? now) - tool.startedAt;
  const state = dotState(tool.status, Boolean(permission));
  const word = permission ? "Waiting for you" : STATUS_WORD[tool.status];
  const KindIcon = KIND_ICONS[tool.kind] ?? Wrench;
  const primaryLoc = tool.locations[0] ?? (diffs[0] ? { path: diffs[0].path, line: undefined } : undefined);

  return (
    <div className="ag-item ag-tool" data-dot={state}>
      <span className="ag-dot" aria-hidden="true" />
      <div className="ag-tool-line">
        <button
          type="button"
          className="ag-tool-row"
          aria-expanded={canExpand ? expanded : undefined}
          disabled={!canExpand}
          onClick={() => setOpen(!expanded)}
        >
          <KindIcon size={11} className="ag-tool-kind-icon" aria-hidden="true" />
          <span className="ag-tool-name">{tool.title || TOOL_KIND_LABELS[tool.kind]}</span>
          {gist && <span className={`ag-tool-gist${gistIsCode(tool.kind) ? " ag-mono" : ""}`}>{gist}</span>}
          <span className="ag-tool-end">
            {diffs.length > 0 && (
              <span className="ag-tool-meta ag-num">
                {totalAdded > 0 && <span className="text-ok">+{totalAdded}</span>}{" "}
                {totalRemoved > 0 && <span className="text-err">−{totalRemoved}</span>}
              </span>
            )}
            {word && <span className={`ag-tool-word is-${state}`}>{word}</span>}
            {elapsed >= 1000 && <span className="ag-tool-time ag-num">{formatElapsed(elapsed)}</span>}
            {canExpand && <ChevronRight size={11} className="ag-chevron" aria-hidden="true" />}
          </span>
        </button>
        {primaryLoc && (
          <button
            type="button"
            className="ag-tool-jump"
            title={`Open ${relativeTo(primaryLoc.path, cwd, home)}${primaryLoc.line ? `:${primaryLoc.line}` : ""} in editor`}
            aria-label="Open file in editor"
            onClick={() => openSessionFile(sessionKey, primaryLoc.path, primaryLoc.line ?? undefined)}
          >
            <ArrowUpRight size={11} />
          </button>
        )}
      </div>
      {permission && <PermissionPrompt sessionKey={sessionKey} request={permission} cwd={cwd} />}
      {expanded && canExpand && !permission && (
        <div className="ag-card">
          <ToolBody sessionKey={sessionKey} tool={tool} cwd={cwd} home={home} />
        </div>
      )}
    </div>
  );
});
