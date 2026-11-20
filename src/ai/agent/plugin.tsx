import type { PanePlugin } from "../../plugins/types";
import { AgentPane } from "./AgentPane";
import { AGENT_KIND, isRunning, newPaneConversation, paneConversationOf, stopConversation } from "./conversation";

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
    menu: (ctx) => {
      const id = paneConversationOf(ctx.paneId);
      return [
        { label: "New conversation", commandId: "ai.agentNewConversation", run: () => newPaneConversation(ctx.paneId) },
        { label: "Stop", disabled: !isRunning(id), run: () => id && stopConversation(id) },
      ];
    },
  },
};
