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

  it("keeps known reasoning effort levels per provider and drops the rest", () => {
    expect(validateSettings({}).ai.effort).toEqual({});
    const ai = validateSettings({ ai: { effort: { openai: "xhigh", anthropic: "default", gemini: "ultra", deepseek: 3 } } }).ai;
    expect(ai.effort).toEqual({ openai: "xhigh", anthropic: "default" });
    expect(validateSettings({ ai: { effort: "high" } }).ai.effort).toEqual({});
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
    expect(migrated.plugins).toEqual({
      terminal: { settings: { cursorStyle: "bar", scrollback: 500, shellArgs: ["-l"], terminalMode: "blocks", bell: "sound" } },
    });
    const settings = validateSettings(v1);
    expect(settings.fontSize).toBe(14);
    expect(settings.keybindings).toEqual({ "tab.new": ["Cmd+N"] });
    expect(settings.plugins.terminal.settings?.terminalMode).toBe("blocks");
  });

  it("makes the old default accent the theme's own, and keeps a custom one (version 2)", () => {
    expect(validateSettings({ version: 2, accent: "#8B9CFF" }).accent).toBe("");
    expect(validateSettings({ version: 2, accent: "#F472B6" }).accent).toBe("#F472B6");
  });

  it("leaves current settings alone", () => {
    const current = { version: 3, accent: "#8B9CFF", plugins: { terminal: { settings: { bell: "off" } } } };
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
