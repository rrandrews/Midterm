import { describe, expect, it } from "vitest";
import { addToHistory, historyEntries, suggestion } from "./history";

describe("command history", () => {
  it("moves repeated commands to the end and caps the list", () => {
    expect(addToHistory(["a", "b", "c"], "a", 10)).toEqual(["b", "c", "a"]);
    expect(addToHistory(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });

  it("walks the pane's commands before the global ones, newest first, without duplicates", () => {
    expect(historyEntries(["ls", "make"], ["git status", "ls", "vim"])).toEqual([
      "make",
      "ls",
      "vim",
      "git status",
    ]);
  });

  it("suggests the most recent longer entry with the prefix", () => {
    const entries = ["cargo test -p pty spawn -- --nocapture", "cargo build", "cargo test"];
    expect(suggestion(entries, "cargo t")).toBe("cargo test -p pty spawn -- --nocapture");
    expect(suggestion(entries, "cargo b")).toBe("cargo build");
    expect(suggestion(entries, "cargo build")).toBeUndefined();
    expect(suggestion(entries, "")).toBeUndefined();
    expect(suggestion(entries, "  ")).toBeUndefined();
    expect(suggestion(entries, "npm")).toBeUndefined();
  });
});
