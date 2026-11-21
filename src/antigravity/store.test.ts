import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquirePaneSession,
  answerPermission,
  cancelQueuedMessage,
  closeProcess,
  ensureStarted,
  getSession,
  listPastSessions,
  paneSessionKey,
  pathToFileUrl,
  reconnectSession,
  resetSession,
  sendMessage,
  setConfigValue,
  setCwd,
  shellQuoteArg,
} from "./store";

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("antigravity store (mock ACP end-to-end)", () => {
  const releases: (() => void)[] = [];

  beforeEach(() => {
    globalThis.localStorage?.setItem("midterm.antigravityMockSpeed", "100");
  });

  afterEach(async () => {
    while (releases.length) releases.pop()?.();
    await new Promise((r) => setTimeout(r, 30));
  });

  it("starts a session, streams thoughts/tools/diffs, answers permission, and finishes the turn", async () => {
    releases.push(acquirePaneSession("pane-test-1", { cwd: "/workspace" }));
    const key = paneSessionKey("pane-test-1")!;
    expect(key).toBeTruthy();

    const turn = sendMessage(key, "Fix src/run.ts", [], [{ path: "/workspace/src/run.ts", label: "src/run.ts" }]);

    // Wait for the permission prompt on `bun test`
    await waitFor(() => (getSession(key)?.permissions.length ?? 0) > 0);
    const perm = getSession(key)!.permissions[0];
    expect(perm.options.some((o) => o.kind === "allow_once")).toBe(true);

    // Queue a second message while running, then cancel it back out.
    await sendMessage(key, "Queued follow-up");
    const queued = getSession(key)!.items.find((i) => i.kind === "user" && i.queued);
    expect(queued).toBeDefined();
    if (queued?.kind === "user" && queued.queueId) {
      const removed = cancelQueuedMessage(key, queued.queueId);
      expect(removed?.text).toBe("Queued follow-up");
    }

    await answerPermission(key, perm.rpcId, "allow_once");
    await turn;

    const session = getSession(key)!;
    expect(session.status).toBe("idle");
    expect(session.sessionId).toBeTruthy();
    expect(session.changedFiles["/workspace/src/run.ts"]).toBeDefined();
    expect(session.items.some((i) => i.kind === "assistant" && i.text.includes("src/run.ts"))).toBe(true);
    expect(session.usage?.used).toBeGreaterThan(0);

    // Config options & History listing work over the live ACP session.
    expect(await setConfigValue(key, "thought_level", "low")).toBe(true);
    const history = await listPastSessions(key);
    expect(history.supported).toBe(true);
    expect(history.sessions.length).toBeGreaterThan(0);

    // Reset replaces the session key cleanly.
    const nextKey = resetSession(key);
    expect(nextKey).toBeTruthy();
    expect(nextKey).not.toBe(key);
    await closeProcess(nextKey!);
  });

  it("encodes file URLs and shell arguments safely", () => {
    expect(pathToFileUrl("/repo/report#1?v=2 3.md")).toBe("file:///repo/report%231%3Fv%3D2%203.md");
    expect(shellQuoteArg("/usr/local/bin/agy")).toBe("/usr/local/bin/agy");
    expect(shellQuoteArg("/Users/me/my $dir/a'b & agy")).toBe("'/Users/me/my $dir/a'\\''b & agy'");
  });

  it("queues rapid sends during startup, places dequeued prompt after turn 1, clears warmed cwd sessionId, and reconnects after auth error", async () => {
    releases.push(acquirePaneSession("pane-test-2", { cwd: "/workspace-a" }));
    const key = paneSessionKey("pane-test-2")!;

    // Warm up then change folder before first message: old sessionId must be cleared.
    expect(await ensureStarted(key)).toBe(true);
    expect(getSession(key)?.sessionId).toBeTruthy();
    setCwd(key, "/workspace-b");
    expect(getSession(key)?.sessionId).toBeUndefined();
    expect(getSession(key)?.status).toBe("new");

    // Two synchronous sends while process is starting: second must queue instead of overlapping.
    const t1 = sendMessage(key, "First prompt");
    const t2 = sendMessage(key, "Second queued prompt");
    await t2;

    await waitFor(() => (getSession(key)?.permissions.length ?? 0) > 0);
    await answerPermission(key, getSession(key)!.permissions[0].rpcId, "allow_once");
    await t1;

    // Wait for the auto-dispatched queued turn 2 to complete.
    await waitFor(() => getSession(key)?.totals.turns === 2);
    const items = getSession(key)!.items;
    const firstResultIdx = items.findIndex((i) => i.kind === "result");
    const secondUserIdx = items.findIndex((i) => i.kind === "user" && i.text === "Second queued prompt");
    expect(firstResultIdx).toBeGreaterThan(-1);
    expect(secondUserIdx).toBeGreaterThan(firstResultIdx);

    // Trigger prompt-level auth error, then verify reconnectSession recovers cleanly.
    const authTurn = await sendMessage(key, "auth");
    expect(authTurn).toBe(false);
    expect(getSession(key)?.authRequired).toBe(true);
    expect(getSession(key)?.status).toBe("error");
    expect(await reconnectSession(key)).toBe(true);
    expect(getSession(key)?.status).toBe("idle");
    expect(getSession(key)?.authRequired).toBe(false);
    await closeProcess(key);
  });
});
