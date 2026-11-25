import { describe, expect, it, vi } from "vitest";

vi.mock("../actions", () => ({ openDirectory: vi.fn(), openFile: vi.fn() }));

const { blockDirectories } = await import("./pathTargets");

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
