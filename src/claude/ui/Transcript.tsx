import { ChevronRight } from "lucide-react";
import { memo, useState } from "react";
import { Markdown } from "../../components/ui/Markdown";
import { usePluginSettings } from "../../plugins/settings";
import { CLAUDE_KIND } from "../client";
import type { TranscriptItem } from "../types";
import { formatCost } from "./panels/format";
import { formatElapsed } from "./format";
import { ToolCall } from "./ToolCall";

/*
 * A transcript as a timeline: a 1px rail on the left with a dot per item
 * (answers, thinking, tool calls, notices). User messages break the rail
 * as full-width boxes. Used for the main thread and, `compact`, for a
 * subagent's transcript in the Agents panel. Not a scroll container.
 */

type Item<K extends TranscriptItem["kind"]> = Extract<TranscriptItem, { kind: K }>;

const UserMessage = memo(function UserMessage({ item }: { item: Item<"user"> }) {
  return (
    <div className={`cc-user${item.queued ? " is-queued" : ""}`}>
      {item.images && item.images.length > 0 && (
        <div className="cc-user-images">
          {item.images.map((image, index) => (
            <img key={index} src={`data:${image.mediaType};base64,${image.data}`} alt="" className="cc-thumb" />
          ))}
        </div>
      )}
      {item.text && <div className="cc-user-text">{item.text}</div>}
      {item.queued && <span className="cc-user-queued">Queued</span>}
    </div>
  );
});

/** Thinking with nothing to show (display omitted, or redacted). */
const isBlankThinking = (item: TranscriptItem): boolean => item.kind === "thinking" && (item.redacted === true || item.text.trim() === "");

const Thinking = memo(function Thinking({ item }: { item: Item<"thinking"> }) {
  const [open, setOpen] = useState(false);
  if (isBlankThinking(item)) {
    // Only that Claude thought: a quiet line, nothing to open.
    return (
      <div className="cc-item cc-thinking is-blank" data-dot="hollow">
        <span className="cc-dot" aria-hidden="true" />
        <span className={`cc-thinking-blank${item.streaming ? " cc-shimmer" : ""}`}>{item.streaming ? "Thinking" : "Thought"}</span>
      </div>
    );
  }
  const preview = item.text.trim().split("\n")[0];
  return (
    <div className="cc-item cc-thinking" data-dot="hollow">
      <span className="cc-dot" aria-hidden="true" />
      <button type="button" className="cc-thinking-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={item.streaming ? "cc-shimmer" : undefined}>{item.streaming ? "Thinking" : "Thought"}</span>
        {!open && preview && <span className="cc-thinking-preview">{preview}</span>}
        <ChevronRight size={11} className="cc-chevron" aria-hidden="true" />
      </button>
      {open && <div className="cc-thinking-text">{item.text}</div>}
    </div>
  );
});

const Answer = memo(function Answer({ item }: { item: Item<"assistant"> }) {
  return (
    <div className="cc-item cc-answer" data-dot="answer">
      <span className="cc-dot" aria-hidden="true" />
      <Markdown text={item.text} compact className={item.streaming ? "is-streaming" : undefined} />
    </div>
  );
});

function Notice({ item }: { item: Item<"notice"> }) {
  return (
    <div className={`cc-item cc-notice is-${item.tone}`} data-dot={item.tone}>
      <span className="cc-dot" aria-hidden="true" />
      <span className="cc-notice-text">{item.text}</span>
    </div>
  );
}

function CommandOutput({ item }: { item: Item<"command"> }) {
  return (
    <div className="cc-item" data-dot="faint">
      <span className="cc-dot" aria-hidden="true" />
      <pre className="cc-pre cc-command-output">{item.text}</pre>
    </div>
  );
}

function Result({ item }: { item: Item<"result"> }) {
  const parts = [formatElapsed(item.durationMs) || undefined, item.costUsd > 0 ? formatCost(item.costUsd) : undefined].filter(Boolean);
  if (!parts.length) return null;
  return (
    <div className="cc-turn-end">
      <span className="cc-num">{parts.join(" · ")}</span>
    </div>
  );
}

function RailItem({ sessionKey, item, compact, showThinking }: { sessionKey: string; item: TranscriptItem; compact: boolean; showThinking: boolean }) {
  switch (item.kind) {
    case "assistant":
      return item.text ? <Answer item={item} /> : null;
    case "thinking":
      return showThinking ? <Thinking item={item} /> : null;
    case "tool":
      return <ToolCall sessionKey={sessionKey} toolUseId={item.toolUseId} compact={compact} />;
    case "notice":
      return <Notice item={item} />;
    case "command":
      return <CommandOutput item={item} />;
    default:
      return null;
  }
}

type Group = Item<"user"> | Item<"result"> | TranscriptItem[];

/** Items in rail groups, broken by user messages and turn ends; queued messages last; runs of blank thinking as one. */
function groups(items: TranscriptItem[], compact: boolean): Group[] {
  const ordered = [...items.filter((item) => !(item.kind === "user" && item.queued)), ...items.filter((item) => item.kind === "user" && item.queued)];
  const out: Group[] = [];
  for (const item of ordered) {
    if (item.kind === "result") {
      if (!compact) out.push(item);
    } else if (item.kind === "user") out.push(item);
    else {
      const last = out[out.length - 1];
      if (!Array.isArray(last)) out.push([item]);
      else if (isBlankThinking(item) && last.length > 0 && isBlankThinking(last[last.length - 1])) {
        // The latest state under the first one's id (a stable key).
        last[last.length - 1] = { ...item, id: last[last.length - 1].id };
      } else last.push(item);
    }
  }
  return out;
}

export function Transcript({ sessionKey, items, compact = false }: { sessionKey: string; items: TranscriptItem[]; compact?: boolean }) {
  const showThinking = usePluginSettings(CLAUDE_KIND).showThinking !== false;
  return (
    <div className={`cc-transcript${compact ? " is-compact" : ""}`}>
      {groups(items, compact).map((group) =>
        !Array.isArray(group) && group.kind === "result" ? (
          <Result key={group.id} item={group} />
        ) : Array.isArray(group) ? (
          <div key={group[0].id} className="cc-rail">
            {group.map((item) => (
              <RailItem key={item.id} sessionKey={sessionKey} item={item} compact={compact} showThinking={showThinking} />
            ))}
          </div>
        ) : (
          <UserMessage key={group.id} item={group} />
        ),
      )}
    </div>
  );
}
