import { describe, expect, it } from "vitest";
import { chordToAccelerator, chordToString, formatBinding, parseChord } from "./keys";

describe("parseChord", () => {
  it("parses modifiers in any order and case", () => {
    expect(parseChord("Cmd+Shift+D")).toEqual({ code: "KeyD", cmd: true, shift: true, alt: false, ctrl: false });
    expect(parseChord("shift+cmd+d")).toEqual(parseChord("Cmd+Shift+D"));
    expect(parseChord("Alt+Cmd+Left")?.code).toBe("ArrowLeft");
    expect(parseChord("Cmd+[")?.code).toBe("BracketLeft");
    expect(parseChord("Cmd+1")?.code).toBe("Digit1");
    expect(parseChord("F5")).toEqual({ code: "F5", cmd: false, shift: false, alt: false, ctrl: false });
    expect(parseChord("Ctrl+G")?.ctrl).toBe(true);
  });

  it("rejects malformed chords", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord("Cmd+")).toBeNull();
    expect(parseChord("Cmd")).toBeNull();
    expect(parseChord("Cmd+Cmd+D")).toBeNull();
    expect(parseChord("Cmd+Nope")).toBeNull();
    expect(parseChord("D+Cmd")).toBeNull();
  });

  it("round-trips through the canonical string", () => {
    for (const spec of ["Cmd+Shift+D", "Alt+Cmd+Up", "Cmd+]", "Ctrl+G", "Cmd+Enter", "F12"]) {
      expect(chordToString(parseChord(spec)!)).toBe(spec);
    }
  });
});

describe("formatting", () => {
  it("uses macOS symbols in ⌃⌥⇧⌘ order", () => {
    expect(formatBinding("Cmd+Shift+D")).toBe("⇧⌘D");
    expect(formatBinding("Cmd+Alt+Left")).toBe("⌥⌘←");
    expect(formatBinding("Cmd+Shift+Enter")).toBe("⇧⌘↩");
    expect(formatBinding("Ctrl+G")).toBe("⌃G");
    expect(formatBinding("garbage+")).toBe("garbage+");
  });

  it("makes Tauri accelerators", () => {
    expect(chordToAccelerator(parseChord("Cmd+Shift+D")!)).toBe("CmdOrCtrl+Shift+D");
    expect(chordToAccelerator(parseChord("Alt+Cmd+Left")!)).toBe("CmdOrCtrl+Alt+Left");
    expect(chordToAccelerator(parseChord("Cmd+[")!)).toBe("CmdOrCtrl+[");
  });
});
