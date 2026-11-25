import { describe, expect, it } from "vitest";
import { blockDirectories, cdArgument, pathMenuItems } from "./pathTargets";

const block = (cwd: string | undefined, extra: { host?: string; nested?: boolean } = {}) => ({
  cwd,
  host: extra.host,
  nested: extra.nested ?? false,
});

describe("blockDirectories", () => {
  it("tries where the shell ended up, then where the command started", () => {
    const blocks = [block("/home"), block("/home/child")];
    expect(blockDirectories(blocks, 0, "/now", false)).toEqual(["/home/child", "/home"]);
    expect(blockDirectories(blocks, 1, "/now", false)).toEqual(["/now", "/home/child"]);
    expect(blockDirectories([block("/same"), block("/same")], 0, undefined, false)).toEqual(["/same"]);
  });

  it("has nothing for a nested shell's output", () => {
    expect(blockDirectories([block("/x", { host: "server" })], 0, "/now", false)).toBeNull();
    // Reporting no host (or localhost) over ssh does not make it local.
    expect(blockDirectories([block("/x", { nested: true })], 0, "/now", true)).toBeNull();
  });

  it("does not take a remote directory as where a local command ended", () => {
    const blocks = [block("/home"), block("/srv", { nested: true })];
    expect(blockDirectories(blocks, 0, "/now", true)).toEqual(["/home"]);
    expect(blockDirectories([block("/home")], 0, "/remote", true)).toEqual(["/home"]);
  });
});

describe("pathMenuItems", () => {
  const labels = (items: ReturnType<typeof pathMenuItems>) =>
    items.map((item) => (item.type === "separator" ? "-" : item.type === "submenu" ? item.label : `${item.label}${item.disabled ? " (off)" : ""}`));

  it("offers a file's actions only", () => {
    expect(labels(pathMenuItems("pane", { path: "/a/notes.txt", kind: "file" }))).toEqual([
      "Open file",
      "Open in new pane",
      "Open in default application",
      "Reveal in Finder",
      "-",
      "Copy file name",
      "Copy full path",
    ]);
  });

  it("changes to a folder only when the shell can take a command", () => {
    // No session for this pane: nothing to cd in.
    expect(labels(pathMenuItems("pane", { path: "/a/src", kind: "dir" }))[0]).toBe("Change to this folder (off)");
    expect(labels(pathMenuItems("pane", { path: "/a/src", kind: "dir" }))).toContain("Copy folder name");
  });
});

describe("cdArgument", () => {
  it("is ./relative inside the directory, so CDPATH and option-like names cannot change it", () => {
    expect(cdArgument("/usr/bin", "/usr")).toBe("./bin");
    expect(cdArgument("/a/-P", "/a")).toBe("./-P");
    expect(cdArgument("/a/my dir/x", "/a")).toBe("'./my dir/x'");
  });

  it("is absolute elsewhere, quoted when needed", () => {
    expect(cdArgument("/usr/bin", "/home")).toBe("/usr/bin");
    expect(cdArgument("/usrx", "/usr")).toBe("/usrx");
    expect(cdArgument("/it's", undefined)).toBe("'/it'\\''s'");
  });
});
