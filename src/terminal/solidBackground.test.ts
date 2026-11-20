import { describe, expect, it } from "vitest";
import { effectiveSolid, matchesForeground, oscColor, type SolidInputs } from "./solidBackground";

describe("matchesForeground", () => {
  it("matches case-insensitively and by basename", () => {
    expect(matchesForeground("Codex", ["codex"])).toBe(true);
    expect(matchesForeground("codex", ["/usr/local/bin/CODEX"])).toBe(true);
    expect(matchesForeground("/opt/bin/codex", ["codex"])).toBe(true);
  });
  it("accepts the entry followed by a dash", () => {
    expect(matchesForeground("codex-aarch64-apple-darwin", ["codex"])).toBe(true);
  });
  it("rejects other names", () => {
    expect(matchesForeground("codexx", ["codex"])).toBe(false);
    expect(matchesForeground("mycodex", ["codex"])).toBe(false);
    expect(matchesForeground("zsh", ["codex"])).toBe(false);
  });
  it("ignores empty names and entries", () => {
    expect(matchesForeground("", [""])).toBe(false);
    expect(matchesForeground(undefined, ["codex"])).toBe(false);
    expect(matchesForeground("zsh", ["", "/"])).toBe(false);
  });
});

describe("effectiveSolid", () => {
  const base: SolidInputs = {
    terminalBackground: "transparent",
    solidForFullscreen: true,
    solidBackgroundCommands: ["codex"],
    alternateScreen: false,
    foregroundName: "zsh",
  };
  it("is solid when the setting is", () => {
    expect(effectiveSolid({ ...base, terminalBackground: "solid" })).toBe(true);
  });
  it("is transparent at a plain prompt", () => {
    expect(effectiveSolid(base)).toBe(false);
  });
  it("goes solid on the alternate screen if enabled", () => {
    expect(effectiveSolid({ ...base, alternateScreen: true })).toBe(true);
    expect(effectiveSolid({ ...base, alternateScreen: true, solidForFullscreen: false })).toBe(false);
  });
  it("goes solid for listed programs", () => {
    expect(effectiveSolid({ ...base, foregroundName: "codex" })).toBe(true);
    expect(effectiveSolid({ ...base, foregroundName: "codex", solidBackgroundCommands: [] })).toBe(false);
  });
});

describe("oscColor", () => {
  it("converts hex colors", () => {
    expect(oscColor("#0c0d10")).toBe("rgb:0c0c/0d0d/1010");
    expect(oscColor("#0C0D10ff")).toBe("rgb:0c0c/0d0d/1010");
    expect(oscColor("#fff")).toBe("rgb:ffff/ffff/ffff");
  });
  it("rejects other formats", () => {
    expect(oscColor("red")).toBeNull();
    expect(oscColor("rgb(1,2,3)")).toBeNull();
  });
});
