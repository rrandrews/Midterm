import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamReply } from "../ipc/ai";
import { dismissNote, dropPaneNotes, noteOf, pruneNotes, runNote, stopNote, toggleNote, useBlockNotes } from "./blockNotes";
import type { TextStream } from "./stream";

type Fake = TextStream & { emit: (text: string) => void; finish: (reply: Partial<StreamReply>) => void; fail: (error: unknown) => void };

/** A stream the test drives: `emit` shows text, `finish`/`fail` settle it, `cancel` rejects it as cancelled. */
function fakeStream(onText: (soFar: string) => void): Fake {
  let resolve!: (reply: StreamReply) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<StreamReply>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  result.catch(() => {});
  let text = "";
  return {
    result,
    cancel: vi.fn(() => reject({ kind: "cancelled", message: "Cancelled" })),
    emit: (more) => {
      text += more;
      onText(text);
    },
    finish: (reply) => resolve({ text, stop: "end", effortDropped: false, ...reply }),
    fail: reject,
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function start(paneId = "pane", blockId = 1): Promise<Fake> {
  return new Promise((resolve) => {
    runNote(paneId, blockId, async (onText) => {
      const stream = fakeStream(onText);
      resolve(stream);
      return stream;
    });
  });
}

afterEach(() => {
  for (const paneId of Object.keys(useBlockNotes.getState())) dropPaneNotes(paneId);
});

describe("block notes", () => {
  it("goes loading → streaming → done", async () => {
    const stream = await start();
    expect(noteOf("pane", 1)).toMatchObject({ status: "loading", text: "", collapsed: false });
    stream.emit("**Missing** file");
    expect(noteOf("pane", 1)).toMatchObject({ status: "streaming", text: "**Missing** file" });
    stream.finish({ text: "**Missing** file.", stop: "length" });
    await flush();
    expect(noteOf("pane", 1)).toMatchObject({ status: "done", text: "**Missing** file.", cut: true });
  });

  it("keeps partial text with the error", async () => {
    const stream = await start();
    stream.emit("Partial");
    stream.fail({ kind: "network", message: "Connection reset" });
    await flush();
    expect(noteOf("pane", 1)).toMatchObject({ status: "error", text: "Partial", error: "Connection reset" });
  });

  it("stop keeps the text so far", async () => {
    const stream = await start();
    stream.emit("So far");
    stopNote("pane", 1);
    expect(stream.cancel).toHaveBeenCalled();
    await flush();
    expect(noteOf("pane", 1)).toMatchObject({ status: "done", text: "So far", stopped: true });
  });

  it("asking again restarts, and the old stream no longer writes", async () => {
    const first = await start();
    first.emit("old");
    const second = await start();
    expect(first.cancel).toHaveBeenCalled();
    expect(noteOf("pane", 1)).toMatchObject({ status: "loading", text: "" });
    first.emit(" more");
    expect(noteOf("pane", 1)?.text).toBe("");
    second.emit("new");
    second.finish({});
    await flush();
    expect(noteOf("pane", 1)).toMatchObject({ status: "done", text: "new" });
  });

  it("streams several blocks at once", async () => {
    const a = await start("pane", 1);
    const b = await start("pane", 2);
    a.emit("A");
    b.emit("B");
    expect(noteOf("pane", 1)?.text).toBe("A");
    expect(noteOf("pane", 2)?.text).toBe("B");
    expect(a.cancel).not.toHaveBeenCalled();
  });

  it("prune drops gone blocks and cancels them", async () => {
    const gone = await start("pane", 1);
    await start("pane", 2);
    pruneNotes("pane", [2, 3]);
    expect(gone.cancel).toHaveBeenCalled();
    expect(noteOf("pane", 1)).toBeUndefined();
    expect(noteOf("pane", 2)).toBeDefined();
  });

  it("toggles, dismisses and drops a pane", async () => {
    const stream = await start("pane", 1);
    toggleNote("pane", 1);
    expect(noteOf("pane", 1)?.collapsed).toBe(true);
    dismissNote("pane", 1);
    expect(stream.cancel).toHaveBeenCalled();
    expect(useBlockNotes.getState().pane).toBeUndefined();
    const other = await start("other", 4);
    dropPaneNotes("other");
    expect(other.cancel).toHaveBeenCalled();
    expect(useBlockNotes.getState().other).toBeUndefined();
  });
});
