import type { MenuItemSpec, PaneContext, PanePlugin } from "../../plugins/types";
import { AgentPane } from "./AgentPane";
import { AGENT_KIND, isRunning, newPaneConversation, paneConversationOf, stopConversation } from "./conversation";

function conversationItems(ctx: PaneContext): MenuItemSpec[] {
  const id = paneConversationOf(ctx.paneId);
  return [
    { label: "New conversation", commandId: "ai.agentNewConversation", run: () => newPaneConversation(ctx.paneId) },
    { label: "Stop", disabled: !isRunning(id), run: () => id && stopConversation(id) },
  ];
}

/** The built-in Agent pane (registered by `installAi`). */
export const agentPlugin: PanePlugin = {
  id: AGENT_KIND,
  name: "Agent",
  description: "Works with your panes through plugin skills: reads commands and files, runs commands and edits files when you allow it.",
  icon: "sparkles",
  pane: {
    component: AgentPane,
    // The transcript is in memory only: nothing in the pane data to restore.
    validateData: () => ({}),
    tabTitle: () => "Agent",
    splittable: true,
    closeBlockers: async (paneId) => (isRunning(paneConversationOf(paneId)) ? [{ type: "running", name: "the agent" }] : []),
    menu: conversationItems,
    optionsMenu: conversationItems,
    // Asking the agent about its own pane makes no sense.
    hideMenuItems: ["agent"],
  },
};
