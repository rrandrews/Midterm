import { describe, expect, it, vi } from "vitest";
import type { Block } from "./blocks";
import { canReplay, replayBlock, runFromBlocks } from "./blockMode";
import type { TerminalSession } from "./session";

vi.mock("./history", () => ({ recordCommand: vi.fn() }));

/** A session at a prompt of the shell in `scope`. */
function fakeSession(scope: string) {
  const runCommand = vi.fn(() => true);
  const session = {
    paneId: "p",
    runCommand,
    blocks: {
      scope,
      snapshot: () => ({ integration: "present", phase: "prompt", altScreen: false, nested: scope !== "" }),
    },
  } as unknown as TerminalSession;
  return { session, runCommand };
}

const block = (fields: Partial<Block>) => ({ command: "ls", nested: false, host: undefined, ...fields }) as Block;

describe("Run again", () => {
  it("runs a block only at a prompt of the shell that ran it", () => {
    const local = fakeSession("");
    const remoteBlock = block({ nested: true, host: "box" });
    expect(canReplay(local.session, remoteBlock)).toBe(false);
    replayBlock(local.session, remoteBlock);
    expect(local.runCommand).not.toHaveBeenCalled();

    expect(canReplay(local.session, block({}))).toBe(true);
    replayBlock(local.session, block({}));
    expect(local.runCommand).toHaveBeenCalledWith("ls");

    const remote = fakeSession("box");
    expect(canReplay(remote.session, remoteBlock)).toBe(true);
    expect(canReplay(remote.session, block({}))).toBe(false);
  });

  it("does not send a line composed for another shell's prompt", () => {
    const local = fakeSession("");
    runFromBlocks(local.session, "rm -rf build", "box");
    expect(local.runCommand).not.toHaveBeenCalled();
    runFromBlocks(local.session, "make", "");
    expect(local.runCommand).toHaveBeenCalledWith("make");
  });
});
