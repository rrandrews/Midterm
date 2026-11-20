/*
 * User settings: their shape, defaults, and validation of what is loaded
 * from disk. Pure; `settings.ts` holds the live store and persistence.
 */

/** The accents offered in the settings, from the mockup. Any `#rrggbb` is accepted. */
export const ACCENT_PRESETS = ["#8B9CFF", "#5EEAD4", "#F5A524", "#F472B6"] as const;

/** Bump when the saved shape changes, and migrate in `migrateSettings`. */
export const SETTINGS_VERSION = 3;

/**
 * A plugin's entry in the settings: whether it is enabled, its own settings
 * (validated against its declared fields when read, see
 * `src/plugins/settings.ts`), and which of its skills are switched off.
 */
export type PluginEntry = {
  /** Unset means enabled. */
  enabled?: boolean;
  settings?: Record<string, unknown>;
  /** Per-skill switches by skill id; unset means on. */
  skills?: Record<string, boolean>;
};

/** AI next-command suggestions (see docs/ai.md). Nothing is sent until a provider (and, for APIs, a model) is chosen. */
export type AiSettings = {
  /** Suggest next commands in blocks mode. On by default, inert without a provider. */
  suggestions: boolean;
  /** Provider id (`openai`, `anthropic`, `claude-code`, …); empty for none. */
  provider: string;
  /** Model id; empty means the CLI's default (CLI providers only). */
  model: string;
  /** Base URL for the `custom` provider. */
  baseUrl: string;
  /** Executable path overrides for CLI providers, by provider id. */
  cliPaths: Record<string, string>;
  /** Finished blocks sent as context. */
  contextBlocks: number;
};

export const AI_CONTEXT_RANGE = { min: 0, max: 20 } as const;

export type Settings = {
  version: number;
  /** CSS font family for terminals and the editor; the bundled JetBrains Mono when empty. */
  fontFamily: string;
  /** Terminal and editor font size, px. */
  fontSize: number;
  /** Overrides the theme's accent color (`#rrggbb`); empty for the theme's own. */
  accent: string;
  /** Id of the theme (bundled or custom). */
  theme: string;
  /** Follow the system's light or dark appearance, with `themeLight` / `themeDark`. */
  themeFollowSystem: boolean;
  themeLight: string;
  themeDark: string;
  /** Id of the file icon set (bundled or custom); a theme with its own set wins. */
  iconSet: string;
  /**
   * Keyboard shortcut overrides by command id. Each value replaces that
   * command's default bindings; an empty list unbinds it.
   */
  keybindings: Record<string, string[]>;
  /** Kind of the pane a new tab or a split opens (a plugin id); the terminal if that plugin is unavailable. */
  defaultPaneKind: string;
  /** Per-plugin entries, by plugin id. */
  plugins: Record<string, PluginEntry>;
  ai: AiSettings;
};

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  fontFamily: "",
  fontSize: 12.5,
  accent: "",
  theme: "midterm-dark",
  themeFollowSystem: false,
  themeLight: "midterm-light",
  themeDark: "midterm-dark",
  iconSet: "material",
  keybindings: {},
  defaultPaneKind: "terminal",
  plugins: {},
  ai: { suggestions: true, provider: "", model: "", baseUrl: "", cliPaths: {}, contextBlocks: 5 },
};

export const FONT_SIZE_RANGE = { min: 8, max: 32 } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function clampNumber(value: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

/** Version 1 kept the terminal's settings at the top level. */
const V1_TERMINAL_FIELDS = [
  "cursorStyle",
  "cursorBlink",
  "scrollback",
  "shell",
  "shellArgs",
  "terminalMode",
  "copyOnSelect",
  "bell",
  "terminalBackground",
] as const;

/**
 * Brings saved settings of any earlier version up to `SETTINGS_VERSION`.
 * Untrusted input in, untrusted output (still to be validated) out.
 */
export function migrateSettings(raw: unknown): Record<string, unknown> {
  const data: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  const version = typeof data.version === "number" ? data.version : 1;
  if (version < 2) {
    // The terminal's fields move into its plugin entry; fonts stay global.
    const plugins = isRecord(data.plugins) ? { ...data.plugins } : {};
    const terminal = isRecord(plugins.terminal) ? { ...plugins.terminal } : {};
    const settings = isRecord(terminal.settings) ? { ...terminal.settings } : {};
    for (const field of V1_TERMINAL_FIELDS) {
      if (field in data && !(field in settings)) settings[field] = data[field];
      delete data[field];
    }
    if (Object.keys(settings).length) plugins.terminal = { ...terminal, settings };
    data.plugins = plugins;
  }
  if (version < 3) {
    // The accent became an override of the theme's: the old default is the
    // default theme's own accent, so only a custom choice is kept.
    if (typeof data.accent === "string" && data.accent.toLowerCase() === "#8b9cff") data.accent = "";
  }
  data.version = SETTINGS_VERSION;
  return data;
}

function validateAi(raw: unknown): AiSettings {
  const d = DEFAULT_SETTINGS.ai;
  if (!isRecord(raw)) return { ...d, cliPaths: {} };
  const cliPaths: Record<string, string> = {};
  if (isRecord(raw.cliPaths)) for (const [id, path] of Object.entries(raw.cliPaths)) if (nonEmpty(path)) cliPaths[id] = path;
  return {
    suggestions: typeof raw.suggestions === "boolean" ? raw.suggestions : d.suggestions,
    provider: typeof raw.provider === "string" ? raw.provider : d.provider,
    model: typeof raw.model === "string" ? raw.model.trim() : d.model,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : d.baseUrl,
    cliPaths,
    contextBlocks: Math.round(clampNumber(raw.contextBlocks, AI_CONTEXT_RANGE, d.contextBlocks)),
  };
}

function validatePluginEntry(raw: unknown): PluginEntry | null {
  if (!isRecord(raw)) return null;
  const entry: PluginEntry = {};
  if (typeof raw.enabled === "boolean") entry.enabled = raw.enabled;
  if (isRecord(raw.settings)) entry.settings = raw.settings;
  if (isRecord(raw.skills)) {
    const skills: Record<string, boolean> = {};
    for (const [id, on] of Object.entries(raw.skills)) if (typeof on === "boolean") skills[id] = on;
    if (Object.keys(skills).length) entry.skills = skills;
  }
  return entry;
}

/**
 * Settings from untrusted data (the settings file, possibly hand-edited or
 * from another version): migrated, then every valid field is kept and
 * anything else falls back to its default. Plugin settings are kept as
 * they are here and validated by their fields when read.
 */
export function validateSettings(raw: unknown): Settings {
  const data = migrateSettings(raw);
  const d = DEFAULT_SETTINGS;
  const keybindings: Record<string, string[]> = {};
  if (isRecord(data.keybindings)) {
    for (const [id, value] of Object.entries(data.keybindings)) {
      const list = stringList(value);
      if (list) keybindings[id] = list;
    }
  }
  const plugins: Record<string, PluginEntry> = {};
  if (isRecord(data.plugins)) {
    for (const [id, value] of Object.entries(data.plugins)) {
      const entry = validatePluginEntry(value);
      if (entry) plugins[id] = entry;
    }
  }
  return {
    version: SETTINGS_VERSION,
    fontFamily: typeof data.fontFamily === "string" ? data.fontFamily.trim() : d.fontFamily,
    fontSize: clampNumber(data.fontSize, FONT_SIZE_RANGE, d.fontSize),
    accent: isHexColor(data.accent) ? data.accent : d.accent,
    theme: nonEmpty(data.theme) ? data.theme : d.theme,
    themeFollowSystem: typeof data.themeFollowSystem === "boolean" ? data.themeFollowSystem : d.themeFollowSystem,
    themeLight: nonEmpty(data.themeLight) ? data.themeLight : d.themeLight,
    themeDark: nonEmpty(data.themeDark) ? data.themeDark : d.themeDark,
    iconSet: nonEmpty(data.iconSet) ? data.iconSet : d.iconSet,
    keybindings,
    defaultPaneKind:
      typeof data.defaultPaneKind === "string" && data.defaultPaneKind ? data.defaultPaneKind : d.defaultPaneKind,
    plugins,
    ai: validateAi(data.ai),
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
  return args
    .map((arg) => {
      if (arg !== "" && !/[\s"']/.test(arg)) return arg;
      // No escapes in `splitArgs`: an argument with both kinds of quote cannot round-trip.
      return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
    })
    .join(" ");
}
