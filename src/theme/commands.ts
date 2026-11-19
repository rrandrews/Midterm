import { activePaneId, livePane, openPaneBeside, updatePaneData } from "../actions";
import { registerCommands } from "../commands/registry";
import { focusPane } from "../layout/dock";
import { openPicker } from "../palette/state";
import { registerPlugin } from "../plugins/registry";
import { registerSettingsSection } from "../settings/sections";
import { getSettings, useSettings } from "../settings/settings";
import { selectAllPanes, useAppStore } from "../state/store";
import { AppearanceSection } from "./AppearanceSection";
import { themeEditorPlugin } from "./editor/plugin";
import { allThemes, currentTheme, findTheme, selectTheme, useThemeState } from "./state";

/*
 * Theme commands for the palette and menus, the Appearance settings
 * section and the theme editor plugin.
 */

/** Opens the theme editor on a theme: in an editor pane already open, else in a new pane beside the active one. */
export function editTheme(themeId: string): void {
  const existing = selectAllPanes(useAppStore.getState()).find((pane) => pane.data.kind === "theme-editor");
  if (existing) {
    updatePaneData(existing.id, { themeId });
    focusPane(existing.id);
    return;
  }
  const from = activePaneId();
  if (!from) return;
  openPaneBeside("theme-editor", from);
  // The new pane is the active one now.
  const created = activePaneId();
  if (created && livePane(created)?.data.kind === "theme-editor") updatePaneData(created, { themeId });
}

/** "Theme: Select…": a picker over the themes, previewing each as it is highlighted. */
export function pickTheme(): void {
  const current = currentTheme().id;
  openPicker({
    placeholder: "Select a theme",
    initial: current,
    items: allThemes().map((theme) => ({
      key: theme.id,
      title: theme.name,
      detail: `${theme.kind === "dark" ? "Dark" : "Light"}${theme.author ? ` · ${theme.author}` : ""}`,
    })),
    onHighlight: (id) => useThemeState.setState({ preview: findTheme(id) ?? null }),
    onChoose: (id) => {
      useThemeState.setState({ preview: null });
      selectTheme(id);
    },
    onCancel: () => useThemeState.setState({ preview: null }),
  });
}

/** Switches between the light and dark themes picked in the settings. */
export function toggleLightDark(): void {
  const settings = getSettings();
  const dark = currentTheme().kind === "dark";
  useSettings.getState().updateSettings({ themeFollowSystem: false, theme: dark ? settings.themeLight : settings.themeDark });
}

let installed = false;

export function installThemeCommands(): void {
  if (installed) return;
  installed = true;
  registerSettingsSection({ id: "appearance", label: "Appearance", order: 10, component: AppearanceSection });
  registerPlugin(themeEditorPlugin);
  registerCommands([
    { id: "theme.select", title: "Theme: Select…", category: "View", run: pickTheme, menu: "View" },
    { id: "theme.editCurrent", title: "Theme: Edit current", category: "View", run: () => editTheme(currentTheme().id) },
    { id: "theme.toggleLightDark", title: "Theme: Toggle light/dark", category: "View", run: toggleLightDark },
  ]);
}
