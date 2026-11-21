import { Check, ChevronRight, Copy, FileText, Minimize2, X } from "lucide-react";
import { memo, useState } from "react";
import { Markdown } from "../../components/ui/Markdown";
import { copyText } from "../../ipc/clipboard";
import { usePluginSettings } from "../../plugins/settings";
import { cancelQueuedMessage, openSessionFile } from "../store";
import { ANTIGRAVITY_KIND, type TranscriptItem } from "../types";
import { restoreDraftIntoComposer } from "./Composer";
import { formatElapsed, formatTokens } from "./format";
import { ToolCall } from "./ToolCall";

/*
 * Timeline transcript: 1px vertical rail with 7px status dots for thinking,
 * markdown answers (with hover Copy), tool calls, compaction cards, notices,
 * and command outputs. User messages break the rail as full-width cards;
 * queued messages can be edited/cancelled right back into the composer.
 */

type Item<K extends TranscriptItem["kind"]> = Extract<TranscriptItem, { kind: K }>;

const UserMessage = memo(function UserMessage({ sessionKey, item }: { sessionKey: string; item: Item<"user"> }) {
  const pullBack = () => {
    if (!item.queueId) return;
    const removed = cancelQueuedMessage(sessionKey, item.queueId);
    if (removed) restoreDraftIntoComposer(sessionKey, removed);
  };
  return (
    <div className={`ag-user${item.queued ? " is-queued" : ""}`}>
      {item.mentions && item.mentions.length > 0 && (
        <div className="ag-user-mentions">
          {item.mentions.map((mention, index) => (
            <button
              key={`${mention.path}:${index}`}
              type="button"
              className="ag-mention-pill ag-mono"
              title={`Open ${mention.label}`}
              onClick={() => openSessionFile(sessionKey, mention.path)}
            >
              <FileText size={10} />
              <span>@{mention.label}</span>
            </button>
          ))}
        </div>
      )}
      {item.images && item.images.length > 0 && (
        <div className="ag-user-images">
          {item.images.map((image, index) => (
            <img key={index} src={`data:${image.mediaType};base64,${image.data}`} alt="" className="ag-thumb" />
          ))}
        </div>
      )}
      {item.text && <div className="ag-user-text">{item.text}</div>}
      {item.queued && (
        <div className="ag-user-queued-row">
          <span className="ag-user-queued">Queued</span>
          {item.queueId && (
            <button type="button" className="ag-link" title="Remove from queue and edit" onClick={pullBack}>
              <X size={10} /> Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
});

const Thinking = memo(function Thinking({ item }: { item: Item<"thinking"> }) {
  const [open, setOpen] = useState(false);
  const preview = item.text.trim().split("\n")[0];
  return (
    <div className="ag-item ag-thinking" data-dot="hollow">
      <span className="ag-dot" aria-hidden="true" />
      <button type="button" className="ag-thinking-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={item.streaming ? "ag-shimmer" : undefined}>{item.streaming ? "Thinking" : "Thought"}</span>
        {!open && preview && <span className="ag-thinking-preview">{preview}</span>}
        <ChevronRight size={11} className="ag-chevron" aria-hidden="true" />
      </button>
      {open && <div className="ag-thinking-text">{item.text}</div>}
    </div>
  );
});

const Answer = memo(function Answer({ item }: { item: Item<"assistant"> }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(item.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="ag-item ag-answer" data-dot="answer">
      <span className="ag-dot" aria-hidden="true" />
      <div className="ag-answer-wrap">
        <Markdown text={item.text} compact className={item.streaming ? "is-streaming" : undefined} />
        {!item.streaming && item.text.trim() && (
          <button type="button" className="ag-copy-btn" title={copied ? "Copied" : "Copy answer"} aria-label="Copy answer" onClick={() => void copy()}>
            {copied ? <Check size={11} className="text-ok" /> : <Copy size={11} />}
          </button>
        )}
      </div>
    </div>
  );
});

function Compaction({ item }: { item: Item<"compaction"> }) {
  const [open, setOpen] = useState(false);
  const running = item.status === "in_progress";
  const failed = item.status === "failed";
  const hasSummary = item.summary.trim().length > 0;
  return (
    <div className="ag-item ag-compaction" data-dot={running ? "running" : failed ? "err" : "hollow"}>
      <span className="ag-dot" aria-hidden="true" />
      <button
        type="button"
        className="ag-thinking-row"
        aria-expanded={hasSummary ? open : undefined}
        disabled={!hasSummary}
        onClick={() => setOpen(!open)}
      >
        <Minimize2 size={11} className="text-fg-dim flex-none" />
        <span className={running ? "ag-shimmer" : undefined}>
          {running ? "Compacting context" : failed ? "Compaction failed" : "Context compacted"}
        </span>
        {item.error && <span className="text-err">{item.error}</span>}
        {hasSummary && <ChevronRight size={11} className="ag-chevron" aria-hidden="true" />}
      </button>
      {open && hasSummary && <div className="ag-thinking-text">{item.summary}</div>}
    </div>
  );
}

function Notice({ item }: { item: Item<"notice"> }) {
  return (
    <div className={`ag-item ag-notice is-${item.tone}`} data-dot={item.tone}>
      <span className="ag-dot" aria-hidden="true" />
      <span className="ag-notice-text">
        <strong>{item.title}</strong>
        {item.description ? ` — ${item.description}` : ""}
      </span>
    </div>
  );
}

function CommandOutput({ item }: { item: Item<"command"> }) {
  return (
    <div className="ag-item" data-dot="faint">
      <span className="ag-dot" aria-hidden="true" />
      <pre className="ag-pre ag-command-output">{item.text}</pre>
    </div>
  );
}

function Result({ item }: { item: Item<"result"> }) {
  const parts = [
    formatElapsed(item.durationMs) || undefined,
    item.usage?.totalTokens ? `${formatTokens(item.usage.totalTokens)} tok` : undefined,
    item.stopReason === "cancelled" ? "Interrupted" : item.stopReason === "max_tokens" ? "Max tokens" : undefined,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <div className="ag-turn-end">
      <span className="ag-num">{parts.join(" · ")}</span>
    </div>
  );
}

function RailItem({ sessionKey, item, showThinking }: { sessionKey: string; item: TranscriptItem; showThinking: boolean }) {
  switch (item.kind) {
    case "assistant":
      return item.text ? <Answer item={item} /> : null;
    case "thinking":
      return showThinking && item.text.trim() ? <Thinking item={item} /> : null;
    case "tool":
      return <ToolCall sessionKey={sessionKey} toolCallId={item.toolCallId} />;
    case "compaction":
      return <Compaction item={item} />;
    case "notice":
      return <Notice item={item} />;
    case "command":
      return <CommandOutput item={item} />;
    default:
      return null;
  }
}

type Group = Item<"user"> | Item<"result"> | TranscriptItem[];

function groups(items: TranscriptItem[]): Group[] {
  const ordered = [...items.filter((i) => !(i.kind === "user" && i.queued)), ...items.filter((i) => i.kind === "user" && i.queued)];
  const out: Group[] = [];
  for (const item of ordered) {
    if (item.kind === "result" || item.kind === "user") {
      out.push(item);
    } else {
      const last = out[out.length - 1];
      if (!Array.isArray(last)) out.push([item]);
      else last.push(item);
    }
  }
  return out;
}

export function Transcript({ sessionKey, items }: { sessionKey: string; items: TranscriptItem[] }) {
  const showThinking = usePluginSettings(ANTIGRAVITY_KIND).showThinking !== false;
  return (
    <div className="ag-transcript">
      {groups(items).map((group) =>
        !Array.isArray(group) && group.kind === "result" ? (
          <Result key={group.id} item={group} />
        ) : Array.isArray(group) ? (
          <div key={group[0].id} className="ag-rail">
            {group.map((item) => (
              <RailItem key={item.id} sessionKey={sessionKey} item={item} showThinking={showThinking} />
            ))}
          </div>
        ) : (
          <UserMessage key={group.id} sessionKey={sessionKey} item={group} />
        ),
      )}
    </div>
  );
}
