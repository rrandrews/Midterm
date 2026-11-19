import { afterEach, describe, expect, it } from "vitest";
import { useSettings } from "../settings/settings";
import { midtermDark } from "./bundled";
import { claimEditor, discardDraft, releaseEditor, setKind, isDraftDirty, redo, saveDraft, setToken, startEditing, stopEditing, undo, useThemeDraft } from "./editor/draft";
import { resolveTheme } from "./resolve";
import { currentResolvedTheme, currentTheme, deleteTheme, duplicateTheme, findTheme, selectTheme, selectedThemeId, useThemeState, withAccent } from "./state";

afterEach(() => {
  stopEditing();
  useThemeState.setState({ custom: [], preview: null, draft: null });
  useSettings.getState().resetSettings();
});

describe("theme selection", () => {
  it("follows the system with the light and dark picks", () => {
    const settings = { ...useSettings.getState(), themeFollowSystem: true, themeLight: "nord-light", themeDark: "nord" };
    expect(selectedThemeId(settings, true)).toBe("nord");
    expect(selectedThemeId(settings, false)).toBe("nord-light");
    expect(selectedThemeId({ ...settings, themeFollowSystem: false, theme: "dracula" }, false)).toBe("dracula");
  });

  it("shows a preview over the selection, and falls back for an unknown id", () => {
    useSettings.getState().updateSettings({ theme: "does-not-exist" });
    expect(currentTheme().id).toBe("midterm-dark");
    useThemeState.setState({ preview: findTheme("dracula") ?? null });
    expect(currentTheme().id).toBe("dracula");
  });

  it("applies the accent override to the derived accent tokens", () => {
    const resolved = resolveTheme(withAccent(midtermDark, "#F472B6"));
    expect(resolved.tokens.accent).toBe("#f472b6");
    expect(resolved.tokens["terminal-cursor"]).toBe("#f472b6");
    useSettings.getState().updateSettings({ accent: "#F472B6" });
    expect(currentResolvedTheme().tokens.accent).toBe("#f472b6");
    useSettings.getState().updateSettings({ accent: "" });
    expect(currentResolvedTheme().tokens.accent).toBe(resolveTheme(midtermDark).tokens.accent);
  });

  it("duplicates and deletes custom themes; deleting the selected one falls back", () => {
    const copy = duplicateTheme("dracula");
    expect(copy?.id).toBe("dracula-copy");
    selectTheme(copy!.id);
    expect(useSettings.getState().theme).toBe("dracula-copy");
    deleteTheme("dracula-copy");
    expect(findTheme("dracula-copy")).toBeUndefined();
    expect(useSettings.getState().theme).toBe("midterm-dark");
  });
});

describe("theme editor draft", () => {
  it("edits live with undo and redo, and discards back to the saved theme", () => {
    startEditing("dracula");
    expect(isDraftDirty()).toBe(false);
    setToken("fg", "#123456");
    expect(isDraftDirty()).toBe(true);
    expect(useThemeState.getState().draft?.overrides?.fg).toBe("#123456");
    undo();
    expect(isDraftDirty()).toBe(false);
    expect(useThemeState.getState().draft).toBeNull();
    redo();
    expect(useThemeDraft.getState().draft?.overrides?.fg).toBe("#123456");
    discardDraft();
    expect(isDraftDirty()).toBe(false);
  });

  it("lets go of a system pick whose kind changed", () => {
    const copy = duplicateTheme("dracula")!;
    useSettings.getState().updateSettings({ themeDark: copy.id });
    startEditing(copy.id);
    setKind("light");
    saveDraft();
    expect(useSettings.getState().themeDark).toBe("midterm-dark");
  });

  it("gives the draft to one editor pane at a time", () => {
    expect(claimEditor("a")).toBe(true);
    expect(claimEditor("b")).toBe(false);
    releaseEditor("a");
    expect(claimEditor("b")).toBe(true);
  });

  it("saves a bundled theme as a new custom theme and shows it", () => {
    useSettings.getState().updateSettings({ theme: "dracula" });
    startEditing("dracula");
    setToken("err", "#ff0000");
    const saved = saveDraft();
    expect(saved?.id).not.toBe("dracula");
    expect(findTheme(saved!.id)?.overrides?.err).toBe("#ff0000");
    expect(useSettings.getState().theme).toBe(saved!.id);
    expect(isDraftDirty()).toBe(false);
  });
});
