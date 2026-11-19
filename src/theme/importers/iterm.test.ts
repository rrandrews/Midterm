// @vitest-environment happy-dom
// (for DOMParser; the rest of the suite runs in node)
import { describe, expect, it } from "vitest";
import { dracula } from "../bundled/dracula";
import { resolveTheme } from "../resolve";
import { importThemeFile } from "./index";
import { importItermColors } from "./iterm";
import fixture0 from "./fixtures/Dracula.itermcolors?raw";
import fixture1 from "./fixtures/Mixed Spaces.itermcolors?raw";

// Fixtures come in through Vite's ?raw imports (no node:fs in the app's tsconfig).
const FIXTURES: Record<string, string> = {
  "Dracula.itermcolors": fixture0,
  "Mixed Spaces.itermcolors": fixture1,
};
const fixture = (name: string) => FIXTURES[name];

describe("iTerm2 .itermcolors", () => {
  it("reads every color", () => {
    const theme = importItermColors(fixture("Dracula.itermcolors"), { name: "Dracula" });
    expect(theme).toMatchObject({
      id: "dracula",
      name: "Dracula",
      kind: "dark",
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#bbbbbb",
      selection: "#44475a",
      ansi: dracula.ansi,
    });
    expect(theme.overrides).toEqual({ "terminal-cursor-accent": "#ffffff" });
  });

  it("takes the accent from ANSI blue when the cursor is gray", () => {
    expect(importItermColors(fixture("Dracula.itermcolors")).accent).toBe("#bd93f9");
  });

  it("handles color spaces, missing color spaces, alpha and missing ANSI entries", () => {
    const theme = importItermColors(fixture("Mixed Spaces.itermcolors"), { name: "Mixed" });
    expect(theme.background).toBe("#000000");
    expect(theme.foreground).toBe("#cccccc");
    // Display P3 red is outside sRGB: gamut-mapped to a vivid sRGB red, used as the accent.
    expect(theme.cursor).toMatch(/^#ff[0-3][0-9a-f][0-3][0-9a-f]$/);
    expect(theme.accent).toBe(theme.cursor);
    expect(theme.ansi.blue).toBe("#0080ff");
    expect(theme.selection).toBe("#ffffff80");
    // Missing ANSI entries come from the defaults.
    expect(theme.ansi.red).toBe("#cd3131");
    expect(resolveTheme(theme).dark).toBe(true);
  });

  it("is picked by extension and named after the file", () => {
    expect(importThemeFile("/themes/Mixed Spaces.itermcolors", fixture("Mixed Spaces.itermcolors")).name).toBe("Mixed Spaces");
  });

  it("throws clear errors", () => {
    expect(() => importItermColors("<plist><dict>")).toThrow(/malformed/);
    expect(() => importItermColors("<html></html>")).toThrow(/no <plist> root/);
    expect(() => importItermColors('<plist version="1.0"><array/></plist>')).toThrow(/no top-level dict/);
    expect(() => importItermColors('<plist version="1.0"><dict/></plist>')).toThrow(/Background Color/);
    expect(() =>
      importItermColors(
        '<plist><dict><key>Background Color</key><dict><key>Red Component</key><real>1</real></dict></dict></plist>',
      ),
    ).toThrow(/Green Component/);
  });
});
