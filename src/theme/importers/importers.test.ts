import { describe, expect, it } from "vitest";
import { BUNDLED_THEMES } from "../bundled";
import { midtermDark } from "../bundled/midtermDark";
import { resolveTheme } from "../resolve";
import { importBase16 } from "./base16";
import { detectThemeFormat, importThemeFile } from "./index";
import { exportTheme, importMidtermTheme } from "./midterm";
import { importVSCodeTheme } from "./vscode";
import fixture0 from "./fixtures/night-owl-color-theme.json?raw";
import fixture1 from "./fixtures/gruvbox-dark-medium.yaml?raw";
import fixture2 from "./fixtures/catppuccin-latte.yaml?raw";
import fixture3 from "./fixtures/dracula-base24.yaml?raw";

// Fixtures come in through Vite's ?raw imports (no node:fs in the app's tsconfig).
const FIXTURES: Record<string, string> = {
  "night-owl-color-theme.json": fixture0,
  "gruvbox-dark-medium.yaml": fixture1,
  "catppuccin-latte.yaml": fixture2,
  "dracula-base24.yaml": fixture3,
};
const fixture = (name: string) => FIXTURES[name];

describe("Midterm JSON", () => {
  it("round-trips every bundled theme", () => {
    for (const theme of BUNDLED_THEMES) expect(importMidtermTheme(exportTheme(theme))).toEqual(theme);
  });

  it("marks the file format", () => {
    expect(JSON.parse(exportTheme(midtermDark)).midtermTheme).toBe(1);
  });

  it("throws clear errors", () => {
    expect(() => importMidtermTheme("{nope")).toThrow(/Not a Midterm theme/);
    expect(() => importMidtermTheme('{"name": "x"}')).toThrow(/Invalid theme:[\s\S]*kind/);
    expect(() => importMidtermTheme(JSON.stringify({ ...midtermDark, midtermTheme: 99 }))).toThrow(/newer Midterm/);
  });
});

describe("VS Code themes", () => {
  const theme = importVSCodeTheme(fixture("night-owl-color-theme.json"));

  it("reads the base palette", () => {
    expect(theme).toMatchObject({
      id: "night-owl-fixture",
      name: "Night Owl (fixture)",
      kind: "dark",
      background: "#011627",
      foreground: "#d6deeb",
      cursor: "#80a4c2",
      selection: "#1d3b53",
    });
  });

  it("skips accent candidates that are translucent or vanish into the background", () => {
    // focusBorder #122d42 is too close to the background, button.background is translucent,
    // activityBarBadge #44596b is too dim: the accent falls back to ANSI blue.
    expect(theme.accent).toBe("#82aaff");
  });

  it("reads the ANSI colors, expanding #rgb and #rgba", () => {
    expect(theme.ansi.red).toBe("#ef5350");
    expect(theme.ansi.white).toBe("#ffffff");
    expect(theme.ansi.brightWhite).toBe("#ffffff");
    expect(theme.ansi.brightCyan).toBe("#7fdbca");
  });

  it("maps workbench colors and token scopes onto tokens", () => {
    expect(theme.overrides).toMatchObject({
      field: "#0b253a",
      popover: "#021320",
      line: "#5f7e97",
      "fg-faint": "#4b6479",
      err: "#ef5350",
      warn: "#b39554",
      comment: "#637777",
      string: "#ecc48d",
      keyword: "#c792ea",
      function: "#82aaff",
      type: "#ffcb8b",
    });
    // Translucent: not mapped.
    expect(theme.overrides?.punctuation).toBeUndefined();
  });

  it("resolves", () => {
    expect(resolveTheme(theme).dark).toBe(true);
  });

  it("falls back to the default ANSI colors and the luminance for kind", () => {
    const light = importVSCodeTheme('{ "colors": { "editor.background": "#fafafa", "editor.foreground": "#333" } }', {
      name: "Plain",
    });
    expect(light.name).toBe("Plain");
    expect(light.kind).toBe("light");
    expect(light.ansi.blue).toBe("#0451a5");
    expect(light.accent).toBe("#0451a5");
  });

  it("puts a separate terminal background on the terminal panes", () => {
    const theme = importVSCodeTheme(
      '{ "colors": { "editor.background": "#101010", "editor.foreground": "#eeeeee", "terminal.background": "#ffffff", "terminal.foreground": "#111111" } }',
    );
    const resolved = resolveTheme(theme);
    expect(resolved.tokens.app).toBe("#101010");
    expect(resolved.tokens["terminal-fg"]).toBe("#111111");
    expect(resolved.tokens["terminal-solid"]).toBe("#ffffff");
    expect(resolved.panes.terminal).toMatchObject({ from: "#ffffff", to: "#ffffff" });
    expect(resolved.panes["terminal-active"]).toMatchObject({ from: "#ffffff", to: "#ffffff" });
  });

  it("throws clear errors", () => {
    expect(() => importVSCodeTheme("{ \"colors\": ")).toThrow(/Not a VS Code theme/);
    expect(() => importVSCodeTheme("[]")).toThrow(/expected an object/);
    expect(() => importVSCodeTheme('{ "name": "x" }')).toThrow(/no colors/);
    expect(() => importVSCodeTheme('{ "colors": { "foo": "#fff" } }')).toThrow(/editor.background/);
  });
});

describe("Base16 and Base24", () => {
  it("reads the original Base16 format", () => {
    const theme = importBase16(fixture("gruvbox-dark-medium.yaml"));
    expect(theme).toMatchObject({
      id: "gruvbox-dark-medium",
      name: "Gruvbox dark, medium",
      kind: "dark",
      author: "Dawid Kurek (dawikur@gmail.com), morhetz (https://github.com/morhetz/gruvbox)",
      background: "#282828",
      foreground: "#d5c4a1",
      accent: "#83a598",
      selection: "#504945",
    });
    expect(theme.ansi).toMatchObject({ black: "#282828", red: "#fb4934", brightBlack: "#665c54", brightRed: "#fb4934", brightWhite: "#fbf1c7" });
    expect(theme.overrides).toMatchObject({ comment: "#665c54", field: "#3c3836", raised: "#504945" });
  });

  it("reads the tinted-theming format with a variant", () => {
    const theme = importBase16(fixture("catppuccin-latte.yaml"));
    expect(theme).toMatchObject({ name: "Catppuccin Latte", kind: "light", background: "#eff1f5", foreground: "#4c4f69" });
    expect(theme.ansi.magenta).toBe("#8839ef");
  });

  it("uses Base24's bright colors", () => {
    const theme = importBase16(fixture("dracula-base24.yaml"));
    expect(theme.kind).toBe("dark");
    expect(theme.ansi).toMatchObject({
      red: "#ff5555",
      brightRed: "#f28c8c",
      brightYellow: "#eef5a3",
      brightGreen: "#5af78e",
      brightCyan: "#a4ffff",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
    });
  });

  it("keeps digits-only values as hex", () => {
    const yaml = fixture("gruvbox-dark-medium.yaml").replace('base00: "282828"', "base00: 000000");
    expect(importBase16(yaml).background).toBe("#000000");
  });

  it("throws clear errors", () => {
    expect(() => importBase16("scheme: x\nbase00: 000000")).toThrow(/missing base01/);
    expect(() => importBase16(fixture("gruvbox-dark-medium.yaml").replace('"fb4934"', '"nothex"'))).toThrow(/base08 is not a hex color/);
    expect(() => importBase16("- a\n- b")).toThrow(/expected a YAML mapping/);
    expect(() => importBase16("a: [")).toThrow(/Not a Base16 scheme/);
  });
});

describe("format detection", () => {
  it("goes by extension, then content", () => {
    expect(detectThemeFormat("x.itermcolors", "")).toBe("iterm");
    expect(detectThemeFormat("x.yml", "")).toBe("base16");
    expect(detectThemeFormat("x.json", exportTheme(midtermDark))).toBe("midterm");
    expect(detectThemeFormat("x.json", fixture("night-owl-color-theme.json"))).toBe("vscode");
    expect(detectThemeFormat("x.txt", "scheme: x")).toBe("base16");
    // Nested keys do not count: a markerless Midterm theme with metadata stays Midterm.
    const { midtermTheme: _, ...markerless } = JSON.parse(exportTheme(midtermDark));
    expect(detectThemeFormat("x.json", JSON.stringify({ ...markerless, metadata: { colors: {} } }))).toBe("midterm");
  });

  it("imports by detected format", () => {
    expect(importThemeFile("dracula-base24.yaml", fixture("dracula-base24.yaml")).name).toBe("Dracula");
    expect(importThemeFile("mine.json", exportTheme(midtermDark))).toEqual(midtermDark);
  });
});
