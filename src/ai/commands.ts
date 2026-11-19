import { livePane, updatePaneData } from "../actions";
import { registerCommands } from "../commands/registry";
import type { MenuItemSpec } from "../plugins/types";
import { openSettings } from "../settings/SettingsDialog";
import { registerSettingsSection } from "../settings/sections";
import { getSettings, useSettings } from "../settings/settings";
import { activeTerminal } from "../terminal/blockMode";
import { AiSection } from "./AiSection";
import { aiConfigured, installAiEngine, paneAllows, suggestNow } from "./engine";

/*
 * AI commands, the per-pane switch in the terminal menu, and Settings → AI.
 */

export function toggleSuggestions(): void {
  useSettings.getState().updateAi({ suggestions: !getSettings().ai.suggestions });
}

/** The terminal menu's switch for one pane (kept in its pane data). */
export function aiMenuItems(paneId: string): MenuItemSpec[] {
  if (!aiConfigured()) return [];
  const on = paneAllows(paneId);
  return [
    {
      label: "AI suggestions in this pane",
      checked: on,
      run: () => {
        if (livePane(paneId)) updatePaneData(paneId, { aiSuggestions: on ? false : undefined });
      },
    },
  ];
}

let installed = false;

export function installAi(): void {
  if (installed) return;
  installed = true;
  installAiEngine();
  registerSettingsSection({ id: "ai", label: "AI", order: 700, component: AiSection });
  registerCommands([
    { id: "ai.toggleSuggestions", title: "AI: Toggle suggestions", category: "AI", run: toggleSuggestions },
    {
      id: "ai.suggestNow",
      title: "AI: Suggest a command now",
      category: "AI",
      run: () => {
        const paneId = activeTerminal();
        if (!paneId) return;
        if (!suggestNow(paneId)) openSettings("ai");
      },
    },
    { id: "ai.openSettings", title: "AI: Settings…", category: "AI", run: () => openSettings("ai") },
  ]);
}
