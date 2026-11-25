import { afterEach, describe, expect, it } from "vitest";
import { useSettings } from "../settings/settings";
import { pluginSettings } from "../plugins/settings";
import { PANE_THEME_KEY, paneResolvedTheme, paneThemeStyle, validatePaneTheme } from "./paneTheme";
import { currentResolvedTheme, findTheme, useThemeState } from "./state";

const setPaneTheme = (kind: string, value: unknown) => useSettings.getState().updatePluginSettings(kind, { [PANE_THEME_KEY]: value });

afterEach(() => {
  useThemeState.setState({ custom: [], preview: null, draft: null });
  useSettings.getState().resetSettings();
  useSettings.getState().updateSettings({ plugins: {} });
});

describe("validatePaneTheme", () => {
  it("keeps a theme id, known tokens with valid colors and the background, normalized", () => {
    expect(
      validatePaneTheme({ theme: "nord", overrides: { fg: "#ABC", bogus: "#fff", accent: "red" }, background: "#112233FF", extra: 1 }),
    ).toEqual({ theme: "nord", overrides: { fg: "#aabbcc" }, background: "#112233" });
  });

  it("is undefined for junk or an empty value", () => {
    expect(validatePaneTheme(null)).toBeUndefined();
    expect(validatePaneTheme([])).toBeUndefined();
    expect(validatePaneTheme({ theme: "", overrides: { nope: "#fff" } })).toBeUndefined();
  });
});

describe("pane themes", () => {
  it("follows the app until a theme or an override is set", () => {
    expect(paneResolvedTheme("explorer")).toBeNull();
    expect(paneThemeStyle("explorer")).toBeUndefined();
    setPaneTheme("explorer", { theme: "dracula" });
    const resolved = paneResolvedTheme("explorer");
    expect(resolved?.id).toBe("dracula");
    expect(paneThemeStyle("explorer")).toMatchObject({ "--color-app": resolved?.tokens.app, colorScheme: "dark" });
  });

  it("lays overrides over the app's theme, and derived tokens follow them", () => {
    // Midterm Dark pins most derived tokens; Nord derives them.
    useSettings.getState().updateSettings({ theme: "nord" });
    setPaneTheme("editor", { overrides: { fg: "#ff0000" } });
    const resolved = paneResolvedTheme("editor");
    expect(resolved?.id).toBe(currentResolvedTheme().id);
    expect(resolved?.tokens.fg).toBe("#ff0000");
    expect(resolved?.tokens["fg-muted"]).not.toBe(currentResolvedTheme().tokens["fg-muted"]);
    // Other kinds are untouched.
    expect(paneResolvedTheme("viewer")).toBeNull();
  });

  it("keeps the app's accent override on the app's theme, not on a picked one", () => {
    useSettings.getState().updateSettings({ accent: "#f472b6" });
    setPaneTheme("editor", { overrides: { fg: "#ff0000" } });
    expect(paneResolvedTheme("editor")?.tokens.accent).toBe("#f472b6");
    setPaneTheme("editor", { theme: "dracula" });
    expect(paneResolvedTheme("editor")?.tokens.accent).not.toBe("#f472b6");
  });

  it("lays overrides on the theme showing, the palette's preview included", () => {
    setPaneTheme("editor", { overrides: { fg: "#ff0000" } });
    useThemeState.setState({ preview: findTheme("nord") ?? null });
    expect(paneResolvedTheme("editor")?.id).toBe("nord");
  });

  it("falls back to the app's theme for a theme that no longer exists", () => {
    setPaneTheme("editor", { theme: "gone", overrides: { fg: "#00ff00" } });
    expect(paneResolvedTheme("editor")?.id).toBe(currentResolvedTheme().id);
  });

  it("sets only the pane background when that is all there is", () => {
    setPaneTheme("explorer", { background: "#101010" });
    expect(paneResolvedTheme("explorer")).toBeNull();
    expect(paneThemeStyle("explorer")).toEqual({ "--pane-bg": "#101010", "--pane-bg-active": "#101010" });
  });

  it("is not part of what a plugin reads as its settings", () => {
    useSettings.getState().updatePluginSettings("acme", { [PANE_THEME_KEY]: { theme: "nord" }, size: 3 });
    expect(pluginSettings("acme", undefined)).toEqual({ size: 3 });
  });
});
