import { describe, expect, it } from "vitest";
import { resolveLinkPath } from "./fileLinks";
import { blockDirectories, cdArgument, pathMenuItems } from "./pathTargets";

const block = (cwd: string | undefined, extra: { host?: string; nested?: boolean; remoteId?: string } = {}) => ({
  cwd,
  host: extra.host,
  nested: extra.nested ?? false,
  remoteId: extra.remoteId,
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

  it("resolves directories for tracked remote blocks while isolating host transitions", () => {
    const rid = "prod-0123456789ab";
    const blocks = [
      block("/home/me"),
      block("/srv/app", { host: "prod", nested: true, remoteId: rid }),
      block("/srv/app/sub", { host: "prod", nested: true, remoteId: rid }),
    ];
    // Local ssh command does not adopt remote next block's directory.
    expect(blockDirectories(blocks, 0, `ssh://${rid}/srv/app/sub`, false)).toEqual(["/home/me"]);
    // Tracked remote blocks resolve against the same remote host.
    expect(blockDirectories(blocks, 1, `ssh://${rid}/srv/app/sub`, false)).toEqual([
      `ssh://${rid}/srv/app/sub`,
      `ssh://${rid}/srv/app`,
    ]);
    expect(blockDirectories(blocks, 2, `ssh://${rid}/srv/app/other`, false)).toEqual([
      `ssh://${rid}/srv/app/other`,
      `ssh://${rid}/srv/app/sub`,
    ]);
    // Unknown start cwd must STILL respect host identity and never borrow another host's directory.
    expect(blockDirectories([block(undefined), block("/srv/app", { host: "prod", nested: true, remoteId: rid })], 0, `ssh://${rid}/srv/app`, false)).toEqual([]);
    expect(blockDirectories([block(undefined, { host: "prod", nested: true, remoteId: rid }), block("/home/me")], 0, "/home/me", false)).toEqual([]);
  });
});

describe("resolveLinkPath over SSH", () => {
  it("preserves ssh:// host for relative, absolute, and remote ~ paths", () => {
    const cwd = "ssh://prod-0123456789ab/srv/app";
    const rHome = "ssh://prod-0123456789ab/home/deploy";
    expect(resolveLinkPath("src/main.rs", cwd, rHome)).toBe("ssh://prod-0123456789ab/srv/app/src/main.rs");
    expect(resolveLinkPath("/etc/hosts", cwd, rHome)).toBe("ssh://prod-0123456789ab/etc/hosts");
    expect(resolveLinkPath("~/notes.md", cwd, rHome)).toBe("ssh://prod-0123456789ab/home/deploy/notes.md");
    // Local home must never resolve a remote ~ path.
    expect(resolveLinkPath("~/notes.md", cwd, "/Users/me")).toBeNull();
    // With remoteIdHint and unknown remote cwd, absolute paths still resolve remotely and relative paths return null.
    expect(resolveLinkPath("/etc/hosts", undefined, rHome, "prod-0123456789ab")).toBe("ssh://prod-0123456789ab/etc/hosts");
    expect(resolveLinkPath("README.md", undefined, rHome, "prod-0123456789ab")).toBeNull();
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

  it("omits Finder and default-app actions for remote SSH targets", () => {
    expect(labels(pathMenuItems("pane", { path: "ssh://prod-0123456789ab/srv/notes.txt", kind: "file" }))).toEqual([
      "Open file",
      "Open in new pane",
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
    expect(cdArgument("ssh://prod-0123456789ab/srv/app/sub", "ssh://prod-0123456789ab/srv/app")).toBe("./sub");
    expect(cdArgument("ssh://prod-0123456789ab/etc/nginx", "ssh://prod-0123456789ab/srv/app")).toBe("/etc/nginx");
  });

  it("is absolute elsewhere, quoted when needed", () => {
    expect(cdArgument("/usr/bin", "/home")).toBe("/usr/bin");
    expect(cdArgument("/usrx", "/usr")).toBe("/usrx");
    expect(cdArgument("/it's", undefined)).toBe("'/it'\\''s'");
  });
});
