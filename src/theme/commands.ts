import { Palette, SwatchBook } from "lucide-react";
import { registerCommands } from "../commands/registry";
import { openPicker } from "../palette/state";
import { openSettings, useSettingsDialog } from "../settings/dialogState";
import { registerSettingsSection } from "../settings/sections";
import { getSettings, useSettings } from "../settings/settings";
import { AppearanceSection } from "./AppearanceSection";
import { registerAppCloseBlockers } from "../closing";
import { isDraftDirty, mayEditAnother, startEditing, stopEditing, useThemeDraft } from "./editor/draft";
import { ThemeEditor } from "./editor/ThemeEditor";
import { allThemes, currentTheme, findTheme, selectTheme, useThemeState } from "./state";

/*
 * Theme commands for the palette and menus, and the Appearance and Theme
 * editor settings sections.
 */

/** The theme editor's settings section. */
export const THEME_EDITOR_SECTION = "theme-editor";

/** Opens Settings → Theme editor on a theme (asking first if the editor has unsaved edits to another one). */
export async function editTheme(themeId: string): Promise<void> {
  if (!findTheme(themeId) || !(await mayEditAnother(themeId))) return;
  startEditing(themeId);
  openSettings(THEME_EDITOR_SECTION);
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
  registerSettingsSection({
    id: "appearance",
    label: "Appearance",
    order: 10,
    icon: Palette,
    component: AppearanceSection,
    keywords: ["theme", "dark", "light", "font", "size", "accent", "color", "icons", "system"],
  });
  registerSettingsSection({
    id: THEME_EDITOR_SECTION,
    label: "Theme editor",
    order: 11,
    icon: SwatchBook,
    component: ThemeEditor,
    // Custom themes are global (themes.json), not per-workspace settings.
    scope: "shared",
    keywords: ["theme", "colors", "palette", "ansi", "tokens", "custom theme", "edit", "pane backgrounds"],
  });
  // Quitting or closing the window with unsaved theme edits asks first (and keeps them on Cancel).
  registerAppCloseBlockers(() => {
    const { draft } = useThemeDraft.getState();
    return draft && isDraftDirty() ? [{ type: "other", name: `The theme “${draft.name}” has unsaved changes` }] : [];
  });
  // The draft lives while the editor shows: leaving it (another section, or closing) drops it.
  useSettingsDialog.subscribe(({ open, section }) => {
    if ((!open || section !== THEME_EDITOR_SECTION) && useThemeDraft.getState().sourceId) stopEditing();
  });
  registerCommands([
    { id: "theme.select", title: "Theme: Select…", category: "View", run: pickTheme, menu: "View" },
    { id: "theme.editCurrent", title: "Theme: Edit current", category: "View", run: () => void editTheme(currentTheme().id) },
    { id: "theme.toggleLightDark", title: "Theme: Toggle light/dark", category: "View", run: toggleLightDark },
  ]);
}
