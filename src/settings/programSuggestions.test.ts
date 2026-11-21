import { describe, expect, it } from "vitest";
import { KNOWN_TUIS, programSuggestions } from "./programSuggestions";

describe("programSuggestions", () => {
  const history = ["ls", "git status", "claude", "./run.sh", "bun test", "agy --resume"];

  it("puts known TUIs first with nothing typed, run ones first, skipping noise", () => {
    const names = programSuggestions(history, "", [], 20).map((s) => s.name);
    expect(names.slice(0, 2)).toEqual(["agy", "claude"]);
    expect(names).not.toContain("ls");
    expect(names).not.toContain("./run.sh");
    expect(names).toContain("bun");
    expect(names.indexOf("bun")).toBeGreaterThan(KNOWN_TUIS.length - 1);
  });

  it("marks where each comes from", () => {
    const [agy] = programSuggestions(history, "agy", []);
    expect(agy).toEqual({ name: "agy", source: "history" });
    expect(programSuggestions([], "gem", [])).toEqual([{ name: "gemini", source: "known" }]);
  });

  it("filters by prefix first, then substring", () => {
    expect(programSuggestions(["xcode-select", "codex"], "cod", [], 20).map((s) => s.name)).toEqual(["codex", "xcode-select", "opencode"]);
  });

  it("leaves out taken programs, case-insensitively", () => {
    expect(programSuggestions(history, "", ["AGY", "claude"], 20).map((s) => s.name)).not.toContain("agy");
  });

  it("offers noise when typed", () => {
    expect(programSuggestions(history, "l", []).map((s) => s.name)).toContain("ls");
  });
});
