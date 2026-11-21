import { describe, expect, it } from "vitest";
import { diffFromPatch, diffStats, diffTexts, modelLabel, nextMode, relativeTo, toolDiff, toolGist } from "./format";

describe("diffs", () => {
  it("diffs texts with removed lines first", () => {
    const lines = diffTexts("a\nold\nc", "a\nnew one\nnew two\nc");
    expect(lines.map((line) => `${line.type}:${line.text}`)).toEqual(["context:a", "del:old", "add:new one", "add:new two", "context:c"]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
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
    expect(relativeTo("/Users/me/x", "/repo", "/Users/me")).toBe("~/x");
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
