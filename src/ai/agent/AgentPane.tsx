import { ArrowUp, Settings2, SquarePen, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PaneProps } from "../../plugins/types";
import { openSettings } from "../../settings/SettingsDialog";
import { useSettings } from "../../settings/settings";
import { useAppStore } from "../../state/store";
import {
  agentProblem,
  describePane,
  holdPaneConversation,
  newPaneConversation,
  paneConversationOf,
  retargetPaneConversation,
  sendMessage,
  stopConversation,
  useAgent,
  workPaneFor,
} from "./conversation";
import { Transcript } from "./Transcript";

/*
 * The Agent pane: an extended exchange with the agent. Header: the pane it
 * works with (the tab's last active non-agent pane, fixed while a turn
 * runs), the model, New conversation. Then the transcript and a textarea
 * (⏎ sends, ⇧⏎ adds a line, Esc stops).
 */

export function AgentPane({ paneId, ctx }: PaneProps) {
  const id = useAgent((state) => state.panes[paneId]);
  const conversation = useAgent((state) => (id ? state.conversations[id] : undefined));
  // Re-evaluated when the AI settings change (a model chosen for the agent).
  const ai = useSettings((state) => state.ai);
  const problem = agentProblem();
  // Re-rendered as focus moves between panes, for "Working with".
  useAppStore((state) => state.workspaces);
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => holdPaneConversation(paneId), [paneId]);
  useEffect(() => {
    // Read the store, not `id` from this render: holding may have just handed one over.
    if (!problem && !paneConversationOf(paneId)) newPaneConversation(paneId);
  }, [problem, id, paneId, ai]);
  useEffect(() => ctx.onFocusRequest(() => input.current?.focus({ preventScroll: true })), [ctx]);

  // A conversation keeps the model it started with; the problem shows once there is none (New conversation).
  if (!id || !conversation) {
    return (
      <div className="agent-pane">
        <div className="agent-problem agent-problem-pane">
          <span className="text-warn">{problem ?? "Starting…"}</span>
          {problem && (
            <button type="button" className="agent-button" onClick={() => openSettings("ai")}>
              <Settings2 size={11} /> Settings → AI
            </button>
          )}
        </div>
      </div>
    );
  }

  const running = conversation.status === "running";
  const workPane = running ? conversation.targetPane : (workPaneFor(paneId) ?? conversation.targetPane);
  const described = workPane !== paneId ? describePane(workPane) : undefined;
  const send = () => {
    if (!text.trim() || running) return;
    retargetPaneConversation(paneId, id);
    sendMessage(id, text);
    setText("");
  };

  return (
    <div className="agent-pane">
      <div className="agent-pane-header">
        <span className="min-w-0 flex-1 truncate">
          Working with:{" "}
          <span className="text-fg-mid">{described ? [described.name, described.directory].filter(Boolean).join(" · ") : "no pane"}</span>
        </span>
        <span className="flex-none truncate text-fg-dim">{conversation.model}</span>
        <button type="button" className="block-action" title="New conversation" aria-label="New conversation" onClick={() => newPaneConversation(paneId)}>
          <SquarePen size={12} />
        </button>
      </div>
      {conversation.items.length === 0 ? (
        <div className="agent-empty">
          Ask the agent to do something with {described ? `the ${described.name.toLowerCase()}` : "your panes"}: read recent commands, run one, open or edit
          a file. Write actions ask first.
        </div>
      ) : (
        <Transcript conversationId={id} className="agent-pane-body" />
      )}
      <div className="agent-input">
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={running ? "The agent is working… esc stops" : "Ask the agent…"}
          aria-label="Message the agent"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            } else if (event.key === "Escape" && running) {
              event.preventDefault();
              stopConversation(id);
            }
          }}
        />
        {running ? (
          <button type="button" className="block-action" title="Stop" aria-label="Stop" onClick={() => stopConversation(id)}>
            <Square size={10} />
          </button>
        ) : (
          <button type="button" className="block-action" title="Send" aria-label="Send" disabled={!text.trim()} onClick={send}>
            <ArrowUp size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
