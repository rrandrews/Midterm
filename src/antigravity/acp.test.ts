import { describe, expect, it, vi } from "vitest";
import { AcpClient, AcpRpcError, AUTH_REQUIRED_CODE, EXIT_NOTIFICATION, isAuthError } from "./acp";

function pair() {
  const sent: Record<string, unknown>[] = [];
  let closed = false;
  const onUpdate = vi.fn();
  const onPermissionRequest = vi.fn();
  const onElicitationRequest = vi.fn();
  const onExit = vi.fn();
  const client = new AcpClient(
    {
      send: (line) => {
        sent.push(JSON.parse(line));
      },
      close: () => {
        closed = true;
      },
    },
    { onUpdate, onPermissionRequest, onElicitationRequest, onExit },
  );
  return { client, sent, isClosed: () => closed, onUpdate, onPermissionRequest, onElicitationRequest, onExit };
}

describe("AcpClient", () => {
  it("correlates JSON-RPC requests and responses", async () => {
    const { client, sent } = pair();
    const p = client.initialize();
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("initialize");
    const id = sent[0].id;
    client.receive(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } }));
    const res = await p;
    expect(res.protocolVersion).toBe(1);
  });

  it("classifies AUTH_REQUIRED errors", async () => {
    const { client, sent } = pair();
    const p = client.newSession({ cwd: "/repo" });
    client.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: sent[0].id,
        error: { code: AUTH_REQUIRED_CODE, message: "Authentication required" },
      }),
    );
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AcpRpcError && e.authRequired && e.code === AUTH_REQUIRED_CODE);
    expect(isAuthError(undefined, "Please run agy acp --login")).toBe(true);
    expect(isAuthError(-32602, "invalid params")).toBe(false);
  });

  it("dispatches session/update notifications and server-initiated permission requests", async () => {
    const { client, sent, onUpdate, onPermissionRequest } = pair();
    client.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        },
      }),
    );
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0]).toBe("s1");

    client.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: { sessionId: "s1", toolCall: { toolCallId: "t1" }, options: [] },
      }),
    );
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    await client.respondPermission(99, { outcome: { outcome: "selected", optionId: "allow_once" } });
    expect(sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 99,
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
  });

  it("answers unknown server-initiated requests with -32601", () => {
    const { client, sent } = pair();
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "fs/read_text_file", params: {} }));
    expect(sent[0]).toMatchObject({ id: 42, error: { code: -32601 } });
  });

  it("ignores malformed non-object JSON envelopes without throwing", () => {
    const { client, onUpdate } = pair();
    for (const line of ["null", "42", '"hello"', "[]", "{not json"]) {
      expect(() => client.receive(line)).not.toThrow();
    }
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("rejects pending requests and fires onExit on synthetic exit notification", async () => {
    const { client, sent, onExit } = pair();
    const p = client.prompt("s1", [{ type: "text", text: "hello" }]);
    expect(sent).toHaveLength(1);
    client.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        method: EXIT_NOTIFICATION,
        params: { code: 1, stderr: "not logged in\n" },
      }),
    );
    await expect(p).rejects.toThrow(/Antigravity stopped/);
    expect(onExit).toHaveBeenCalledWith({ code: 1, stderr: "not logged in\n", authRequired: true });
    expect(client.isClosed).toBe(true);
  });
});
