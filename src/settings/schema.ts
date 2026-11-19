/*
 * User settings: their shape, defaults, and validation of what is loaded
 * from disk. Pure; `settings.ts` holds the live store and persistence.
 */

export const CURSOR_STYLES = ["block", "bar", "underline"] as const;
export type CursorStyle = (typeof CURSOR_STYLES)[number];

export const TERMINAL_MODES = ["classic", "blocks"] as const;
export type TerminalMode = (typeof TERMINAL_MODES)[number];

export const BELL_MODES = ["off", "visual", "sound"] as const;
export type BellMode = (typeof BELL_MODES)[number];

export const TERMINAL_BACKGROUNDS = ["transparent", "solid"] as const;
export type TerminalBackground = (typeof TERMINAL_BACKGROUNDS)[number];

/** The accents offered in the settings, from the mockup. Any `#rrggbb` is accepted. */
export const ACCENT_PRESETS = ["#8B9CFF", "#5EEAD4", "#F5A524", "#F472B6"] as const;

export type Settings = {
  /** CSS font family for terminals and the editor; the bundled JetBrains Mono when empty. */
  fontFamily: string;
  /** Terminal and editor font size, px. */
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Lines of scrollback per terminal. */
  scrollback: number;
  /** Program to run in new terminals; the login shell when empty. */
  shell: string;
  /** Arguments for `shell` (ignored when `shell` is empty). */
  shellArgs: string[];
  /** Accent color, `#rrggbb`. */
  accent: string;
  /**
   * Keyboard shortcut overrides by command id. Each value replaces that
   * command's default bindings; an empty list unbinds it.
   */
  keybindings: Record<string, string[]>;
  /** How new terminal panes render. */
  terminalMode: TerminalMode;
  /** Selecting text in a terminal copies it. */
  copyOnSelect: boolean;
  bell: BellMode;
  /**
   * `transparent` lets the pane gradient show through the terminal (costs
   * some rendering speed); `solid` paints a flat background.
   */
  terminalBackground: TerminalBackground;
};

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: "",
  fontSize: 12.5,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10_000,
  shell: "",
  shellArgs: [],
  accent: ACCENT_PRESETS[0],
  keybindings: {},
  terminalMode: "classic",
  copyOnSelect: false,
  bell: "visual",
  terminalBackground: "transparent",
};

export const FONT_SIZE_RANGE = { min: 8, max: 32 } as const;
export const SCROLLBACK_RANGE = { min: 0, max: 1_000_000 } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function clampNumber(value: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Settings from untrusted data (the settings file, possibly hand-edited or
 * from another version): every valid field is kept, anything else falls
 * back to its default.
 */
export function validateSettings(raw: unknown): Settings {
  const data = isRecord(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  const keybindings: Record<string, string[]> = {};
  if (isRecord(data.keybindings)) {
    for (const [id, value] of Object.entries(data.keybindings)) {
      const list = stringList(value);
      if (list) keybindings[id] = list;
    }
  }
  return {
    fontFamily: typeof data.fontFamily === "string" ? data.fontFamily.trim() : d.fontFamily,
    fontSize: clampNumber(data.fontSize, FONT_SIZE_RANGE, d.fontSize),
    cursorStyle: oneOf(CURSOR_STYLES, data.cursorStyle, d.cursorStyle),
    cursorBlink: typeof data.cursorBlink === "boolean" ? data.cursorBlink : d.cursorBlink,
    scrollback: Math.round(clampNumber(data.scrollback, SCROLLBACK_RANGE, d.scrollback)),
    shell: typeof data.shell === "string" ? data.shell.trim() : d.shell,
    shellArgs: stringList(data.shellArgs) ?? d.shellArgs,
    accent: isHexColor(data.accent) ? data.accent : d.accent,
    keybindings,
    terminalMode: oneOf(TERMINAL_MODES, data.terminalMode, d.terminalMode),
    copyOnSelect: typeof data.copyOnSelect === "boolean" ? data.copyOnSelect : d.copyOnSelect,
    bell: oneOf(BELL_MODES, data.bell, d.bell),
    terminalBackground: oneOf(TERMINAL_BACKGROUNDS, data.terminalBackground, d.terminalBackground),
  };
}

const BUNDLED_MONO = '"JetBrains Mono Variable", "JetBrains Mono"';

/** The CSS font stack for monospaced text: the user's family first, then the bundled font and fallbacks. */
export function monoFontStack(fontFamily: string): string {
  const fallback = `${BUNDLED_MONO}, ui-monospace, Menlo, monospace`;
  if (!fontFamily) return fallback;
  // A bare name with spaces needs quotes to be one family.
  const family = /^["']|,/.test(fontFamily) ? fontFamily : `"${fontFamily.replace(/"/g, "")}"`;
  return `${family}, ${fallback}`;
}

/** Splits an argument line as a shell would for simple cases: whitespace, with "…" or '…' quoting. */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    args.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return args;
}

/** The inverse of `splitArgs`, quoting arguments that need it. */
export function joinArgs(args: string[]): string {
  return args.map((arg) => (arg === "" || /\s/.test(arg) ? (arg.includes('"') ? `'${arg}'` : `"${arg}"`) : arg)).join(" ");
}
