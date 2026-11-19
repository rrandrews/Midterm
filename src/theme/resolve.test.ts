import { describe, expect, it } from "vitest";
import { midtermDark } from "./bundled/midtermDark";
import { midtermLight } from "./bundled/midtermLight";
import { lightness } from "./color";
import { contrastRatio, cssVariables, paneBackground, resolveTheme } from "./resolve";
import { TOKEN_NAMES, type Theme } from "./types";

/*
 * The values hard-coded in src/styles/index.css and src/terminal/theme.ts
 * before themes existed. Resolving Midterm Dark must reproduce them exactly.
 */
const INDEX_CSS: Record<string, string> = {
  "--color-app": "#0c0d10",
  "--color-field": "#15161b",
  "--color-popover": "#1a1c22",
  "--color-raised": "#2a2d35",
  "--color-line": "#1f2128",
  "--color-line-menu": "#262931",
  "--color-line-strong": "#2a2d35",
  "--color-line-block": "#ffffff0f",
  "--color-line-input": "#ffffff12",
  "--color-fg-bright": "#f2f3f5",
  "--color-fg": "#e4e5e9",
  "--color-fg-soft": "#d5d7dc",
  "--color-fg-mid": "#b9bcc4",
  "--color-fg-muted": "#9096a1",
  "--color-fg-dim": "#858a96",
  "--color-fg-faint": "#5a5f6a",
  "--color-accent": "#8b9cff",
  // index.css: color-mix(in srgb, var(--color-accent) 10%, transparent), i.e. the accent at 10% (0x1a ≈ 0.102).
  "--color-accent-soft": "#8b9cff1a",
  "--color-accent-fg": "#dde2ff",
  "--color-ok": "#a5d6a7",
  "--color-warn": "#f2c27b",
  "--color-err": "#e8868a",
  "--color-info": "#82b4ff",
  "--color-keyword": "#c3a6ff",
  "--color-comment": "#7f8592",
  "--color-string": "#a5d6a7",
  "--color-function": "#82b4ff",
  "--color-type": "#f2c27b",
  "--color-punctuation": "#9096a1",
  "--pane-explorer": "linear-gradient(180deg, #121317 0%, #0e0f12 100%)",
  "--pane-editor": "linear-gradient(175deg, #131419 0%, #0f1013 100%)",
  "--pane-terminal": "linear-gradient(185deg, #111216 0%, #0d0e11 100%)",
  "--pane-terminal-active": "linear-gradient(180deg, #15161c 0%, #111216 100%)",
  "--pane-viewer": "linear-gradient(170deg, #131419 0%, #0e0f12 100%)",
  // index.css writes it without stop positions: linear-gradient(180deg, #15161b, #121318).
  "--tab-active": "linear-gradient(180deg, #15161b 0%, #121318 100%)",
  "--terminal-solid": "#0e0f12",
  // index.css: 0 0 0 1px #2a2d35, 0 12px 32px rgb(0 0 0 / 0.5); 0x80 is 0.502.
  "--shadow-menu": "0 0 0 1px #2a2d35, 0 12px 32px #00000080",
};

/** TERMINAL_THEME in src/terminal/theme.ts. */
const XTERM = {
  background: "#00000000",
  foreground: "#d5d7dc",
  cursor: "#8b9cff",
  cursorAccent: "#0c0d10",
  selectionBackground: "#8b9cff40",
  selectionInactiveBackground: "#8b9cff26",
  black: "#15161b",
  red: "#e8868a",
  green: "#a5d6a7",
  yellow: "#f2c27b",
  blue: "#82b4ff",
  magenta: "#c3a6ff",
  cyan: "#5eead4",
  white: "#b9bcc4",
  brightBlack: "#5a5f6a",
  brightRed: "#f2a3a6",
  brightGreen: "#bfe5c0",
  brightYellow: "#f7d49b",
  brightBlue: "#a8cbff",
  brightMagenta: "#d6c2ff",
  brightCyan: "#8cf2e2",
  brightWhite: "#f2f3f5",
};

describe("Midterm Dark reproduces the original look", () => {
  const resolved = resolveTheme(midtermDark);
  const vars = cssVariables(resolved);

  it("matches every token in index.css", () => {
    for (const [name, value] of Object.entries(INDEX_CSS)) expect([name, vars[name]]).toEqual([name, value]);
  });

  it("matches the xterm palette in terminal/theme.ts", () => {
    expect(resolved.xterm).toEqual(XTERM);
  });

  it("matches the other hard-coded colors the token audit replaces", () => {
    // Menu / palette hover and selection: bg-white/[0.06]; search decorations in session.ts.
    expect(resolved.tokens.hover).toBe("#ffffff0f");
    expect(resolved.tokens.selected).toBe("#ffffff0f");
    expect(resolved.tokens["terminal-match"]).toBe("#8b9cff40");
    expect(resolved.tokens["terminal-match-active"]).toBe("#8b9cff99");
    expect(resolved.tokens.shadow).toBe("#00000080");
    // SOLID_BACKGROUND in terminal/theme.ts.
    expect(resolved.tokens["terminal-solid"]).toBe("#0e0f12");
  });

  it("is dark", () => {
    expect(resolved.dark).toBe(true);
    expect(resolved.kind).toBe("dark");
  });
});

describe("resolveTheme", () => {
  const base: Theme = { ...midtermDark, overrides: undefined, panes: undefined };

  it("derives every token as hex", () => {
    for (const theme of [base, midtermLight]) {
      const { tokens } = resolveTheme(theme);
      for (const name of TOKEN_NAMES) expect([name, tokens[name]]).toEqual([name, expect.stringMatching(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/)]);
    }
  });

  it("lets overrides win, and derives dependents from the override", () => {
    const { tokens } = resolveTheme({ ...base, overrides: { fg: "#ff0000", accent: "#00ff00" } });
    expect(tokens.fg).toBe("#ff0000");
    expect(tokens["terminal-fg"]).toBe("#ff0000");
    expect(tokens["fg-soft"]).not.toBe(resolveTheme(base).tokens["fg-soft"]);
    expect(tokens["accent-soft"]).toBe("#00ff001a");
    expect(tokens["terminal-cursor"]).toBe("#00ff00");
  });

  it("steps surfaces up in dark themes and down in light ones", () => {
    const dark = resolveTheme(base).tokens;
    expect(lightness(dark.field)).toBeGreaterThan(lightness(dark.app));
    expect(lightness(dark.raised)).toBeGreaterThan(lightness(dark.field));
    const light = resolveTheme(midtermLight).tokens;
    expect(lightness(light.field)).toBeLessThan(lightness(light.app));
    expect(lightness(light.raised)).toBeLessThan(lightness(light.field));
    expect(lightness(light["fg-faint"])).toBeGreaterThan(lightness(light.fg));
  });

  it("orders text tiers from brightest to faintest", () => {
    const t = resolveTheme(base).tokens;
    const tiers = ["fg-bright", "fg", "fg-soft", "fg-mid", "fg-muted", "fg-dim", "fg-faint"] as const;
    for (let i = 1; i < tiers.length; i++) expect(lightness(t[tiers[i]])).toBeLessThan(lightness(t[tiers[i - 1]]));
  });

  it("takes status and syntax from ANSI, keeping them readable", () => {
    const t = resolveTheme(base).tokens;
    expect(t.err).toBe(base.ansi.red);
    expect(t.keyword).toBe(base.ansi.magenta);
    const faint = resolveTheme({ ...base, ansi: { ...base.ansi, yellow: "#1a1a10" } }).tokens;
    expect(contrastRatio(faint.warn, faint.app)).toBeGreaterThanOrEqual(3);
  });

  it("uses the theme's cursor and selection", () => {
    const t = resolveTheme({ ...base, cursor: "#ffffff", selection: "#334455" });
    expect(t.xterm.cursor).toBe("#ffffff");
    expect(t.xterm.selectionBackground).toBe("#334455");
    expect(t.xterm.selectionInactiveBackground).toBe("#33445599");
  });

  it("chooses an accent-fg that reads on the background", () => {
    for (const theme of [base, midtermLight]) {
      const t = resolveTheme(theme).tokens;
      expect(contrastRatio(t["accent-fg"], t.app)).toBeGreaterThanOrEqual(7);
    }
  });
});

describe("pane backgrounds", () => {
  it("has every built-in pane and falls back to the default for unknown plugins", () => {
    const resolved = resolveTheme(midtermLight);
    for (const key of ["default", "terminal", "terminal-active", "explorer", "editor", "viewer"]) {
      expect(resolved.panes[key]).toBeDefined();
    }
    expect(paneBackground(resolved, "acme.notes")).toBe(resolved.panes.default);
  });

  it("publishes a theme's own plugin keys, filled from the default", () => {
    const resolved = resolveTheme({ ...midtermDark, panes: { "acme.notes": { from: "#101010" } } });
    expect(resolved.panes["acme.notes"]).toEqual({ ...resolved.panes.default, from: "#101010" });
    expect(cssVariables(resolved)["--pane-acme.notes"]).toMatch(/^linear-gradient\(180deg, #101010 0%/);
  });

  it("treats plugin ids like constructor as plain keys", () => {
    const plain = resolveTheme(midtermDark);
    expect(paneBackground(plain, "constructor")).toBe(plain.panes.default);
    const own = resolveTheme({ ...midtermDark, panes: { constructor: { from: "#101010" } } });
    expect(paneBackground(own, "constructor").from).toBe("#101010");
  });

  it("writes a solid pane as a plain color", () => {
    const resolved = resolveTheme({ ...midtermDark, panes: { editor: { from: "#222222", to: "#222222" } } });
    expect(cssVariables(resolved)["--pane-editor"]).toBe("#222222");
  });
});

describe("contrastRatio", () => {
  it("follows WCAG", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it("composites a translucent foreground over the background", () => {
    expect(contrastRatio("#ffffff00", "#000000")).toBe(1);
    expect(contrastRatio("#ffffff80", "#000000")).toBeLessThan(contrastRatio("#ffffff", "#000000"));
  });
});
