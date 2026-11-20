import { activePaneId, addPaneBeside, livePane, openPaneBeside, selectTab } from "../../actions";
import { confirm } from "../../components/ui/ConfirmDialog";
import { focusPane } from "../../layout/dock";
import { openPrompt } from "../../palette/state";
import { openSettings } from "../../settings/SettingsDialog";
import { createPane, listPanes } from "../../state/layout";
import { findTabOfPane, selectActiveTab, useAppStore } from "../../state/store";
import {
  AGENT_KIND,
  agentProblem,
  askAgent,
  cardOf,
  handOff,
  isRunning,
  newPaneConversation,
  paneConversationOf,
  retargetPaneConversation,
  sendMessage,
  useAgent,
} from "./conversation";

/*
 * What the agent's commands, menus and `/agent` do: one-off requests in a
 * pane's card, moving a card's conversation into an Agent pane, and opening
 * or focusing the tab's Agent pane.
 */

/** The tab's Agent pane, if it has one. */
export function agentPaneOfTab(paneId: string | undefined): string | undefined {
  if (!paneId) return undefined;
  const tab = findTabOfPane(useAppStore.getState(), paneId);
  return tab && listPanes(tab.layout).find((pane) => pane.data.kind === AGENT_KIND)?.id;
}

/**
 * A one-off request against `paneId`, shown in its card. Asks first when
 * the card's conversation is still running. In an Agent pane, the task is
 * sent to its conversation instead.
 */
export function askAgentAbout(paneId: string, task: string): void {
  if (livePane(paneId)?.data.kind === AGENT_KIND) {
    const id = paneConversationOf(paneId);
    if (id && !isRunning(id)) {
      retargetPaneConversation(paneId, id);
      sendMessage(id, task);
    }
    return;
  }
  void askAgent(paneId, task, () =>
    confirm({
      title: "Replace the running request?",
      message: "The agent is still working on the last request in this pane. Stop it and start this one?",
      action: "Stop and replace",
    }),
  );
}

/** "AI: Ask the agent…": prompts for the task in the palette, then asks about the active pane. */
export function promptForAgent(paneId = activePaneId()): void {
  if (!paneId) return;
  if (agentProblem()) {
    openSettings("ai");
    return;
  }
  openPrompt({
    placeholder: "Ask the agent to do something with this pane…",
    hint: "↩ ask",
    onSubmit: (task) => askAgentAbout(paneId, task),
  });
}

/** Moves a card's conversation, state and all, into a new Agent pane beside its pane. */
export function continueInPane(cardPaneId: string): void {
  const id = cardOf(cardPaneId);
  if (!id || !useAgent.getState().conversations[id]) return;
  const pane = createPane(AGENT_KIND);
  handOff(id, cardPaneId, pane.id);
  addPaneBeside(cardPaneId, pane);
}

/** "AI: Open the agent": focuses the tab's Agent pane, or opens one beside the active pane. */
export function openAgent(fromPaneId = activePaneId()): void {
  const existing = agentPaneOfTab(fromPaneId);
  if (existing) focusPane(existing);
  else if (fromPaneId) openPaneBeside(AGENT_KIND, fromPaneId);
}

/** "AI: New agent conversation": in the active Agent pane, else the active tab's. */
export function agentNewConversation(): void {
  const active = activePaneId();
  const paneId = livePane(active)?.data.kind === AGENT_KIND ? active : agentPaneOfTab(active ?? selectActiveTab(useAppStore.getState()).activePaneId);
  if (!paneId) return;
  newPaneConversation(paneId);
  focusPane(paneId);
}

/** The tab menu's "Open the agent": the tab's Agent pane, or a new one beside its active pane. */
export function openAgentInTab(tabId: string): void {
  const state = useAppStore.getState();
  const tab = state.workspaces.flatMap((workspace) => workspace.tabs).find((candidate) => candidate.id === tabId);
  if (!tab) return;
  const panes = listPanes(tab.layout);
  const from = panes.find((pane) => pane.id === tab.activePaneId)?.id ?? panes[0]?.id;
  if (selectActiveTab(state).id === tabId) openAgent(from);
  else {
    // A pane is placed by measuring the shown layout: show the tab first.
    selectTab(tabId);
    requestAnimationFrame(() => openAgent(from));
  }
}
