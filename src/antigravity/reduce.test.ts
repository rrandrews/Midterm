import { describe, expect, it } from "vitest";
import { createSession, failSession, finishTurn, reduceUpdate } from "./reduce";

describe("antigravity reduceUpdate", () => {
  it("merges contiguous assistant and thinking chunks and respects messageId boundaries", () => {
    let s = createSession({ key: "k1", paneId: "p1", cwd: "/repo" });
    s = reduceUpdate(s, { sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "First " } }, 100).session;
    s = reduceUpdate(s, { sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "thought" } }, 110).session;
    s = reduceUpdate(s, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello " } }, 120).session;
    s = reduceUpdate(s, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "world" } }, 130).session;
    s = reduceUpdate(s, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Next" } }, 140).session;

    expect(s.items).toHaveLength(3);
    expect(s.items[0]).toMatchObject({ kind: "thinking", text: "First thought", streaming: false });
    expect(s.items[1]).toMatchObject({ kind: "assistant", text: "Hello world", streaming: false });
    expect(s.items[2]).toMatchObject({ kind: "assistant", text: "Next", streaming: true });
  });

  it("tracks tool calls, partial updates, and aggregates native ACP diffs into changedFiles", () => {
    let s = createSession({ key: "k1", paneId: "p1", cwd: "/repo" });
    let r = reduceUpdate(
      s,
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Edit app.ts",
        kind: "edit",
        status: "in_progress",
        locations: [{ path: "/repo/app.ts", line: 10 }],
      },
      1000,
    );
    s = r.session;
    expect(r.editedPaths).toEqual([]);
    expect(s.tools.tc1.status).toBe("in_progress");

    r = reduceUpdate(
      s,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        content: [{ type: "diff", path: "/repo/app.ts", oldText: "a\nb\n", newText: "a\nc\nd\n" }],
      },
      1500,
    );
    s = r.session;
    expect(r.editedPaths).toEqual(["/repo/app.ts"]);
    expect(s.tools.tc1.status).toBe("completed");
    expect(s.tools.tc1.endedAt).toBe(1500);
    expect(s.changedFiles["/repo/app.ts"]).toMatchObject({
      path: "/repo/app.ts",
      added: 2,
      removed: 1,
      edits: 1,
    });

    // A second tool edits the same file, then receives a follow-up update with the same diff:
    // total must stay 2 + 1 = 3 added (preserving tc1's contribution).
    s = reduceUpdate(
      s,
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc2",
        title: "Edit app.ts again",
        kind: "edit",
        status: "in_progress",
        content: [{ type: "diff", path: "/repo/app.ts", oldText: "x\n", newText: "x\ny\n" }],
      },
      1600,
    ).session;
    expect(s.changedFiles["/repo/app.ts"]).toMatchObject({ added: 3, removed: 1, edits: 2 });

    s = reduceUpdate(
      s,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc2",
        status: "completed",
      },
      1700,
    ).session;
    expect(s.changedFiles["/repo/app.ts"]).toMatchObject({ added: 3, removed: 1, edits: 2 });
  });

  it("updates plan, usage, session title, compaction, and notices", () => {
    let s = createSession({ key: "k1", paneId: "p1", cwd: "/repo" });
    s = reduceUpdate(
      s,
      { sessionUpdate: "plan", entries: [{ content: "Step 1", priority: "high", status: "in_progress" }] },
      10,
    ).session;
    expect(s.plan).toHaveLength(1);

    s = reduceUpdate(s, { sessionUpdate: "session_info_update", title: "Fix bug" }, 20).session;
    expect(s.title).toBe("Fix bug");

    s = reduceUpdate(
      s,
      { sessionUpdate: "usage_update", used: 50_000, size: 1_000_000, cost: { amount: 0.12, currency: "USD" } },
      30,
    ).session;
    expect(s.usage?.used).toBe(50_000);
    expect(s.usage?.cost?.amount).toBe(0.12);

    s = reduceUpdate(s, { sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" }, 40).session;
    s = reduceUpdate(
      s,
      { sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: { type: "text", text: "Trimmed old turns." } },
      45,
    ).session;
    s = reduceUpdate(s, { sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" }, 50).session;
    s = reduceUpdate(s, { sessionUpdate: "notice", severity: "warning", title: "Rate limit", description: "Slowing down" }, 60).session;

    expect(s.items[0]).toMatchObject({ kind: "compaction", status: "completed", summary: "Trimmed old turns." });
    expect(s.items[1]).toMatchObject({ kind: "notice", tone: "warn", title: "Rate limit" });
  });

  it("settles running tools and streaming blocks on finishTurn and failSession", () => {
    let s = createSession({ key: "k1", paneId: "p1", cwd: "/repo" });
    s = { ...s, status: "running", turnStartedAt: 1000 };
    s = reduceUpdate(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working" } }, 1100).session;
    s = reduceUpdate(s, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run", kind: "execute", status: "in_progress" }, 1200).session;

    const done = finishTurn(s, "end_turn", 2500, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(done.status).toBe("idle");
    expect(done.tools.t1.status).toBe("completed");
    expect(done.totals.turns).toBe(1);
    expect(done.totals.durationMs).toBe(1500);
    expect(done.items[done.items.length - 1]).toMatchObject({ kind: "result", stopReason: "end_turn" });

    const failed = failSession(s, "auth error", 3000, true);
    expect(failed.status).toBe("error");
    expect(failed.authRequired).toBe(true);
    expect(failed.tools.t1.status).toBe("cancelled");
  });
});
