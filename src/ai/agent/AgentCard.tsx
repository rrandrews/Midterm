import { ChevronDown, ChevronUp, ClipboardCopy, PanelRightOpen, Settings2, Sparkles, Square, X } from "lucide-react";
import { useState } from "react";
import { copyText } from "../../ipc/clipboard";
import { openSettings } from "../../settings/SettingsDialog";
import { continueInPane } from "./actions";
import { isPluginEnabled, usePluginsVersion } from "../../plugins/registry";
import { AGENT_KIND, dismissCard, dismissCardProblem, stopConversation, useAgent, useCardProblems } from "./conversation";
import { Transcript, transcriptMarkdown } from "./Transcript";

/*
 * The agent card: a one-off request's conversation, docked at the bottom
 * of the pane it is about (any pane type). Rendered by the pane host, so
 * it outlives the blocks editor unmounting while the agent runs commands.
 */

function CardButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" className="block-action" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function AgentCard({ paneId }: { paneId: string }) {
  const id = useAgent((state) => state.cards[paneId]);
  const conversation = useAgent((state) => (id ? state.conversations[id] : undefined));
  const problem = useCardProblems((state) => state[paneId]);
  // Collapsed to its header, so the pane's bottom (a blocks prompt) is usable meanwhile.
  const [collapsed, setCollapsed] = useState(false);
  usePluginsVersion();

  if (problem && !conversation) {
    return (
      <div className="agent-card" role="region" aria-label="Agent">
        <div className="agent-card-header">
          <Sparkles size={12} className="text-fg-mid" />
          <span className="agent-card-title">Agent</span>
          <span className="ml-auto" />
          <CardButton label="Dismiss" onClick={() => dismissCardProblem(paneId)}>
            <X size={12} />
          </CardButton>
        </div>
        <div className="agent-problem">
          <span className="text-warn">{problem}</span>
          <button type="button" className="agent-button" onClick={() => openSettings("ai")}>
            <Settings2 size={11} /> Settings → AI
          </button>
        </div>
      </div>
    );
  }
  if (!id || !conversation) return null;

  const running = conversation.status === "running";
  const asking = conversation.items.some((item) => item.type === "tool" && item.status === "asking");
  const state = asking ? "waiting for you" : running ? "working…" : "";
  return (
    <div className={`agent-card${collapsed ? " is-collapsed" : ""}`} role="region" aria-label="Agent" data-conversation={id}>
      <div className="agent-card-header">
        <Sparkles size={12} className="text-fg-mid" />
        <span className="agent-card-title">Agent</span>
        <span className="agent-card-model">{conversation.model}</span>
        {state && <span className={`agent-card-state${asking ? " text-warn" : " animate-pulse"}`}>{state}</span>}
        <span className="ml-auto" />
        {running && (
          <CardButton label="Stop" onClick={() => stopConversation(id)}>
            <Square size={10} />
          </CardButton>
        )}
        <CardButton label="Copy" disabled={conversation.items.length === 0} onClick={() => void copyText(transcriptMarkdown(conversation.items))}>
          <ClipboardCopy size={12} />
        </CardButton>
        <CardButton label="Continue in agent pane" disabled={!isPluginEnabled(AGENT_KIND)} onClick={() => continueInPane(paneId)}>
          <PanelRightOpen size={12} />
        </CardButton>
        <CardButton label={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </CardButton>
        <CardButton label="Dismiss" onClick={() => dismissCard(paneId)}>
          <X size={12} />
        </CardButton>
      </div>
      {!collapsed && <Transcript conversationId={id} className="agent-card-body" />}
    </div>
  );
}
