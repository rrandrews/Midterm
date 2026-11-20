import { Ban, Check, ChevronDown, ChevronRight, CircleSlash, LoaderCircle, ShieldQuestion, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Markdown } from "../../components/ui/Markdown";
import { answerConfirm, sendMessage, useAgent } from "./conversation";
import type { ToolStatus, TranscriptItem } from "./loop";

/*
 * An agent conversation's transcript, shared by the agent card and the
 * Agent pane: the user's messages, Markdown answers, one row per tool call
 * (expandable to its input and result; a write tool waiting for the user
 * shows Allow / Allow for this conversation / Deny), loaded skills, errors
 * with Retry, and notes. Sticks to the bottom while new items arrive,
 * unless the user scrolled up.
 */

type ToolItem = Extract<TranscriptItem, { type: "tool" }>;

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: "running",
  asking: "waiting for you",
  done: "done",
  failed: "failed",
  denied: "denied",
  cancelled: "cancelled",
  skipped: "not run",
};

function StatusIcon({ status }: { status: ToolStatus }) {
  switch (status) {
    case "running":
      return <LoaderCircle size={11} className="animate-spin" />;
    case "asking":
      return <ShieldQuestion size={11} className="text-warn" />;
    case "done":
      return <Check size={11} className="text-ok" />;
    case "failed":
      return <X size={11} className="text-err" />;
    case "denied":
      return <Ban size={11} className="text-err" />;
    default:
      return <CircleSlash size={11} />;
  }
}

/** The input's gist for the collapsed row: a command, a path, or compact JSON. */
function inputSummary(input: unknown, invalid?: string): string {
  if (invalid !== undefined) return invalid;
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "path", "skill", "query"]) if (typeof record[key] === "string") return record[key] as string;
    const json = JSON.stringify(input);
    return json === "{}" ? "" : json;
  }
  return input === undefined || input === null ? "" : JSON.stringify(input);
}

function pretty(text: string | undefined): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const ToolRow = memo(function ToolRow({ conversationId, item }: { conversationId: string; item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const asking = item.status === "asking";
  const summary = inputSummary(item.input, item.invalid);
  const command = item.input && typeof item.input === "object" ? (item.input as { command?: unknown }).command : undefined;
  return (
    <div className={`agent-tool${asking ? " is-asking" : ""}`} data-status={item.status}>
      <button type="button" className="agent-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <StatusIcon status={item.status} />
        <span className="agent-tool-name">
          {item.skillTitle} › {item.tool}
        </span>
        {summary && !asking && <span className="agent-tool-summary">{summary}</span>}
        <span className="agent-tool-status">{STATUS_LABEL[item.status]}</span>
      </button>
      {asking && (
        <div className="agent-confirm">
          {typeof command === "string" ? (
            <pre className="agent-confirm-command">{command}</pre>
          ) : (
            <pre className="agent-confirm-command">{pretty(JSON.stringify(item.input))}</pre>
          )}
          <div className="agent-confirm-actions">
            <button type="button" className="agent-button is-primary" onClick={() => answerConfirm(conversationId, item.callId, "allow")}>
              Allow
            </button>
            <button type="button" className="agent-button" onClick={() => answerConfirm(conversationId, item.callId, "always")}>
              Allow for this conversation
            </button>
            <button type="button" className="agent-button" onClick={() => answerConfirm(conversationId, item.callId, "deny")}>
              Deny
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className="agent-tool-detail">
          <div className="agent-tool-label">Input</div>
          <pre>{item.invalid ?? pretty(JSON.stringify(item.input ?? null))}</pre>
          {item.result !== undefined && (
            <>
              <div className="agent-tool-label">Result</div>
              <pre>{pretty(item.result).slice(0, 4000)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
});

function Item({ conversationId, item, last, resume }: { conversationId: string; item: TranscriptItem; last: boolean; resume?: "retry" | "continue" }) {
  switch (item.type) {
    case "user":
      return <div className="agent-user">{item.text}</div>;
    case "assistant": {
      const state = item.cut ? "cut off at the token limit" : item.stopped ? "stopped" : "";
      return (
        <div className="agent-answer">
          <Markdown text={item.text} compact />
          {state && <div className="agent-meta">{state}</div>}
        </div>
      );
    }
    case "tool":
      return <ToolRow conversationId={conversationId} item={item} />;
    case "skill":
      return <div className="agent-meta">Loaded skill: {item.title}</div>;
    case "error":
      return (
        <div className="agent-error">
          <span className="text-err">{item.message}</span>
          {last && resume === "retry" && (
            <button type="button" className="agent-button" onClick={() => sendMessage(conversationId, null)}>
              Retry
            </button>
          )}
        </div>
      );
    case "note":
      return (
        <div className="agent-meta agent-note">
          <span>{item.text}</span>
          {last && resume === "continue" && (
            <button type="button" className="agent-button" onClick={() => sendMessage(conversationId, null)}>
              Continue
            </button>
          )}
        </div>
      );
  }
}

export function Transcript({ conversationId, className = "" }: { conversationId: string; className?: string }) {
  const conversation = useAgent((state) => state.conversations[conversationId]);
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const items = conversation?.items ?? [];
  const running = conversation?.status === "running";
  const lastItem = items[items.length - 1];
  const busy =
    (lastItem?.type === "assistant" && lastItem.streaming) ||
    (lastItem?.type === "tool" && (lastItem.status === "running" || lastItem.status === "asking"));
  const waiting = running && !busy;

  useEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  });

  if (!conversation) return null;
  return (
    <div
      ref={scroller}
      className={`agent-transcript ${className}`}
      onScroll={(event) => {
        const el = event.currentTarget;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {items.map((item, index) => (
        <Item key={item.id} conversationId={conversationId} item={item} last={index === items.length - 1} resume={conversation.resume} />
      ))}
      {waiting && <div className="agent-meta animate-pulse">thinking…</div>}
    </div>
  );
}

/** The conversation as Markdown, for Copy. */
export function transcriptMarkdown(items: readonly TranscriptItem[]): string {
  return items
    .map((item) => {
      switch (item.type) {
        case "user":
          return `> ${item.text.replace(/\n/g, "\n> ")}`;
        case "assistant":
          return item.text;
        case "tool":
          return `- ${item.skillTitle} › ${item.tool}: ${inputSummary(item.input, item.invalid)} (${STATUS_LABEL[item.status]})`;
        case "skill":
          return `- Loaded skill: ${item.title}`;
        case "error":
        case "note":
          return `_${item.type === "error" ? item.message : item.text}_`;
      }
    })
    .join("\n\n");
}
