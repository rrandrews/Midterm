import { describe, expect, it } from "vitest";
import { diffAround, diffFromPatch, diffStats, diffTexts, modelLabel, nextMode, relativeTo, toolDiff, toolGist } from "./format";

describe("diffs", () => {
  it("diffs texts with removed lines first", () => {
    const lines = diffTexts("a\nold\nc", "a\nnew one\nnew two\nc");
    expect(lines.map((line) => `${line.type}:${line.text}`)).toEqual(["context:a", "del:old", "add:new one", "add:new two", "context:c"]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it("shows a change in a large text as a hunk, not a whole-file replacement", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
    const after = before.slice();
    after[1499] = "changed";
    const lines = diffTexts(before.join("\n"), after.join("\n"));
    expect(lines).toHaveLength(8);
    expect(lines.filter((line) => line.type === "del")).toEqual([{ type: "del", text: "line 1500", oldLine: 1500 }]);
    expect(lines.filter((line) => line.type === "add")).toEqual([{ type: "add", text: "changed", newLine: 1500 }]);
  });

  it("falls back to the changed middle with context", () => {
    const lines = diffAround("a\nb\nc\nd\ne\nf\ng\nh", "a\nb\nc\nd\nX\nY\nf\ng\nh");
    expect(lines.map((line) => `${line.type[0]}${line.text}`)).toEqual(["cb", "cc", "cd", "de", "aX", "aY", "cf", "cg", "ch"]);
    expect(lines[3]).toMatchObject({ oldLine: 5 });
    expect(lines[6]).toMatchObject({ oldLine: 6, newLine: 7 });
  });

  it("reads the structured patch with line numbers", () => {
    const lines = diffFromPatch([{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [" keep", "-gone", "+here"] }]);
    expect(lines).toEqual([
      { type: "context", text: "keep", oldLine: 10, newLine: 10 },
      { type: "del", text: "gone", oldLine: 11 },
      { type: "add", text: "here", newLine: 11 },
    ]);
  });

  it("prefers the structured result over the input", () => {
    const structured = { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }] };
    expect(toolDiff({ name: "Edit", input: { old_string: "a", new_string: "b" }, structured })?.[0]).toMatchObject({ text: "x", oldLine: 1 });
    expect(toolDiff({ name: "Write", input: { content: "1\n2" }, structured: undefined })).toHaveLength(2);
  });
});

describe("labels", () => {
  it("summarizes calls relative to the folder", () => {
    expect(toolGist({ name: "Read", input: { file_path: "/repo/src/a.ts" } }, "/repo")).toBe("src/a.ts");
    expect(toolGist({ name: "Bash", input: { command: "bun test\necho done" } }, "/repo")).toBe("bun test");
    expect(toolGist({ name: "mcp__linear__list_issues", input: { query: "bugs" } }, "/repo")).toBe("bugs");
    expect(toolGist({ name: "TaskCreate", input: { subject: "Fix math.js", description: "…" } }, "/repo")).toBe("Fix math.js");
    expect(toolGist({ name: "TaskUpdate", input: { taskId: "3", status: "completed" } }, "/repo")).toBe("#3 → completed");
    expect(toolGist({ name: "TaskUpdate", input: { taskId: "3", status: "in_progress" } }, "/repo")).toBe("#3 → in progress");
    expect(toolGist({ name: "TaskUpdate", input: { taskId: "3", subject: "Renamed" } }, "/repo")).toBe("#3 Renamed");
    expect(relativeTo("/Users/me/x", "/repo", "/Users/me")).toBe("~/x");
    expect(relativeTo("/repo//src/a.ts", "/repo/")).toBe("src/a.ts");
  });

  it("names the default model by what it resolved to", () => {
    expect(modelLabel(undefined, [], "claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("sonnet", [{ value: "sonnet", displayName: "Sonnet 5", description: "" }])).toBe("Sonnet 5");
  });

  it("cycles modes, with bypass only when allowed", () => {
    expect(nextMode("plan", false)).toBe("default");
    expect(nextMode("plan", true)).toBe("bypassPermissions");
  });
});

describe("read ranges", async () => {
  const { readRange } = await import("./tools");
  it("says where a read starts and ends", () => {
    expect(readRange(undefined, undefined)).toBeUndefined();
    expect(readRange(100, undefined)).toBe("from line 100");
    expect(readRange(undefined, 40)).toBe("lines 1–40");
    expect(readRange(10, 40)).toBe("lines 10–49");
  });
});

describe("replayed edits", async () => {
  const { hasBody, opensExpanded } = await import("./tools");
  const { toolDiff } = await import("./format");
  const call = (name: string, input: Record<string, unknown>) => ({ id: "t", name, input, status: "done" as const, parentToolUseId: null, startedAt: 0 });
  it("diff the input's texts when there is no patch, without snippet line numbers", () => {
    const diff = toolDiff(call("Edit", { file_path: "/r/a.ts", old_string: "  return a - b;", new_string: "  return a + b;" }));
    expect(diff).toEqual([
      { type: "del", text: "  return a - b;" },
      { type: "add", text: "  return a + b;" },
    ]);
  });
  it("have no body (and do not open) when there is nothing to show", () => {
    const empty = call("Edit", { file_path: "/r/a.ts" });
    expect(hasBody(empty)).toBe(false);
    expect(opensExpanded(empty)).toBe(false);
    expect(opensExpanded(call("Write", { file_path: "/r/b.ts", content: "x\n" }))).toBe(true);
  });
});
