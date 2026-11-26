import { describe, expect, it } from "vitest";
import type { ScmDiff, ScmFileChange } from "../ipc/scm";
import {
  buildChangeTree,
  buildHunkPatch,
  flattenChangeTree,
  formatCompactRelativeTime,
  formatRelativeTime,
  splitRelPath,
} from "./tree";

describe("scm/tree", () => {
  it("splits relative paths into filename and directory", () => {
    expect(splitRelPath("README.md")).toEqual({ name: "README.md", dir: "" });
    expect(splitRelPath("src/scm/tree.ts")).toEqual({ name: "tree.ts", dir: "src/scm" });
  });

  it("builds a compacted directory tree and collects descendant files", () => {
    const changes: ScmFileChange[] = [
      { path: "src/components/ui/Button.tsx", status: "M" },
      { path: "src/components/ui/Menu.tsx", status: "A" },
      { path: "src/app.ts", status: "M" },
      { path: "README.md", status: "M" },
    ];
    const tree = buildChangeTree(changes);
    expect(tree).toHaveLength(2);
    expect(tree[0].kind).toBe("folder");
    if (tree[0].kind === "folder") {
      expect(tree[0].label).toBe("src");
      expect(tree[0].files).toHaveLength(3);
      expect(tree[0].children).toHaveLength(2);
      const sub = tree[0].children[0];
      expect(sub.kind).toBe("folder");
      if (sub.kind === "folder") {
        // Single-child directory chain compacts `components` + `ui` -> `components/ui`.
        expect(sub.label).toBe("components/ui");
        expect(sub.path).toBe("src/components/ui");
        expect(sub.files.map((f) => f.path)).toEqual([
          "src/components/ui/Button.tsx",
          "src/components/ui/Menu.tsx",
        ]);
      }
    }
    expect(tree[1].kind).toBe("file");

    const collapsed = new Set(["src/components/ui"]);
    const flat = flattenChangeTree(tree, collapsed);
    expect(flat.map((n) => (n.kind === "folder" ? `D:${n.path}` : `F:${n.path}`))).toEqual([
      "D:src",
      "D:src/components/ui",
      "F:src/app.ts",
      "F:README.md",
    ]);
  });

  it("reconstructs exact unified hunk patches preserving CR, no-newline, and quoting", () => {
    const diff: ScmDiff = {
      path: "src/app.ts",
      binary: false,
      tooLarge: false,
      patchable: true,
      isNew: false,
      isDeleted: false,
      hunks: [
        {
          header: "@@ -1,2 +1,2 @@",
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: "del", content: "const a = 1;\r", oldLine: 1 },
            { kind: "add", content: "const a = 2;\r", newLine: 1 },
            { kind: "context", content: "export default a;", oldLine: 2, newLine: 2, noNewline: true },
          ],
        },
      ],
    };
    const patch = buildHunkPatch(diff, 0);
    expect(patch).toBe(
      [
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,2 +1,2 @@",
        "-const a = 1;\r",
        "+const a = 2;\r",
        " export default a;",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );

    // Non-patchable diffs must return null.
    expect(buildHunkPatch({ ...diff, patchable: false, nonUtf8: true }, 0)).toBeNull();
    // Renamed / quoted paths.
    const quoted = buildHunkPatch({ ...diff, oldPath: "old\tname.ts", path: 'new"name.ts' }, 0);
    expect(quoted).toContain('--- "a/old\\tname.ts"');
    expect(quoted).toContain('+++ "b/new\\"name.ts"');
  });

  it("formats compact relative timestamps", () => {
    const now = 1_700_000_000;
    expect(formatRelativeTime(now - 10, now)).toBe("just now");
    expect(formatRelativeTime(now - 180, now)).toBe("3m ago");
    expect(formatRelativeTime(now - 7200, now)).toBe("2h ago");
    expect(formatRelativeTime(now - 86400 * 5, now)).toBe("5d ago");

    expect(formatCompactRelativeTime(now - 10, now)).toBe("now");
    expect(formatCompactRelativeTime(now - 180, now)).toBe("3m");
    expect(formatCompactRelativeTime(now - 7200, now)).toBe("2h");
    expect(formatCompactRelativeTime(now - 86400 * 5, now)).toBe("5d");
  });
});
