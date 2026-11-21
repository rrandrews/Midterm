import { beforeEach, describe, expect, it, vi } from "vitest";

/* The bridge client, replaced: each test answers requests itself. */
type Handler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
let handler: Handler = async () => ({});
const sent: { method: string; params: Record<string, unknown> }[] = [];
vi.mock("./client", () => ({
  CLAUDE_KIND: "claude-code",
  request: (method: string, params: Record<string, unknown>) => {
    sent.push({ method, params });
    return handler(method, params);
  },
  onSessionEvent: () => () => {},
  onBridgeEvent: () => () => {},
}));
vi.mock("../plugins/settings", () => ({ pluginSettings: () => ({}) }));

const store = await import("./store");
const { acquirePaneSession, getDraft, getSession, paneSessionKey, answerPermission, sendMessage, sessionWork, setDraft, setEffort, setModel, setPaneDataWriter, setPermissionMode, updateSession } = store;

const saved: Record<string, unknown>[] = [];
setPaneDataWriter((_paneId, patch) => saved.push(patch));

/** A promise and its resolver. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const INIT = { sessionId: "sess-1", commands: [], models: [], agents: [] };
let pane = 0;
function newPane(data: Record<string, unknown> = {}) {
  const paneId = `pane-${++pane}`;
  acquirePaneSession(paneId, { cwd: "/repo", ...data });
  return paneSessionKey(paneId) as string;
}

beforeEach(() => {
  sent.length = 0;
  saved.length = 0;
  handler = async () => ({});
});

describe("setting changes", () => {
  it("are saved at once while no process runs", async () => {
    const key = newPane();
    await setPermissionMode(key, "acceptEdits");
    expect(getSession(key)?.permissionMode).toBe("acceptEdits");
    expect(saved).toEqual([{ permissionMode: "acceptEdits" }]);
    expect(sent).toEqual([]);
  });

  it("wait for a starting process, then are sent and saved once acknowledged", async () => {
    const key = newPane();
    const start = deferred<unknown>();
    handler = async (method) => (method === "session.start" ? start.promise : {});
    const sending = sendMessage(key, "hello");
    await Promise.resolve();
    expect(getSession(key)?.status).toBe("starting");
    const changing = setPermissionMode(key, "plan");
    // Shown at once, not sent or saved before the start answered.
    expect(getSession(key)?.permissionMode).toBe("plan");
    await Promise.resolve();
    expect(sent.map((request) => request.method)).toEqual(["session.start"]);
    expect(saved).not.toContainEqual({ permissionMode: "plan" });
    // The init reports the mode the process started with; the queued change still wins.
    start.resolve({ ...INIT, permissionMode: "default" });
    await changing;
    await sending;
    expect(sent.map((request) => request.method)).toContain("session.setPermissionMode");
    expect(getSession(key)?.permissionMode).toBe("plan");
    expect(saved).toContainEqual({ permissionMode: "plan" });
  });

  it("come back to the previous value, with a notice, when refused", async () => {
    const key = newPane({ model: "sonnet" });
    handler = async (method) => (method === "session.start" ? INIT : {});
    await sendMessage(key, "hello");
    handler = async (method) => {
      if (method === "session.setModel") throw new Error("Unknown model");
      return {};
    };
    saved.length = 0;
    await Promise.all([setModel(key, "opus"), setEffort(key, "high")]);
    const session = getSession(key);
    // Model and effort are acknowledged on their own: the effort took.
    expect(session?.model).toBe("sonnet");
    expect(session?.effort).toBe("high");
    expect(saved).toEqual([{ effort: "high" }]);
    expect(session?.items.some((item) => item.kind === "notice" && item.text.includes("Unknown model"))).toBe(true);
  });
});

describe("a restored pane", () => {
  it("keeps its saved model, effort and mode through the start, saving nothing it did not choose", async () => {
    handler = async (method) =>
      method === "sessions.messages" ? [] : method === "session.start" ? { ...INIT, sessionId: "sess-old", permissionMode: "default", model: "claude-sonnet-5" } : {};
    const key = newPane({ sessionId: "sess-old", model: "haiku", effort: "high", permissionMode: "acceptEdits" });
    await sendMessage(key, "hello");
    const start = sent.find((request) => request.method === "session.start");
    expect(start?.params).toMatchObject({ resume: "sess-old", model: "haiku", effort: "high", permissionMode: "acceptEdits" });
    const session = getSession(key);
    expect(session?.model).toBe("haiku");
    expect(session?.effort).toBe("high");
    // Nothing about the settings was written back (the init reported other values).
    expect(saved.some((patch) => "model" in patch || "effort" in patch || "permissionMode" in patch)).toBe(false);
  });

  it("changes only the effort from the effort chip", async () => {
    const key = newPane({ model: "haiku" });
    await setEffort(key, "max");
    expect(saved).toEqual([{ effort: "max" }]);
    expect(getSession(key)?.model).toBe("haiku");
  });

  it("saves a mode the user picked in a prompt", async () => {
    const key = newPane();
    updateSession(key, { permissions: [{ requestId: "r1", toolUseId: "t1", toolName: "ExitPlanMode", input: {} } as never] });
    await answerPermission(key, "r1", { behavior: "allow", updatedInput: {}, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
    expect(getSession(key)?.permissionMode).toBe("acceptEdits");
    expect(saved).toEqual([{ permissionMode: "acceptEdits" }]);
  });
});

describe("drafts", () => {
  it("are kept by session and dropped when empty", () => {
    const key = newPane();
    setDraft(key, { text: "half a thought", images: [] });
    expect(getDraft(key)).toEqual({ text: "half a thought", images: [] });
    setDraft(key, { text: "", images: [] });
    expect(getDraft(key)).toBeUndefined();
  });
});

describe("sessionWork", () => {
  it("names what closing would stop", () => {
    const key = newPane();
    expect(sessionWork(key)).toBeUndefined();
    updateSession(key, { status: "starting", items: [{ kind: "user", id: "u", text: "go" }] });
    expect(sessionWork(key)).toBe("Claude Code");
    updateSession(key, {
      status: "idle",
      tasks: {
        a: { id: "a", description: "x", status: "running", startedAt: 0 },
        b: { id: "b", description: "y", status: "running", startedAt: 0 },
        c: { id: "c", description: "z", status: "completed", startedAt: 0 },
      },
    });
    expect(sessionWork(key)).toBe("Claude Code (2 agents running)");
  });
});

describe("restored transcripts", () => {
  it("are in place before a send starts the process", async () => {
    const messages = deferred<unknown>();
    handler = async (method) => (method === "sessions.messages" ? messages.promise : method === "session.start" ? INIT : {});
    const key = newPane({ sessionId: "sess-old" });
    expect(getSession(key)?.loadingTranscript).toBe(true);
    const sending = sendMessage(key, "and now?");
    await Promise.resolve();
    expect(sent.map((request) => request.method)).toEqual(["sessions.messages"]);
    messages.resolve([
      { type: "user", uuid: "u1", session_id: "sess-old", message: { role: "user", content: "earlier" }, parent_tool_use_id: null, parent_agent_id: null },
    ]);
    await sending;
    const session = getSession(key);
    expect(session?.loadingTranscript).toBeUndefined();
    expect(session?.items.filter((item) => item.kind === "user").map((item) => (item as { text: string }).text)).toEqual(["earlier", "and now?"]);
    // (The context refresh after the start is beside the point.)
    expect(sent.map((request) => request.method).filter((method) => method !== "session.contextUsage")).toEqual(["sessions.messages", "session.start", "session.send"]);
  });
});
