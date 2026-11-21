import { beforeEach, describe, expect, it, vi } from "vitest";

/* The bridge client, replaced: each test answers requests itself. */
type Handler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
let handler: Handler = async () => ({});
const sent: { method: string; params: Record<string, unknown> }[] = [];
const onSessionEvent = vi.hoisted(() => vi.fn((..._args: unknown[]) => () => {}));
vi.mock("./client", () => ({
  CLAUDE_KIND: "claude-code",
  request: (method: string, params: Record<string, unknown>) => {
    sent.push({ method, params });
    return handler(method, params);
  },
  onSessionEvent: (...args: unknown[]) => onSessionEvent(...args),
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
    await vi.waitFor(() => expect(getSession(key)?.loadingTranscript).toBeUndefined());
    expect(await sendMessage(key, "hello")).toBe(true);
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

  it("saves a mode the user picked in a prompt once the answer took", async () => {
    const approve = { behavior: "allow" as const, updatedInput: {}, updatedPermissions: [{ type: "setMode" as const, mode: "acceptEdits" as const, destination: "session" as const }] };
    const prompt = { requestId: "r1", toolUseId: "t1", toolName: "ExitPlanMode", input: {} } as never;
    const key = newPane({ permissionMode: "plan" });
    // Already answered elsewhere (settled: false): nothing changes.
    handler = async () => ({ settled: false });
    updateSession(key, { permissions: [prompt] });
    await answerPermission(key, "r1", approve);
    expect(getSession(key)?.permissionMode).toBe("plan");
    // Refused: nothing changes either.
    handler = async () => {
      throw new Error("Bridge gone");
    };
    updateSession(key, { permissions: [prompt] });
    await answerPermission(key, "r1", approve);
    expect(getSession(key)?.permissionMode).toBe("plan");
    expect(saved).toEqual([]);
    handler = async () => ({ settled: true });
    updateSession(key, { permissions: [prompt] });
    const answering = answerPermission(key, "r1", approve);
    expect(getSession(key)?.permissionMode).toBe("plan");
    await answering;
    expect(getSession(key)?.permissionMode).toBe("acceptEdits");
    expect(saved).toEqual([{ permissionMode: "acceptEdits" }]);
  });
});

describe("sends and setting changes", () => {
  it("go out after the mode change asked for before them", async () => {
    const key = newPane();
    handler = async (method) => (method === "session.start" ? INIT : {});
    await sendMessage(key, "first");
    const mode = deferred<unknown>();
    handler = async (method) => (method === "session.setPermissionMode" ? mode.promise : {});
    sent.length = 0;
    void setPermissionMode(key, "acceptEdits");
    const sending = sendMessage(key, "under the new mode");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.map((request) => request.method)).toEqual(["session.setPermissionMode"]);
    mode.resolve({});
    expect(await sending).toBe(true);
    expect(sent.map((request) => request.method)).toEqual(["session.setPermissionMode", "session.send"]);
  });

  it("are not sent (and come back to the composer) when that mode change is refused", async () => {
    const key = newPane();
    handler = async (method) => (method === "session.start" ? INIT : {});
    await sendMessage(key, "first");
    handler = async (method) => {
      if (method === "session.setPermissionMode") throw new Error("Not allowed");
      return {};
    };
    sent.length = 0;
    void setPermissionMode(key, "acceptEdits");
    expect(await sendMessage(key, "held back")).toBe(false);
    expect(sent.map((request) => request.method)).toEqual(["session.setPermissionMode"]);
    const session = getSession(key);
    expect(session?.permissionMode).toBe("default");
    expect(session?.items.some((item) => item.kind === "user" && item.text === "held back")).toBe(false);
    // Later sends are fine again.
    expect(await sendMessage(key, "now")).toBe(true);
  });

  it("roll back to the acknowledged value, not a refused one", async () => {
    const key = newPane({ model: "sonnet" });
    handler = async (method) => (method === "session.start" ? INIT : {});
    await sendMessage(key, "first");
    const answers: Record<string, ReturnType<typeof deferred<unknown>>> = { opus: deferred(), haiku: deferred() };
    handler = async (method, params) => (method === "session.setModel" ? answers[params.model as string].promise : {});
    const toOpus = setModel(key, "opus");
    const toHaiku = setModel(key, "haiku");
    expect(getSession(key)?.model).toBe("haiku");
    // The older selection is refused: the newer one stays shown.
    answers.opus.reject(new Error("No opus"));
    expect(await toOpus).toBe(false);
    expect(getSession(key)?.model).toBe("haiku");
    // The newer one is refused too: back to what the session has, not to the refused opus.
    answers.haiku.reject(new Error("No haiku"));
    expect(await toHaiku).toBe(false);
    expect(getSession(key)?.model).toBe("sonnet");
  });
});

describe("a process that ends", () => {
  it("stops its background tasks", async () => {
    const key = newPane();
    updateSession(key, { tasks: { a: { id: "a", description: "x", status: "running", startedAt: 0 } } });
    expect(sessionWork(key)).toBe("Claude Code (1 agent running)");
    let emit: ((event: unknown) => void) | undefined;
    onSessionEvent.mockImplementationOnce((...args: unknown[]) => {
      emit = args[1] as (event: unknown) => void;
      return () => {};
    });
    handler = async (method) => (method === "session.start" ? INIT : {});
    await sendMessage(key, "go");
    emit?.({ event: "sessionEnded", error: "Crashed" });
    expect(getSession(key)?.tasks.a.status).toBe("stopped");
    expect(sessionWork(key)).toBeUndefined();
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
  it("are in place before a send can start the process", async () => {
    const messages = deferred<unknown>();
    handler = async (method) => (method === "sessions.messages" ? messages.promise : method === "session.start" ? INIT : {});
    const key = newPane({ sessionId: "sess-old" });
    expect(getSession(key)?.loadingTranscript).toBe(true);
    // Not sent while loading (the composer keeps the draft).
    expect(await sendMessage(key, "too soon")).toBe(false);
    expect(sent.map((request) => request.method)).toEqual(["sessions.messages"]);
    messages.resolve([
      { type: "user", uuid: "u1", session_id: "sess-old", message: { role: "user", content: "earlier" }, parent_tool_use_id: null, parent_agent_id: null },
    ]);
    await vi.waitFor(() => expect(getSession(key)?.loadingTranscript).toBeUndefined());
    expect(await sendMessage(key, "and now?")).toBe(true);
    const session = getSession(key);
    expect(session?.loadingTranscript).toBeUndefined();
    expect(session?.items.filter((item) => item.kind === "user").map((item) => (item as { text: string }).text)).toEqual(["earlier", "and now?"]);
    // (The context refresh after the start is beside the point.)
    expect(sent.map((request) => request.method).filter((method) => method !== "session.contextUsage")).toEqual(["sessions.messages", "session.start", "session.send"]);
  });
});

describe("a process started early (for the command list)", () => {
  it("starts no second process and saves its id only once a message is sent", async () => {
    const key = newPane();
    handler = async (method) => (method === "session.start" ? INIT : {});
    store.warmUp(key);
    store.warmUp(key);
    await vi.waitFor(() => expect(getSession(key)?.status).toBe("idle"));
    expect(sent.filter((r) => r.method === "session.start")).toHaveLength(1);
    expect(saved).toEqual([]);
    await sendMessage(key, "hello");
    expect(saved).toEqual([{ sessionId: "sess-1" }]);
    expect(sent.filter((r) => r.method === "session.start")).toHaveLength(1);
  });

  it("is replaced by a fresh session when the folder changes before the first message", async () => {
    const paneId = `pane-${++pane}`;
    acquirePaneSession(paneId, { cwd: "/repo" });
    const key = paneSessionKey(paneId) as string;
    handler = async (method) => (method === "session.start" ? INIT : {});
    store.warmUp(key);
    await vi.waitFor(() => expect(getSession(key)?.status).toBe("idle"));
    store.setCwd(key, "/other");
    expect(sent.some((r) => r.method === "session.close" && r.params.session === key)).toBe(true);
    const next = paneSessionKey(paneId) as string;
    expect(next).not.toBe(key);
    expect(getSession(next)).toMatchObject({ cwd: "/other", status: "new", sessionId: undefined });
    await sendMessage(next, "hi");
    const starts = sent.filter((r) => r.method === "session.start");
    expect(starts[1].params).toMatchObject({ session: next, cwd: "/other", resume: undefined });
  });

  it("is not resumed after it ends before any message", async () => {
    const key = newPane();
    handler = async (method) => (method === "session.start" ? INIT : {});
    store.warmUp(key);
    await vi.waitFor(() => expect(getSession(key)?.status).toBe("idle"));
    const listener = [...onSessionEvent.mock.calls].reverse().find((call) => call[0] === key)?.[1] as (event: unknown) => void;
    listener({ event: "sessionEnded", session: key, error: "gone" });
    expect(getSession(key)?.sessionId).toBe("sess-1");
    await sendMessage(key, "hi");
    const starts = sent.filter((r) => r.method === "session.start");
    expect(starts[1].params.resume).toBeUndefined();
  });
});

describe("side questions", () => {
  it("show the question, then its answer, outside the conversation", async () => {
    const key = newPane();
    const answer = deferred<unknown>();
    handler = async (method) => (method === "session.start" ? INIT : method === "session.sideQuestion" ? answer.promise : {});
    const asking = store.askAside(key, "  what is this repo?  ");
    await vi.waitFor(() => expect(sent.some((r) => r.method === "session.sideQuestion")).toBe(true));
    expect(getSession(key)?.items).toEqual([expect.objectContaining({ kind: "aside", question: "what is this repo?", pending: true })]);
    answer.resolve({ answer: "A terminal.", synthetic: false });
    await asking;
    expect(getSession(key)?.items).toEqual([expect.objectContaining({ kind: "aside", pending: false, answer: "A terminal." })]);
    expect(saved).toEqual([]);
  });

  it("say so when there is no answer", async () => {
    const key = newPane();
    handler = async (method) => (method === "session.start" ? INIT : method === "session.sideQuestion" ? { answer: null, synthetic: false } : {});
    await store.askAside(key, "why?");
    expect(getSession(key)?.items[0]).toMatchObject({ kind: "aside", pending: false, error: expect.stringContaining("No answer") });
  });
});

describe("fork", () => {
  it("resumes a copy of the conversation in the pane", async () => {
    const paneId = `pane-${++pane}`;
    acquirePaneSession(paneId, { cwd: "/repo", sessionId: "sess-1" });
    const key = paneSessionKey(paneId) as string;
    handler = async (method) => (method === "sessions.fork" ? { sessionId: "sess-2" } : method === "sessions.messages" ? [] : {});
    await vi.waitFor(() => expect(getSession(key)?.loadingTranscript).toBeUndefined());
    updateSession(key, (s) => ({ items: [...s.items, { kind: "user", id: "u1", text: "hi" }], title: "Hi" }));
    saved.length = 0;
    expect(await store.forkConversation(key)).toBe(true);
    expect(sent.find((r) => r.method === "sessions.fork")?.params).toEqual({ cwd: "/repo", sessionId: "sess-1", title: "Hi (fork)" });
    const next = paneSessionKey(paneId) as string;
    expect(next).not.toBe(key);
    expect(getSession(next)).toMatchObject({ sessionId: "sess-2", title: "Hi (fork)" });
    expect(saved).toEqual([{ sessionId: "sess-2" }]);
  });

  it("needs a conversation first", async () => {
    const key = newPane();
    expect(await store.forkConversation(key)).toBe(false);
    expect(sent).toEqual([]);
  });
});
