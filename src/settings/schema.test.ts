import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  effectiveSettings,
  isOverridden,
  joinArgs,
  migrateSettings,
  monoFontStack,
  splitArgs,
  validateOverrides,
  validateSettings,
  withoutOverride,
} from "./schema";

describe("validateSettings", () => {
  it("gives defaults for nothing usable", () => {
    expect(validateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid fields and repairs the rest", () => {
    const settings = validateSettings({
      version: 3,
      fontSize: 99,
      accent: "#5EEAD4",
      keybindings: { "pane.close": ["Cmd+W", 4], bad: "Cmd+X" },
      defaultPaneKind: "",
      plugins: {
        explorer: { enabled: false, settings: { showHidden: true }, skills: { files: false, bad: "no" } },
        broken: "nope",
      },
    });
    expect(settings.fontSize).toBe(32);
    expect(settings.accent).toBe("#5EEAD4");
    expect(settings.keybindings).toEqual({ "pane.close": ["Cmd+W"] });
    expect(settings.defaultPaneKind).toBe("terminal");
    expect(settings.plugins).toEqual({
      explorer: { enabled: false, settings: { showHidden: true }, skills: { files: false } },
    });
  });

  it("rejects colors that are not #rrggbb", () => {
    expect(validateSettings({ accent: "red" }).accent).toBe("");
    expect(validateSettings({ accent: "#fff" }).accent).toBe("");
  });

  it("repairs model profiles", () => {
    const base = { provider: "openai", model: "m", baseUrl: "", cliPath: "" };
    const ai = validateSettings({
      ai: {
        profiles: [
          { ...base, id: "a", name: "  Fast  ", model: " gpt-4o ", baseUrl: "http://evil", effort: "xhigh", extra: { user: "x" } },
          { ...base, id: "a", name: "duplicate id" },
          { ...base, id: "Bad Id", name: "bad id" },
          { ...base, id: "b", name: "fast", effort: "ultra", extra: { model: "x" } },
          { ...base, id: "c", name: "", provider: "custom", baseUrl: " http://localhost:1/v1 ", extra: [1] },
          { ...base, id: "d", name: "Big", extra: { x: "a".repeat(17_000) } },
          "nope",
        ],
        defaultProfile: "missing",
        features: { cmd: "b", suggestions: "missing", unknown: "a" },
      },
    }).ai;
    expect(ai.profiles).toEqual([
      { id: "a", name: "Fast", provider: "openai", model: "gpt-4o", baseUrl: "", cliPath: "", effort: "xhigh", extra: { user: "x" } },
      { id: "b", name: "fast 2", provider: "openai", model: "m", baseUrl: "", cliPath: "" },
      { id: "c", name: "Profile 3", provider: "custom", model: "m", baseUrl: "http://localhost:1/v1", cliPath: "" },
      { id: "d", name: "Big", provider: "openai", model: "m", baseUrl: "", cliPath: "" },
    ]);
    expect(ai.defaultProfile).toBe("a");
    expect(ai.features).toEqual({ cmd: "b" });
  });

  it("shortens long names without splitting a surrogate pair", () => {
    const name = `${"a".repeat(39)}😀tail`;
    const profile = { id: "a", name, provider: "openai", model: "m", baseUrl: "", cliPath: "" };
    const kept = validateSettings({ ai: { profiles: [profile] } }).ai.profiles[0].name;
    expect(kept).toBe(`${"a".repeat(39)}😀`);
    expect(JSON.parse(JSON.stringify(kept))).toBe(kept);
    // Migration names a profile after a long model id the same way.
    const migrated = validateSettings({ version: 4, ai: { provider: "openrouter", model: name } }).ai.profiles[0];
    expect(migrated.name).toBe(`${"a".repeat(39)}😀`);
    expect(migrated.model).toBe(name);
  });

  it("caps the profile list and has no default without profiles", () => {
    const profiles = Array.from({ length: 60 }, (_, n) => ({ id: `p-${n}`, name: `P${n}`, provider: "codex", model: "", baseUrl: "", cliPath: "" }));
    expect(validateSettings({ ai: { profiles } }).ai.profiles).toHaveLength(50);
    expect(validateSettings({ ai: { profiles: [], defaultProfile: "x" } }).ai.defaultProfile).toBe("");
    expect(validateSettings({}).ai).toEqual(DEFAULT_SETTINGS.ai);
  });
});

describe("migrateSettings", () => {
  it("moves version 1's terminal fields into the terminal plugin's entry", () => {
    const v1 = {
      fontSize: 14,
      cursorStyle: "bar",
      scrollback: 500,
      shellArgs: ["-l"],
      terminalMode: "blocks",
      bell: "sound",
      keybindings: { "tab.new": ["Cmd+N"] },
    };
    const migrated = migrateSettings(v1);
    expect(migrated.version).toBe(SETTINGS_VERSION);
    expect(migrated.cursorStyle).toBeUndefined();
    // Version 4 then turns the blocks mode setting into the default terminal.
    expect(migrated.plugins).toEqual({
      terminal: { settings: { cursorStyle: "bar", scrollback: 500, shellArgs: ["-l"], bell: "sound" } },
    });
    expect(migrated.defaultTerminal).toBe("block-terminal");
    const settings = validateSettings(v1);
    expect(settings.fontSize).toBe(14);
    expect(settings.keybindings).toEqual({ "tab.new": ["Cmd+N"] });
    expect(settings.defaultTerminal).toBe("block-terminal");
  });

  it("makes the old default accent the theme's own, and keeps a custom one (version 2)", () => {
    expect(validateSettings({ version: 2, accent: "#8B9CFF" }).accent).toBe("");
    expect(validateSettings({ version: 2, accent: "#F472B6" }).accent).toBe("#F472B6");
  });

  it("turns the terminal mode setting into the default terminal (version 3)", () => {
    const v3 = (terminalMode?: string, extra: Record<string, unknown> = {}) =>
      validateSettings({
        version: 3,
        ...extra,
        plugins: { terminal: { settings: { bell: "off", ...(terminalMode ? { terminalMode } : {}) } } },
      });
    expect(v3("blocks").defaultTerminal).toBe("block-terminal");
    expect(v3("blocks").plugins.terminal.settings).toEqual({ bell: "off" });
    expect(v3("classic").defaultTerminal).toBe("terminal");
    expect(v3("classic").plugins.terminal.settings).toEqual({ bell: "off" });
    expect(v3().defaultTerminal).toBe("terminal");
    expect(v3("blocks", { defaultTerminal: "my-term" }).defaultTerminal).toBe("my-term");
  });

  it("falls back to the classic terminal for an invalid default terminal", () => {
    expect(validateSettings({ defaultTerminal: "" }).defaultTerminal).toBe("terminal");
    expect(validateSettings({ defaultTerminal: 3 }).defaultTerminal).toBe("terminal");
  });

  it("turns the single provider into one model profile (version 4)", () => {
    const v4 = (ai: Record<string, unknown>) => validateSettings({ version: 4, ai: { suggestions: false, contextBlocks: 7, ...ai } }).ai;
    const api = v4({
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "http://ignored",
      cliPaths: { codex: "/opt/codex" },
      effort: { openai: "high", anthropic: "low" },
    });
    expect(api).toEqual({
      suggestions: false,
      contextBlocks: 7,
      profiles: [{ id: "default", name: "gpt-4o", provider: "openai", model: "gpt-4o", baseUrl: "", cliPath: "", effort: "high" }],
      defaultProfile: "default",
      features: {},
    });
    const cli = v4({ provider: "codex", model: "", cliPaths: { codex: "/opt/codex" }, effort: {} });
    expect(cli.profiles).toEqual([{ id: "default", name: "codex", provider: "codex", model: "", baseUrl: "", cliPath: "/opt/codex" }]);
    const custom = v4({ provider: "custom", model: "llama3", baseUrl: "http://localhost:11434/v1", effort: { custom: "default" } });
    expect(custom.profiles).toEqual([
      { id: "default", name: "llama3", provider: "custom", model: "llama3", baseUrl: "http://localhost:11434/v1", cliPath: "", effort: "default" },
    ]);
    const none = v4({ provider: "", model: "x", effort: { openai: "high" } });
    expect(none).toEqual({ suggestions: false, contextBlocks: 7, profiles: [], defaultProfile: "", features: {} });
    // The old fields are gone after migration.
    const migrated = migrateSettings({ version: 4, ai: { provider: "openai", model: "m", baseUrl: "", cliPaths: {}, effort: {} } });
    expect(Object.keys(migrated.ai as object).sort()).toEqual(["defaultProfile", "features", "profiles"]);
  });

  it("leaves current settings alone", () => {
    const current = { version: 7, accent: "#8B9CFF", plugins: { terminal: { settings: { bell: "off" } } }, ai: { profiles: [], defaultProfile: "", features: {} } };
    expect(migrateSettings(current)).toEqual(current);
  });

  it("migrates v6 workspace ai.features replacement maps so omitted base features keep workspace default", () => {
    const migrated = migrateSettings({
      version: 6,
      ai: {
        profiles: [
          { id: "local", name: "Local", provider: "custom", model: "llama", baseUrl: "http://localhost:11434/v1", cliPath: "" },
          { id: "hosted", name: "Hosted", provider: "openai", model: "gpt-4o", baseUrl: "", cliPath: "" },
        ],
        defaultProfile: "hosted",
        features: { cmd: "hosted" },
      },
      workspaces: {
        w1: {
          overrides: {
            ai: { defaultProfile: "local", features: { agent: "local" } },
          },
          env: [],
          secrets: [],
        },
      },
    });
    const validated = validateSettings(migrated);
    expect(validated.workspaces.w1.overrides.ai?.features).toEqual({ agent: "local", cmd: "" });
    const eff = effectiveSettings(validated, "w1");
    expect(eff.ai.defaultProfile).toBe("local");
    expect(eff.ai.features.cmd).toBeUndefined();
    expect(eff.ai.features.agent).toBe("local");
  });
});

describe("monoFontStack", () => {
  it("puts the user's family first and quotes bare names", () => {
    expect(monoFontStack("")).toMatch(/^"JetBrains Mono Variable"/);
    expect(monoFontStack("Fira Code")).toMatch(/^"Fira Code", "JetBrains/);
    expect(monoFontStack("'SF Mono', Menlo")).toMatch(/^'SF Mono', Menlo, "JetBrains/);
  });
});

describe("splitArgs / joinArgs", () => {
  it("splits on whitespace and honours quotes", () => {
    expect(splitArgs(" -l  -c 'echo hi' \"a b\" ")).toEqual(["-l", "-c", "echo hi", "a b"]);
    expect(splitArgs("")).toEqual([]);
  });
  it("round-trips", () => {
    const args = ["-l", "a b", 'say "x"', "", 'x"y', "it's"];
    expect(splitArgs(joinArgs(args))).toEqual(args);
  });
});

describe("workspace settings", () => {
  const base = () => validateSettings({ ai: { profiles: [{ id: "p-one", name: "One", provider: "openai", model: "m", baseUrl: "", cliPath: "" }] } });

  it("keeps only overridable settings, normalized", () => {
    const overrides = validateOverrides(
      {
        fontSize: 99,
        keybindings: { "pane.close": ["Cmd+W"] },
        ai: { suggestions: false, profiles: [], defaultProfile: "p-missing" },
        plugins: { terminal: { settings: { shell: "/bin/bash" }, enabled: false }, empty: { settings: {} } },
        python: { kind: "venv", target: " /tmp/venv " },
      },
      base(),
    );
    expect(overrides).toEqual({
      fontSize: 32,
      python: { kind: "venv", target: "/tmp/venv" },
      ai: { suggestions: false },
      plugins: { terminal: { settings: { shell: "/bin/bash" } } },
    });
  });

  it("lays a workspace's overrides over the defaults", () => {
    const settings = validateSettings({
      ...base(),
      fontSize: 14,
      plugins: { terminal: { settings: { shell: "/bin/zsh", bell: "off" } } },
      workspaces: { w1: { overrides: { fontSize: 16, plugins: { terminal: { settings: { shell: "/bin/bash" } } } } } },
    });
    expect(effectiveSettings(settings, null)).toBe(settings);
    expect(effectiveSettings(settings, "unknown")).toBe(settings);
    const w1 = effectiveSettings(settings, "w1");
    expect(w1.fontSize).toBe(16);
    expect(w1.plugins.terminal.settings).toEqual({ shell: "/bin/bash", bell: "off" });
    expect(w1.workspaces).toBe(settings.workspaces);
  });

  it("names and drops overrides by path", () => {
    const overrides = { fontSize: 13, ai: { suggestions: true }, plugins: { terminal: { settings: { shell: "x" } } } };
    expect(isOverridden(overrides, "fontSize")).toBe(true);
    expect(isOverridden(overrides, "accent")).toBe(false);
    expect(isOverridden(overrides, "ai.suggestions")).toBe(true);
    expect(isOverridden(overrides, "plugins.terminal.settings.shell")).toBe(true);
    expect(isOverridden(overrides, "plugins.terminal.settings.bell")).toBe(false);
    expect(withoutOverride(withoutOverride(overrides, "ai.suggestions"), "plugins.terminal.settings.shell")).toEqual({ fontSize: 13 });
  });

  it("validates environment variables, secret names, python and workspace ids", () => {
    const settings = validateSettings({
      env: [
        { name: "FOO", value: "1" },
        { name: "FOO", value: "2" },
        { name: "1BAD", value: "x" },
        { name: "MIDTERM_X", value: "x" },
        { name: "NUL", value: "a\0b" },
        "junk",
      ],
      secrets: ["TOKEN", "TOKEN", "bad name", 3],
      python: { kind: "conda", target: " ml " },
      workspaces: { "w-1": { env: [{ name: "A", value: "b" }] }, "bad id!": {} },
    });
    expect(settings.env).toEqual([{ name: "FOO", value: "2" }]);
    expect(settings.secrets).toEqual(["TOKEN"]);
    expect(settings.python).toEqual({ kind: "conda", target: "ml" });
    expect(Object.keys(settings.workspaces)).toEqual(["w-1"]);
    expect(settings.workspaces["w-1"]).toEqual({ overrides: {}, env: [{ name: "A", value: "b" }], secrets: [] });
    expect(validateSettings({ python: { kind: "pyenv" } }).python).toEqual(DEFAULT_SETTINGS.python);
  });
});

describe("workspace settings edge cases", () => {
  it("handles plugin setting keys with dots", () => {
    const overrides = { plugins: { viewer: { settings: { "view.zoom": 2, other: 1 } } } };
    expect(isOverridden(overrides, "plugins.viewer.settings.view.zoom")).toBe(true);
    expect(isOverridden(overrides, "plugins.viewer.settings.view")).toBe(false);
    expect(withoutOverride(overrides, "plugins.viewer.settings.view.zoom")).toEqual({ plugins: { viewer: { settings: { other: 1 } } } });
  });

  it("refuses Midterm's own variable names and relative virtualenvs", () => {
    const settings = validateSettings({
      env: [
        { name: "_midterm_si_loaded", value: "1" },
        { name: "MIDTERM_X", value: "1" },
        { name: "MIDTERMINAL", value: "1" },
      ],
      python: { kind: "venv", target: ".venv" },
    });
    expect(settings.env).toEqual([{ name: "MIDTERMINAL", value: "1" }]);
    expect(settings.python).toEqual({ kind: "venv", target: "" });
  });

  it("ignores inherited object properties as workspace ids", () => {
    const settings = validateSettings({});
    expect(effectiveSettings(settings, "constructor")).toBe(settings);
    expect(effectiveSettings(settings, "toString")).toBe(settings);
  });

  it("keeps what a workspace does not override as the defaults' own objects", () => {
    const settings = validateSettings({
      plugins: { terminal: { settings: { bell: "off" } }, explorer: { settings: { showHidden: true } } },
      workspaces: { w1: { overrides: { fontSize: 16, plugins: { terminal: { settings: { shell: "/bin/bash" } } } } } },
    });
    const w1 = effectiveSettings(settings, "w1");
    expect(w1.ai).toBe(settings.ai);
    expect(w1.keybindings).toBe(settings.keybindings);
    expect(w1.plugins.explorer).toBe(settings.plugins.explorer);
    expect(w1.plugins.terminal).not.toBe(settings.plugins.terminal);
  });
});
