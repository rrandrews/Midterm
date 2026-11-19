import type { ITheme } from "@xterm/xterm";
import { ensureContrast, mix, opaque, shiftLightness, withAlpha } from "./color";
import {
  ANSI_NAMES,
  BUILTIN_PANES,
  type PaneBackground,
  type ResolvedTheme,
  type Theme,
  TOKEN_NAMES,
  type TokenName,
  ansiToken,
} from "./types";

export { contrastRatio } from "./color";

/*
 * Theme resolution: every token derived from the base palette, in dependency
 * order, with the theme's overrides winning as each token is set (so a token
 * derived from an overridden one sees the override). See docs/themes.md for
 * the rules.
 */

/** How far text tiers sit from the foreground toward the background (OKLab mix). */
const TEXT_MIX = {
  "fg-bright": -0.055,
  "fg-soft": 0.057,
  "fg-mid": 0.167,
  "fg-muted": 0.33,
  "fg-dim": 0.38,
  "fg-faint": 0.573,
} as const;

/** Mix ratio for `comment` (between `fg-muted` and `fg-dim`'s neighbours). */
const COMMENT_MIX = 0.4;

/** Derived pane backgrounds: OKLCH lightness offsets from the background. */
const PANE_STEPS: Record<(typeof BUILTIN_PANES)[number], [from: number, to: number, angle: number]> = {
  default: [0.026, 0.008, 180],
  terminal: [0.024, 0.005, 185],
  "terminal-active": [0.042, 0.024, 180],
  explorer: [0.028, 0.009, 180],
  editor: [0.033, 0.014, 175],
  viewer: [0.033, 0.009, 170],
};

/** Minimum contrast against `app` for status and syntax colors taken from ANSI. */
const MIN_COLOR_CONTRAST = 3;

/** `#rrggbb` + an alpha byte (0–255). */
const alphaByte = (hex: string, byte: number) => withAlpha(hex, byte / 255);

/** Own keys only: a plugin id such as `constructor` must not hit `Object.prototype`. */
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

export function resolveTheme(theme: Theme): ResolvedTheme {
  const dark = theme.kind === "dark";
  const overrides = theme.overrides ?? {};
  const bg = theme.background;
  const fg = theme.foreground;
  /** The far end beyond the foreground: white for dark themes, black for light ones. */
  const extreme = dark ? "#ffffff" : "#000000";

  const t = {} as Record<TokenName, string>;
  const set = (name: TokenName, derive: () => string) => {
    t[name] = overrides[name] ?? derive();
  };

  /**
   * A surface `dl` steps "up" from the background: lighter in a dark theme,
   * darker (and a little less) in a light one. Chroma grows slightly with the
   * step so a tinted background's surfaces stay visibly tinted.
   */
  const elevate = (dl: number) => shiftLightness(bg, dark ? dl : -dl * 0.7, 1 + dl * 9);
  /**
   * Pane and active-tab backgrounds are lighter than the window in both kinds:
   * content sits a touch above the chrome (in a light theme, toward white).
   */
  const lift = (dl: number) => shiftLightness(bg, dl, 1 + dl * 9);

  // Surfaces
  set("app", () => bg);
  set("field", () => elevate(0.042));
  set("popover", () => (dark ? elevate(0.068) : mix(bg, "#ffffff", 0.7)));
  set("raised", () => elevate(0.138));

  // Text
  set("fg", () => fg);
  for (const [name, ratio] of Object.entries(TEXT_MIX) as [TokenName, number][]) {
    set(name, () => mix(t.fg, t.app, ratio));
  }

  // Lines
  set("line", () => elevate(0.089));
  set("line-menu", () => elevate(0.122));
  set("line-strong", () => t.raised);
  set("line-block", () => alphaByte(t.fg, 0x0f));
  set("line-input", () => alphaByte(t.fg, 0x12));

  // Accent
  set("accent", () => theme.accent);
  set("accent-soft", () => alphaByte(t.accent, 0x1a));
  set("accent-fg", () => ensureContrast(mix(t.accent, extreme, dark ? 0.7 : 0.45), t.app, 7, extreme));

  // States
  set("hover", () => alphaByte(t.fg, 0x0f));
  set("selected", () => alphaByte(t.fg, 0x1a));
  set("scrim", () => (dark ? "#00000059" : "#00000033"));
  set("shadow", () => (dark ? "#00000080" : "#00000029"));

  // ANSI
  for (const name of ANSI_NAMES) set(ansiToken(name), () => theme.ansi[name]);

  // Status and syntax, from the ANSI hues, pushed toward the foreground if they would be unreadable.
  const readable = (color: string) => ensureContrast(color, t.app, MIN_COLOR_CONTRAST, t.fg);
  set("ok", () => readable(t["ansi-green"]));
  set("warn", () => readable(t["ansi-yellow"]));
  set("err", () => readable(t["ansi-red"]));
  set("info", () => readable(t["ansi-blue"]));
  set("keyword", () => readable(t["ansi-magenta"]));
  set("string", () => readable(t["ansi-green"]));
  set("function", () => readable(t["ansi-blue"]));
  set("type", () => readable(t["ansi-yellow"]));
  set("comment", () => mix(t.fg, t.app, COMMENT_MIX));
  set("punctuation", () => t["fg-muted"]);

  // Pane backgrounds
  const panes: Record<string, PaneBackground> = {};
  const derivePane = (key: string): PaneBackground => {
    const [from, to, angle] = PANE_STEPS[key as keyof typeof PANE_STEPS] ?? PANE_STEPS.default;
    return { from: lift(from), to: lift(to), angle };
  };
  for (const key of BUILTIN_PANES) panes[key] = { ...derivePane(key), ...theme.panes?.[key] };
  for (const [key, pane] of Object.entries(theme.panes ?? {})) {
    if (!hasOwn(panes, key)) panes[key] = { ...panes.default, ...pane };
  }

  set("terminal-solid", () => panes.terminal.to);
  set("tab-active-from", () => (dark ? t.field : lift(0.042)));
  set("tab-active-to", () => lift(0.028));

  // Terminal
  set("terminal-bg", () => "#00000000");
  set("terminal-fg", () => t.fg);
  set("terminal-cursor", () => theme.cursor ?? t.accent);
  set("terminal-cursor-accent", () => t.app);
  set("terminal-selection", () => theme.selection ?? alphaByte(t.accent, 0x40));
  set("terminal-selection-inactive", () => alphaByte(opaque(t["terminal-selection"]), selectionInactiveAlpha(t)));
  set("terminal-match", () => alphaByte(t.accent, 0x40));
  set("terminal-match-active", () => alphaByte(t.accent, 0x99));

  for (const name of TOKEN_NAMES) {
    if (t[name] === undefined) throw new Error(`Token not derived: ${name}`);
  }

  return { id: theme.id, name: theme.name, kind: theme.kind, dark, tokens: t, panes, xterm: xtermTheme(t) };
}

/** The inactive selection is the active one at about 60% of its opacity. */
function selectionInactiveAlpha(t: Record<TokenName, string>): number {
  const sel = t["terminal-selection"];
  const alpha = sel.length === 9 ? parseInt(sel.slice(7), 16) : 255;
  return Math.round(alpha * 0.6);
}

function xtermTheme(t: Record<TokenName, string>): ITheme {
  const theme: ITheme = {
    background: t["terminal-bg"],
    foreground: t["terminal-fg"],
    cursor: t["terminal-cursor"],
    cursorAccent: t["terminal-cursor-accent"],
    selectionBackground: t["terminal-selection"],
    selectionInactiveBackground: t["terminal-selection-inactive"],
  };
  for (const name of ANSI_NAMES) theme[name] = t[ansiToken(name)];
  return theme;
}

/** The pane background for a pane plugin id, falling back to the theme's default. */
export function paneBackground(resolved: ResolvedTheme, pluginId: string): PaneBackground {
  return hasOwn(resolved.panes, pluginId) ? resolved.panes[pluginId] : resolved.panes.default;
}

/** A pane background as a CSS `background` value. */
export function paneGradient({ from, to, angle }: PaneBackground): string {
  return from === to ? from : `linear-gradient(${angle}deg, ${from} 0%, ${to} 100%)`;
}

/** The CSS custom property a token is published as. */
export function cssVariableName(token: TokenName): string {
  return token === "terminal-solid" ? "--terminal-solid" : `--color-${token}`;
}

/**
 * The CSS custom properties for a resolved theme, as set on `<html>`: one
 * `--color-<token>` per token (`--terminal-solid` keeps its current name),
 * `--pane-<key>` per pane background, and the composites `--tab-active` and
 * `--shadow-menu`.
 */
export function cssVariables(resolved: ResolvedTheme): Record<string, string> {
  const t = resolved.tokens;
  const vars: Record<string, string> = {};
  for (const name of TOKEN_NAMES) vars[cssVariableName(name)] = t[name];
  for (const [key, pane] of Object.entries(resolved.panes)) vars[`--pane-${key}`] = paneGradient(pane);
  vars["--tab-active"] = paneGradient({ from: t["tab-active-from"], to: t["tab-active-to"], angle: 180 });
  vars["--shadow-menu"] = `0 0 0 1px ${t["line-strong"]}, 0 12px 32px ${t.shadow}`;
  return vars;
}
