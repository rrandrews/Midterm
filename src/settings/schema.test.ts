import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, joinArgs, migrateSettings, monoFontStack, splitArgs, validateSettings } from "./schema";

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
    const current = { version: 5, accent: "#8B9CFF", plugins: { terminal: { settings: { bell: "off" } } }, ai: { profiles: [], defaultProfile: "", features: {} } };
    expect(migrateSettings(current)).toEqual(current);
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
