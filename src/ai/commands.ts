import { Sparkles } from "lucide-react";
import { livePane, updatePaneData } from "../actions";
import { registerCommands } from "../commands/registry";
import type { MenuItemSpec } from "../plugins/types";
import { openSettings } from "../settings/SettingsDialog";
import { registerSettingsSection } from "../settings/sections";
import { getSettings, useSettings } from "../settings/settings";
import { activeTerminal, requestedMode } from "../terminal/blockMode";
import type { Block } from "../terminal/blocks";
import { onSessionDisposed, peekSession } from "../terminal/sessions";
import { registerPlugin } from "../plugins/registry";
import { AiSection } from "./AiSection";
import { agentNewConversation, askAgentAbout, openAgent, promptForAgent } from "./agent/actions";
import { agentPlugin } from "./agent/plugin";
import { registerSlashHandler } from "./slash";
import { canFix, fixBlock } from "./blockAi";
import { dropPaneNotes, explainBlock } from "./blockNotes";
import { featureReady } from "./profiles";
import { aiConfigured, installAiEngine, paneAllows, paneSwitchedOff, suggestNow } from "./engine";

/*
 * AI commands, the per-pane switch in the terminal menu, and Settings → AI.
 */

export function toggleSuggestions(): void {
  useSettings.getState().updateAi({ suggestions: !getSettings().ai.suggestions });
}

/** The terminal menu's switch for one pane (kept in its pane data). */
export function aiMenuItems(paneId: string): MenuItemSpec[] {
  // Local predictions need no provider, so the switch shows whenever suggestions are on.
  if (!getSettings().ai.suggestions) return [];
  const on = paneAllows(paneId);
  return [
    {
      label: "Suggestions in this pane",
      checked: on,
      run: () => {
        if (!livePane(paneId)) return;
        if (on) paneSwitchedOff(paneId);
        updatePaneData(paneId, { aiSuggestions: on ? false : undefined });
      },
    },
  ];
}

/** Explain and Fix in the right-click menu of a block (when the `explain` feature has a model). */
export function blockAiMenuItems(paneId: string, block: Block): MenuItemSpec[] {
  if (!featureReady("explain")) return [];
  const failed = block.exitCode !== undefined && block.exitCode !== 0;
  return [
    {
      label: failed ? "Explain this error" : "Explain this output",
      disabled: !block.end || !block.command.trim(),
      run: () => explainBlock(paneId, block),
    },
    { label: "Fix this command", disabled: !block.end || !canFix(paneId, block), run: () => fixBlock(paneId, block) },
  ];
}

/** The active block terminal's last finished block with a command. */
function lastFinishedBlock(): { paneId: string; block: Block } | undefined {
  const paneId = activeTerminal();
  if (!paneId || requestedMode(paneId) !== "blocks") return undefined;
  const blocks = peekSession(paneId)?.blocks.snapshot().blocks ?? [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].end !== undefined && blocks[i].command.trim()) return { paneId, block: blocks[i] };
  }
  return undefined;
}

/** Runs `act` on the last finished block, or opens Settings → AI when Explain and fix has no model. */
function onLastBlock(act: (paneId: string, block: Block) => void): void {
  if (!featureReady("explain")) {
    openSettings("ai");
    return;
  }
  const last = lastFinishedBlock();
  if (last) act(last.paneId, last.block);
}

let installed = false;

export function installAi(): void {
  if (installed) return;
  installed = true;
  installAiEngine();
  onSessionDisposed(dropPaneNotes);
  registerPlugin(agentPlugin, { type: "builtin" });
  registerSlashHandler("agent", (paneId, task) => {
    if (!task) return "Say what the agent should do: /agent <task>";
    askAgentAbout(paneId, task);
  });
  registerSettingsSection({
    id: "ai",
    label: "AI",
    order: 700,
    icon: Sparkles,
    component: AiSection,
    keywords: ["models", "provider", "api key", "suggestions", "agent", "effort"],
  });
  registerCommands([
    { id: "ai.toggleSuggestions", title: "AI: Toggle suggestions", category: "AI", run: toggleSuggestions },
    {
      id: "ai.suggestNow",
      title: "AI: Suggest a command now",
      category: "AI",
      run: () => {
        const paneId = activeTerminal();
        if (!paneId) return;
        if (!suggestNow(paneId) && !aiConfigured()) openSettings("ai");
      },
    },
    {
      id: "ai.explainLastCommand",
      title: "AI: Explain the last command",
      category: "AI",
      run: () => onLastBlock(explainBlock),
    },
    {
      id: "ai.fixLastCommand",
      title: "AI: Fix the last command",
      category: "AI",
      run: () => onLastBlock(fixBlock),
    },
    { id: "ai.askAgent", title: "AI: Ask the agent…", category: "AI", run: promptForAgent },
    { id: "ai.openAgent", title: "AI: Open the agent", category: "AI", run: () => openAgent() },
    { id: "ai.agentNewConversation", title: "AI: New agent conversation", category: "AI", run: agentNewConversation },
    { id: "ai.openSettings", title: "AI: Settings…", category: "AI", run: () => openSettings("ai") },
  ]);
}
