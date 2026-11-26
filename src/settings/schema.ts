/*
 * User settings: their shape, defaults, and validation of what is loaded
 * from disk. Pure; `settings.ts` holds the live store and persistence.
 */

/** The accents offered in the settings, from the mockup. Any `#rrggbb` is accepted. */
export const ACCENT_PRESETS = ["#8B9CFF", "#5EEAD4", "#F5A524", "#F472B6"] as const;

/** Bump when the saved shape changes, and migrate in `migrateSettings`. */
export const SETTINGS_VERSION = 7;

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

/**
 * A model profile (see docs/ai.md): a provider, a model and how to ask it,
 * saved under a name. Features pick a profile by its id.
 */
export type AiProfile = {
  /** Stable generated id (`p-` + 8 base36 chars; migrated settings use `default`). */
  id: string;
  /** The alias shown in the settings; unique, case-insensitively. */
  name: string;
  /** Provider id (`openai`, `anthropic`, `claude-code`, …); an unknown id makes the profile "not ready". */
  provider: string;
  /** Model id; empty means the CLI's default (CLI providers only). */
  model: string;
  /** Base URL (`custom` only). */
  baseUrl: string;
  /** Executable path override (CLI providers only). */
  cliPath: string;
  /**
   * Reasoning effort. Missing: Midterm's pick (low, or nothing for a custom
   * server); `default`: nothing is sent and the provider decides. The
   * backend clamps a level to what the model offers.
   */
  effort?: EffortLevel;
  /** Extra request JSON merged into the request body (API providers only). */
  extra?: Record<string, unknown>;
};

/** Features that send requests to a model; each can use its own profile. */
export const AI_FEATURES = ["suggestions", "cmd", "explain", "agent", "commit"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** AI features (see docs/ai.md). Nothing is sent until a feature resolves to a ready profile. */
export type AiSettings = {
  /** Suggest next commands in blocks mode. On by default, inert without a profile. */
  suggestions: boolean;
  /** Finished blocks sent as context. */
  contextBlocks: number;
  /** Model profiles, in the order shown. */
  profiles: AiProfile[];
  /** Profile id used by every feature without an entry in `features`; "" for none. */
  defaultProfile: string;
  /** Per-feature overrides: feature → profile id. */
  features: Partial<Record<AiFeature, string>>;
};

export const AI_PROFILE_LIMIT = 50;
export const AI_PROFILE_NAME_MAX = 40;
/** The largest extra request JSON accepted, serialized (the backend's limit too). */
export const AI_EXTRA_MAX_BYTES = 16 * 1024;
/**
 * Top-level request keys extra JSON may not set. Mirrors `PROTECTED` in
 * src-tauri/src/ai/extra.rs (re-exported as `PROTECTED_EXTRA_KEYS` from
 * `ipc/ai.ts`).
 */
export const AI_PROTECTED_KEYS = ["model", "messages", "system", "stream", "tools", "tool_choice", "functions", "function_call", "n"] as const;

/** Reasoning effort levels, lowest first, plus `default` (send nothing). */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = "default" | (typeof EFFORT_LEVELS)[number];

function isEffortLevel(value: unknown): value is EffortLevel {
  return value === "default" || (EFFORT_LEVELS as readonly unknown[]).includes(value);
}

export const AI_CONTEXT_RANGE = { min: 0, max: 20 } as const;

/** An environment variable every new terminal shell gets. Values are literal (no `$VAR` expansion). */
export type EnvVar = { name: string; value: string };

/**
 * The Python environment new terminals activate once the user's startup
 * files have run: a virtualenv directory (`venv`) or a conda env name
 * (`conda`). `none` turns off one inherited from the defaults.
 */
export type PythonEnv = { kind: "none" | "venv" | "conda"; target: string };
export const PYTHON_KINDS = ["none", "venv", "conda"] as const;

/**
 * One workspace's settings (docs/workspaces.md). `overrides` holds the
 * settings it changes, shaped like `Settings` but sparse; everything else
 * comes from the defaults. `env` and `secrets` are added to the defaults'
 * (a name defined in both: the workspace's wins). Secret values live in the
 * OS keystore (`src/ipc/secrets.ts`), never here.
 */
export type WorkspaceSettings = {
  overrides: SettingsOverrides;
  env: EnvVar[];
  /** Names of secret environment variables. */
  secrets: string[];
};

/**
 * Top-level settings a workspace may override, each as a whole. Besides
 * these, a workspace may override single plugin settings
 * (`plugins.<id>.settings.<key>`) and the AI fields in `AI_OVERRIDABLE`.
 * Keyboard shortcuts, which plugins are enabled and the model profiles are
 * shared by every workspace.
 */
export const OVERRIDABLE = [
  "fontFamily",
  "fontSize",
  "accent",
  "theme",
  "themeFollowSystem",
  "themeLight",
  "themeDark",
  "iconSet",
  "defaultPaneKind",
  "defaultTerminal",
  "python",
] as const;
export type OverridableKey = (typeof OVERRIDABLE)[number];
export const AI_OVERRIDABLE = ["suggestions", "contextBlocks", "defaultProfile", "features"] as const;
type AiOverridableKey = (typeof AI_OVERRIDABLE)[number];

export type SettingsOverrides = Partial<Pick<Settings, OverridableKey>> & {
  plugins?: Record<string, { settings: Record<string, unknown> }>;
  ai?: Partial<Pick<AiSettings, AiOverridableKey>>;
};

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ENV_LIMIT = 200;
/**
 * Whether a name is Midterm's own: `MIDTERM_…` (set for shell
 * integration) or `_midterm…` (the integration scripts' variables, such as
 * their load guard). Not accepted as variables. Mirrors `reserved_name` in
 * src-tauri/src/pty/shell.rs.
 */
export function reservedEnvName(name: string): boolean {
  return name.toUpperCase().startsWith("MIDTERM_") || name.toLowerCase().startsWith("_midterm");
}

export function validEnvName(name: string): boolean {
  return ENV_NAME.test(name) && !reservedEnvName(name);
}

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
  /**
   * Kind of the pane a new tab or a split opens (a plugin id). A terminal
   * kind (`terminal` by default) means "the default terminal"
   * (`defaultTerminal`); so does a plugin that is unavailable.
   */
  defaultPaneKind: string;
  /**
   * The plugin new terminals open in (one flagged `terminal`): `terminal`
   * (classic) or `block-terminal`; the classic terminal if that plugin is
   * unavailable.
   */
  defaultTerminal: string;
  /** Per-plugin entries, by plugin id. */
  plugins: Record<string, PluginEntry>;
  ai: AiSettings;
  /** Environment variables for every terminal (workspaces add their own). */
  env: EnvVar[];
  /** Names of secret environment variables for every terminal; values in the keystore. */
  secrets: string[];
  python: PythonEnv;
  /**
   * Per-workspace settings by workspace id. Only meaningful in the saved
   * (default) settings; the effective settings carry the same object.
   */
  workspaces: Record<string, WorkspaceSettings>;
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
  defaultTerminal: "terminal",
  plugins: {},
  ai: { suggestions: true, contextBlocks: 5, profiles: [], defaultProfile: "", features: {} },
  env: [],
  secrets: [],
  python: { kind: "none", target: "" },
  workspaces: {},
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
  if (version < 4) {
    // Classic and blocks terminals became two plugins: the terminal's
    // "new terminals open in" setting becomes the default terminal.
    const plugins = isRecord(data.plugins) ? { ...data.plugins } : {};
    const terminal = isRecord(plugins.terminal) ? { ...plugins.terminal } : null;
    const settings = terminal && isRecord(terminal.settings) ? { ...terminal.settings } : null;
    if (terminal && settings && "terminalMode" in settings) {
      if (settings.terminalMode === "blocks" && !nonEmpty(data.defaultTerminal)) data.defaultTerminal = "block-terminal";
      delete settings.terminalMode;
      plugins.terminal = { ...terminal, settings };
      data.plugins = plugins;
    }
  }
  if (version < 5 && isRecord(data.ai) && !("profiles" in data.ai)) {
    // The single provider became model profiles: the old choice is one
    // profile, used by every feature. Effort and CLI paths remembered for
    // other providers are dropped.
    const ai = { ...data.ai };
    const provider = typeof ai.provider === "string" ? ai.provider : "";
    const model = typeof ai.model === "string" ? ai.model.trim() : "";
    if (provider) {
      const cliPaths = isRecord(ai.cliPaths) ? ai.cliPaths : {};
      const effort = isRecord(ai.effort) ? ai.effort[provider] : undefined;
      const profile: Record<string, unknown> = {
        id: "default",
        name: model || provider,
        provider,
        model,
        baseUrl: provider === "custom" && typeof ai.baseUrl === "string" ? ai.baseUrl : "",
        cliPath: typeof cliPaths[provider] === "string" ? cliPaths[provider] : "",
      };
      if (effort !== undefined) profile.effort = effort;
      ai.profiles = [profile];
      ai.defaultProfile = "default";
    } else {
      ai.profiles = [];
      ai.defaultProfile = "";
    }
    ai.features = {};
    for (const field of ["provider", "model", "baseUrl", "cliPaths", "effort"]) delete ai[field];
    data.ai = ai;
  }
  // Version 6 added env, secrets, python and workspaces; their defaults need no migration.
  if (version < 7 && isRecord(data.workspaces)) {
    // Version 7 merges workspace `ai.features` overrides per feature instead of
    // replacing the whole map; preserve legacy workspaces that explicitly chose
    // "Default" by omitting a feature present in base `ai.features`.
    const baseAi = isRecord(data.ai) ? data.ai : null;
    const baseFeatures = baseAi && isRecord(baseAi.features) ? baseAi.features : null;
    if (baseFeatures) {
      const workspaces: Record<string, unknown> = { ...data.workspaces };
      for (const [id, rawWs] of Object.entries(workspaces)) {
        if (!isRecord(rawWs) || !isRecord(rawWs.overrides) || !isRecord(rawWs.overrides.ai)) continue;
        const wsFeatures = rawWs.overrides.ai.features;
        if (!isRecord(wsFeatures)) continue;
        const migratedFeatures: Record<string, unknown> = { ...wsFeatures };
        for (const feature of AI_FEATURES) {
          if (feature in baseFeatures && !(feature in migratedFeatures)) {
            migratedFeatures[feature] = "";
          }
        }
        workspaces[id] = {
          ...rawWs,
          overrides: {
            ...rawWs.overrides,
            ai: { ...rawWs.overrides.ai, features: migratedFeatures },
          },
        };
      }
      data.workspaces = workspaces;
    }
  }
  data.version = SETTINGS_VERSION;
  return data;
}

const PROFILE_ID = /^[a-z0-9-]{1,40}$/;

/** Whether `value` is usable as a profile's extra request JSON: a plain object, small enough, with no protected key. */
export function validExtra(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (AI_PROTECTED_KEYS.some((key) => key in value)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= AI_EXTRA_MAX_BYTES;
  } catch {
    return false;
  }
}

/** The first `max` code points of `text` (never splits a surrogate pair). */
export function clip(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

/** `name` made unique (case-insensitively) against `taken` with a numeric suffix. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${clip(name, AI_PROFILE_NAME_MAX - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

function validateProfiles(raw: unknown): AiProfile[] {
  if (!Array.isArray(raw)) return [];
  const profiles: AiProfile[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (profiles.length >= AI_PROFILE_LIMIT) break;
    if (!isRecord(entry) || typeof entry.id !== "string" || !PROFILE_ID.test(entry.id) || ids.has(entry.id)) continue;
    ids.add(entry.id);
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    const provider = text(entry.provider);
    let name = clip(text(entry.name), AI_PROFILE_NAME_MAX);
    if (!name) name = `Profile ${profiles.length + 1}`;
    const profile: AiProfile = {
      id: entry.id,
      name: uniqueName(name, profiles.map((p) => p.name)),
      provider,
      model: text(entry.model),
      baseUrl: provider === "custom" ? text(entry.baseUrl) : "",
      cliPath: text(entry.cliPath),
    };
    if (isEffortLevel(entry.effort)) profile.effort = entry.effort;
    if (validExtra(entry.extra)) profile.extra = entry.extra;
    profiles.push(profile);
  }
  return profiles;
}

function validateAi(raw: unknown): AiSettings {
  const d = DEFAULT_SETTINGS.ai;
  if (!isRecord(raw)) return { ...d, profiles: [], features: {} };
  const profiles = validateProfiles(raw.profiles);
  const exists = (id: unknown): id is string => typeof id === "string" && profiles.some((p) => p.id === id);
  const features: Partial<Record<AiFeature, string>> = {};
  if (isRecord(raw.features)) {
    for (const feature of AI_FEATURES) {
      const id = raw.features[feature];
      if (exists(id)) features[feature] = id;
    }
  }
  return {
    suggestions: typeof raw.suggestions === "boolean" ? raw.suggestions : d.suggestions,
    contextBlocks: Math.round(clampNumber(raw.contextBlocks, AI_CONTEXT_RANGE, d.contextBlocks)),
    profiles,
    defaultProfile: exists(raw.defaultProfile) ? raw.defaultProfile : (profiles[0]?.id ?? ""),
    features,
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
  const settings: Settings = {
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
    defaultTerminal: nonEmpty(data.defaultTerminal) ? data.defaultTerminal : d.defaultTerminal,
    plugins,
    ai: validateAi(data.ai),
    env: validateEnv(data.env),
    secrets: validateSecretNames(data.secrets),
    python: validatePython(data.python) ?? d.python,
    workspaces: {},
  };
  settings.workspaces = validateWorkspaces(data.workspaces, settings);
  return settings;
}

function validateEnv(raw: unknown): EnvVar[] {
  if (!Array.isArray(raw)) return [];
  const byName = new Map<string, EnvVar>();
  for (const entry of raw) {
    if (byName.size >= ENV_LIMIT) break;
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") continue;
    const name = entry.name.trim();
    if (!validEnvName(name) || entry.value.includes("\0")) continue;
    byName.set(name, { name, value: entry.value });
  }
  return [...byName.values()];
}

function validateSecretNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = new Set<string>();
  for (const name of raw) {
    if (names.size >= ENV_LIMIT) break;
    if (typeof name === "string" && validEnvName(name.trim())) names.add(name.trim());
  }
  return [...names];
}

function validatePython(raw: unknown): PythonEnv | null {
  if (!isRecord(raw) || !(PYTHON_KINDS as readonly unknown[]).includes(raw.kind)) return null;
  const kind = raw.kind as PythonEnv["kind"];
  let target = kind === "none" || typeof raw.target !== "string" ? "" : raw.target.trim();
  // A relative folder would be looked up in whatever directory a terminal
  // opens in, sourcing that directory's activate script: absolute only.
  if (kind === "venv" && !target.startsWith("/")) target = "";
  return { kind, target };
}

/** Workspace ids are generated (`createId`); anything else is dropped. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function validateWorkspaces(raw: unknown, base: Settings): Record<string, WorkspaceSettings> {
  const workspaces: Record<string, WorkspaceSettings> = {};
  if (!isRecord(raw)) return workspaces;
  for (const [id, entry] of Object.entries(raw)) {
    if (!WORKSPACE_ID.test(id) || !isRecord(entry)) continue;
    workspaces[id] = {
      overrides: validateOverrides(entry.overrides, base),
      env: validateEnv(entry.env),
      secrets: validateSecretNames(entry.secrets),
    };
  }
  return workspaces;
}

/** `base` with `overrides` laid over it (not validated). */
export function applyOverrides(base: Settings, overrides: SettingsOverrides): Settings {
  const merged: Settings = { ...base };
  for (const key of OVERRIDABLE) {
    if (key in overrides) (merged as Record<string, unknown>)[key] = overrides[key];
  }
  if (overrides.ai) {
    const ai: AiSettings = { ...base.ai, ...overrides.ai };
    if (overrides.ai.features) {
      const features: Partial<Record<AiFeature, string>> = { ...base.ai.features };
      for (const [feature, id] of Object.entries(overrides.ai.features)) {
        if (id) features[feature as AiFeature] = id;
        else delete features[feature as AiFeature];
      }
      ai.features = features;
    }
    merged.ai = ai;
  }
  if (overrides.plugins) {
    const plugins = { ...base.plugins };
    for (const [id, entry] of Object.entries(overrides.plugins)) {
      const current = plugins[id] ?? {};
      plugins[id] = { ...current, settings: { ...current.settings, ...entry.settings } };
    }
    merged.plugins = plugins;
  }
  return merged;
}

/**
 * Overrides from untrusted data, checked against `base` (an AI override
 * names one of its profiles). Each value is normalized the way the
 * setting itself is; plugin settings are kept as they are and validated by
 * the plugin's fields when read, like the defaults'.
 */
export function validateOverrides(raw: unknown, base: Settings): SettingsOverrides {
  const overrides: SettingsOverrides = {};
  if (!isRecord(raw)) return overrides;
  const candidate: SettingsOverrides = {};
  for (const key of OVERRIDABLE) if (key in raw) (candidate as Record<string, unknown>)[key] = raw[key];
  const rawAi = isRecord(raw.ai) ? raw.ai : {};
  const ai: Record<string, unknown> = {};
  for (const key of AI_OVERRIDABLE) if (key in rawAi) ai[key] = rawAi[key];
  if (Object.keys(ai).length) candidate.ai = ai as SettingsOverrides["ai"];
  const merged = validateSettings({ ...applyOverrides({ ...base, workspaces: {} }, candidate), workspaces: {} });
  for (const key of OVERRIDABLE) {
    if (!(key in candidate)) continue;
    if (key === "python" && !validatePython(raw.python)) continue;
    (overrides as Record<string, unknown>)[key] = merged[key];
  }
  if (candidate.ai) {
    const kept: Record<string, unknown> = {};
    for (const key of AI_OVERRIDABLE) {
      if (!(key in candidate.ai)) continue;
      // A profile that does not exist is no override at all.
      if (key === "defaultProfile" && !base.ai.profiles.some((p) => p.id === candidate.ai?.defaultProfile)) continue;
      if (key === "features") {
        const rawFeatures = isRecord(rawAi.features) ? rawAi.features : {};
        const features: Partial<Record<AiFeature, string>> = {};
        for (const feature of AI_FEATURES) {
          if (!(feature in rawFeatures)) continue;
          const id = rawFeatures[feature];
          // Empty string explicitly overrides to "follow defaultProfile"; absent inherits from base.
          if (id === "" || (typeof id === "string" && base.ai.profiles.some((p) => p.id === id))) {
            features[feature] = id;
          }
        }
        if (Object.keys(features).length) kept.features = features;
        continue;
      }
      kept[key] = merged.ai[key];
    }
    if (Object.keys(kept).length) overrides.ai = kept as SettingsOverrides["ai"];
  }
  if (isRecord(raw.plugins)) {
    const plugins: Record<string, { settings: Record<string, unknown> }> = {};
    for (const [id, entry] of Object.entries(raw.plugins)) {
      if (isRecord(entry) && isRecord(entry.settings) && Object.keys(entry.settings).length) {
        plugins[id] = { settings: { ...entry.settings } };
      }
    }
    if (Object.keys(plugins).length) overrides.plugins = plugins;
  }
  return overrides;
}

/** A workspace's settings record, if it has one (own properties only: ids come from saved files). */
export function workspaceEntry(base: Settings, workspaceId: string | null | undefined): WorkspaceSettings | undefined {
  return workspaceId && Object.prototype.hasOwnProperty.call(base.workspaces, workspaceId) ? base.workspaces[workspaceId] : undefined;
}

/**
 * The settings for a workspace: `base` with its overrides, validated.
 * `base` itself without any. Whatever the workspace does not override is
 * `base`'s own object, so subscribers comparing by identity (the AI
 * engine, plugin settings caches) see no change when another scope changes.
 */
export function effectiveSettings(base: Settings, workspaceId: string | null | undefined): Settings {
  const workspace = workspaceEntry(base, workspaceId);
  if (!workspace || !hasOverrides(workspace.overrides)) return base;
  const { overrides } = workspace;
  const merged = validateSettings({ ...applyOverrides(base, overrides), workspaces: {} });
  merged.workspaces = base.workspaces;
  for (const key of Object.keys(base) as (keyof Settings)[]) {
    if (key === "workspaces" || key === "plugins" || key === "ai") continue;
    if (!(key in overrides)) (merged as Record<string, unknown>)[key] = base[key];
  }
  if (!overrides.ai) merged.ai = base.ai;
  if (!overrides.plugins) merged.plugins = base.plugins;
  else {
    for (const id of Object.keys(merged.plugins)) {
      if (!overrides.plugins[id] && base.plugins[id]) merged.plugins[id] = base.plugins[id];
    }
  }
  return merged;
}

export function hasOverrides(overrides: SettingsOverrides): boolean {
  return Object.keys(overrides).length > 0;
}

/**
 * Setting paths, as Rows name them: a top-level key (`fontSize`), an AI
 * field (`ai.suggestions`, `ai.features.commit`) or a plugin setting (`plugins.terminal.settings.shell`).
 */
export function isOverridden(overrides: SettingsOverrides | undefined, path: string): boolean {
  if (!overrides) return false;
  const parts = path.split(".");
  const [head, id] = parts;
  if (head === "ai") {
    if (id === "features" && parts[2]) return !!overrides.ai?.features && parts[2] in overrides.ai.features;
    return !!overrides.ai && id in overrides.ai;
  }
  if (head === "plugins") {
    const key = parts.slice(3).join(".");
    return !!overrides.plugins?.[id] && key in overrides.plugins[id].settings;
  }
  return head in overrides;
}

/** `overrides` without the setting at `path`. */
export function withoutOverride(overrides: SettingsOverrides, path: string): SettingsOverrides {
  const parts = path.split(".");
  const [head, id] = parts;
  const next: SettingsOverrides = { ...overrides };
  if (head === "ai" && next.ai) {
    const ai = { ...next.ai };
    if (id === "features" && parts[2] && ai.features) {
      const features = { ...ai.features };
      delete features[parts[2] as AiFeature];
      if (Object.keys(features).length) ai.features = features;
      else delete ai.features;
    } else {
      delete ai[id as AiOverridableKey];
    }
    if (Object.keys(ai).length) next.ai = ai;
    else delete next.ai;
  } else if (head === "plugins" && next.plugins?.[id]) {
    const key = parts.slice(3).join(".");
    const settings = { ...next.plugins[id].settings };
    delete settings[key];
    const plugins = { ...next.plugins };
    if (Object.keys(settings).length) plugins[id] = { settings };
    else delete plugins[id];
    if (Object.keys(plugins).length) next.plugins = plugins;
    else delete next.plugins;
  } else {
    delete (next as Record<string, unknown>)[head];
  }
  return next;
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
