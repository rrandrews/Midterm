import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, monoFontStack, validateSettings } from "./schema";

describe("validateSettings", () => {
  it("gives defaults for nothing usable", () => {
    expect(validateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid fields and repairs the rest", () => {
    const settings = validateSettings({
      fontSize: 99,
      scrollback: -5,
      cursorStyle: "bar",
      accent: "#5EEAD4",
      bell: "loud",
      shellArgs: ["-l", 3, "-i"],
      keybindings: { "pane.close": ["Cmd+W", 4], bad: "Cmd+X" },
      terminalMode: "blocks",
    });
    expect(settings.fontSize).toBe(32);
    expect(settings.scrollback).toBe(0);
    expect(settings.cursorStyle).toBe("bar");
    expect(settings.accent).toBe("#5EEAD4");
    expect(settings.bell).toBe(DEFAULT_SETTINGS.bell);
    expect(settings.shellArgs).toEqual(["-l", "-i"]);
    expect(settings.keybindings).toEqual({ "pane.close": ["Cmd+W"] });
    expect(settings.terminalMode).toBe("blocks");
  });

  it("rejects colors that are not #rrggbb", () => {
    expect(validateSettings({ accent: "red" }).accent).toBe(DEFAULT_SETTINGS.accent);
    expect(validateSettings({ accent: "#fff" }).accent).toBe(DEFAULT_SETTINGS.accent);
  });
});

describe("monoFontStack", () => {
  it("puts the user's family first and quotes bare names", () => {
    expect(monoFontStack("")).toMatch(/^"JetBrains Mono Variable"/);
    expect(monoFontStack("Fira Code")).toMatch(/^"Fira Code", "JetBrains/);
    expect(monoFontStack("'SF Mono', Menlo")).toMatch(/^'SF Mono', Menlo, "JetBrains/);
  });
});
