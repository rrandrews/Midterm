import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindEditor,
  cancelEditorRequest,
  clearEditorRequest,
  editorDraft,
  failEditorRequest,
  markApplied,
  pendingText,
  startEditorRequest,
  useEditorRequests,
} from "./editorRequests";
import type { CmdRequest } from "./slash";

function fake(): CmdRequest & { resolve: (command: string) => void; reject: (error: unknown) => void } {
  let resolve!: (command: string) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  result.catch(() => {});
  return { result, cancel: vi.fn(), resolve, reject };
}

const entry = () => useEditorRequests.getState().pane;
const start = (request: CmdRequest, restore = "draft") =>
  startEditorRequest("pane", { line: "fix: lss", restore, busy: "fixing…", run: () => request });

afterEach(() => {
  cancelEditorRequest("pane");
  useEditorRequests.setState({}, true);
});

describe("editor requests", () => {
  it("puts the result in the editor once done, once", async () => {
    const request = fake();
    start(request);
    expect(entry()).toMatchObject({ status: "loading", line: "fix: lss", busy: "fixing…" });
    expect(pendingText(entry())).toBeUndefined();
    request.resolve("ls");
    await Promise.resolve();
    await Promise.resolve();
    expect(entry()).toMatchObject({ status: "done", result: "ls" });
    expect(pendingText(entry())).toBe("ls");
    markApplied("pane", entry().id);
    expect(pendingText(entry())).toBeUndefined();
    // Still shown above the editor until it is emptied.
    expect(entry().line).toBe("fix: lss");
    clearEditorRequest("pane");
    expect(entry()).toBeUndefined();
  });

  it("restores the draft on an error", async () => {
    const request = fake();
    start(request, "git sta");
    request.reject({ kind: "empty", message: "No fix." });
    await Promise.resolve();
    await Promise.resolve();
    expect(entry()).toMatchObject({ status: "error", message: "No fix." });
    expect(pendingText(entry())).toBe("git sta");
  });

  it("returns the draft on cancel and ignores a late answer", async () => {
    const request = fake();
    start(request, "git sta");
    expect(cancelEditorRequest("pane")).toBe("git sta");
    expect(request.cancel).toHaveBeenCalled();
    expect(entry()).toBeUndefined();
    request.resolve("ls");
    await Promise.resolve();
    await Promise.resolve();
    expect(entry()).toBeUndefined();
    // Nothing to restore once settled.
    failEditorRequest("pane", { line: "/cmd", restore: "/cmd", message: "Say what" });
    expect(cancelEditorRequest("pane")).toBeUndefined();
  });

  it("a new request cancels the one before", async () => {
    const first = fake();
    const second = fake();
    start(first);
    start(second);
    expect(first.cancel).toHaveBeenCalled();
    first.resolve("old");
    second.resolve("new");
    await Promise.resolve();
    await Promise.resolve();
    expect(entry()).toMatchObject({ status: "done", result: "new" });
  });

  it("a request replacing a loading one keeps its restore text", () => {
    start(fake(), "git sta");
    start(fake(), "");
    expect(cancelEditorRequest("pane")).toBe("git sta");
  });

  it("keeps a loading request when the editor is emptied", () => {
    start(fake());
    clearEditorRequest("pane");
    expect(entry()?.status).toBe("loading");
  });

  it("reads the draft of the bound editor only", () => {
    const unbind = bindEditor("pane", { draft: () => "echo", focus: () => {} });
    expect(editorDraft("pane")).toBe("echo");
    unbind();
    expect(editorDraft("pane")).toBeUndefined();
  });
});
