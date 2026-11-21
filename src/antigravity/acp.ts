import type {
  CloseSessionResponse,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  DeleteSessionResponse,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  RequestId,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SessionUpdate,
  SetSessionConfigOptionResponse,
  SetSessionModeResponse,
} from "@agentclientprotocol/sdk/unstable";

/*
 * ACP v1 JSON-RPC 2.0 client over an NDJSON line transport.
 *
 * Transport-agnostic (accepts `send` + `close`, fed via `receive(line)`), so
 * the exact same client drives real `agy acp` processes via Tauri IPC, the
 * browser dev mock (`mock.ts`), and unit tests (`acp.test.ts`).
 */

export const ACP_PROTOCOL_VERSION = 1;
export const EXIT_NOTIFICATION = "$/midterm/exit";
export const AUTH_REQUIRED_CODE = -32000;

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly authRequired: boolean;

  constructor(error: JsonRpcErrorObject) {
    const detail = formatErrorData(error.data);
    const message = detail && detail !== error.message ? `${error.message}: ${detail}` : error.message;
    super(message);
    this.name = "AcpRpcError";
    this.code = error.code;
    this.data = error.data;
    this.authRequired = isAuthError(error.code, message);
  }
}

function formatErrorData(data: unknown): string {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data.trim();
  if (typeof data === "object" && "message" in data && typeof (data as { message?: unknown }).message === "string") {
    return (data as { message: string }).message.trim();
  }
  try {
    return JSON.stringify(data);
  } catch {
    return "";
  }
}

const AUTH_PATTERNS = [
  "not authenticated",
  "authentication required",
  "auth required",
  "not logged in",
  "log in",
  "sign in",
  "unauthorized",
  "agy acp --login",
  "login required",
];

/** Whether a JSON-RPC error code or message indicates missing Antigravity sign-in. */
export function isAuthError(code: number | undefined, message: string): boolean {
  if (code === AUTH_REQUIRED_CODE) return true;
  const lower = message.toLowerCase();
  return AUTH_PATTERNS.some((pattern) => lower.includes(pattern));
}

export type AcpTransport = {
  send(line: string): Promise<void> | void;
  close(): Promise<void> | void;
};

export type AcpClientHandlers = {
  onUpdate?: (sessionId: string, update: SessionUpdate) => void;
  onPermissionRequest?: (rpcId: RequestId, params: RequestPermissionRequest) => void;
  onElicitationRequest?: (rpcId: RequestId, params: CreateElicitationRequest) => void;
  onElicitationComplete?: (elicitationId: string) => void;
  onExit?: (info: { code: number | null; stderr: string; authRequired: boolean }) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class AcpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private readonly transport: AcpTransport;
  private readonly handlers: AcpClientHandlers;

  constructor(transport: AcpTransport, handlers: AcpClientHandlers = {}) {
    this.transport = transport;
    this.handlers = handlers;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Feeds one stdout NDJSON line from the agent into the client. */
  receive(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.warn("[antigravity] ignoring non-JSON line:", trimmed.slice(0, 200));
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn("[antigravity] ignoring malformed JSON-RPC envelope:", trimmed.slice(0, 200));
      return;
    }
    const message = parsed as Record<string, unknown>;

    // Response to one of our requests (has `id` and no `method`).
    if ("id" in message && !("method" in message)) {
      const id = message.id;
      if (typeof id !== "number") return;
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (message.error && typeof message.error === "object") {
        const err = message.error as Partial<JsonRpcErrorObject>;
        waiter.reject(
          new AcpRpcError({
            code: typeof err.code === "number" ? err.code : -32603,
            message: typeof err.message === "string" ? err.message : "ACP request failed",
            data: err.data,
          }),
        );
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    const method = typeof message.method === "string" ? message.method : "";
    const params = (message.params ?? {}) as Record<string, unknown>;

    // Agent-initiated request (has both `id` and `method`).
    if ("id" in message && message.id !== undefined) {
      const rpcId = message.id as RequestId;
      if (method === "session/request_permission" && this.handlers.onPermissionRequest) {
        this.handlers.onPermissionRequest(rpcId, params as unknown as RequestPermissionRequest);
        return;
      }
      if (method === "elicitation/create" && this.handlers.onElicitationRequest) {
        this.handlers.onElicitationRequest(rpcId, params as unknown as CreateElicitationRequest);
        return;
      }
      void this.respondError(rpcId, -32601, `Method not supported by client: ${method}`);
      return;
    }

    // Notifications (no `id`).
    if (method === EXIT_NOTIFICATION) {
      const code = typeof params.code === "number" ? params.code : null;
      const stderr = typeof params.stderr === "string" ? params.stderr : "";
      const tail = stderr.trim().split("\n").slice(-6).join("\n");
      const text = `Antigravity stopped${code === null ? "" : ` (exit ${code})`}.${tail ? `\n${tail}` : ""}`;
      const authRequired = isAuthError(undefined, stderr);
      this.rejectAll(new AcpRpcError({ code: authRequired ? AUTH_REQUIRED_CODE : -32001, message: text }));
      this.closed = true;
      this.handlers.onExit?.({ code, stderr, authRequired });
      return;
    }
    if (method === "session/update") {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const update = params.update as SessionUpdate | undefined;
      if (update && typeof update === "object" && "sessionUpdate" in update) {
        this.handlers.onUpdate?.(sessionId, update);
      }
      return;
    }
    if (method === "elicitation/complete") {
      const elicitationId = typeof params.elicitationId === "string" ? params.elicitationId : "";
      if (elicitationId) this.handlers.onElicitationComplete?.(elicitationId);
    }
  }

  /** Sends a JSON-RPC request and resolves with its `result`. */
  request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AcpRpcError({ code: -32001, message: "The Antigravity ACP session is closed." }));
    }
    const id = this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      Promise.resolve(this.transport.send(JSON.stringify(payload))).catch((error) => {
        if (!this.pending.delete(id)) return;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** Sends a JSON-RPC notification (no response expected). */
  notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    return Promise.resolve(this.transport.send(JSON.stringify(payload))).catch(() => {});
  }

  /** Sends a JSON-RPC success response to an agent-initiated request. */
  respond(rpcId: RequestId, result: unknown): Promise<void> {
    if (this.closed) return Promise.resolve();
    return Promise.resolve(this.transport.send(JSON.stringify({ jsonrpc: "2.0", id: rpcId, result }))).catch(() => {});
  }

  /** Sends a JSON-RPC error response to an agent-initiated request. */
  respondError(rpcId: RequestId, code: number, message: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return Promise.resolve(
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id: rpcId, error: { code, message } })),
    ).catch(() => {});
  }

  /** Replies to a `session/request_permission` request. */
  respondPermission(rpcId: RequestId, response: RequestPermissionResponse): Promise<void> {
    return this.respond(rpcId, response);
  }

  /** Replies to an `elicitation/create` request. */
  respondElicitation(rpcId: RequestId, response: CreateElicitationResponse): Promise<void> {
    return this.respond(rpcId, response);
  }

  /* ---- Typed ACP v1 methods ---- */

  initialize(): Promise<InitializeResponse> {
    return this.request<InitializeResponse>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: "midterm", version: "0.1.0" },
      clientCapabilities: {
        session: {
          compaction: {},
          configOptions: { boolean: {} },
          notices: {},
        },
        elicitation: {
          form: {},
          url: {},
        },
      },
    });
  }

  newSession(params: { cwd: string; additionalDirectories?: string[] }): Promise<NewSessionResponse> {
    const body: Record<string, unknown> = { cwd: params.cwd, mcpServers: [] };
    if (params.additionalDirectories?.length) body.additionalDirectories = params.additionalDirectories;
    return this.request<NewSessionResponse>("session/new", body);
  }

  loadSession(params: { sessionId: string; cwd: string; additionalDirectories?: string[] }): Promise<LoadSessionResponse> {
    const body: Record<string, unknown> = { sessionId: params.sessionId, cwd: params.cwd, mcpServers: [] };
    if (params.additionalDirectories?.length) body.additionalDirectories = params.additionalDirectories;
    return this.request<LoadSessionResponse>("session/load", body);
  }

  resumeSession(params: { sessionId: string; cwd: string; additionalDirectories?: string[] }): Promise<ResumeSessionResponse> {
    const body: Record<string, unknown> = { sessionId: params.sessionId, cwd: params.cwd, mcpServers: [] };
    if (params.additionalDirectories?.length) body.additionalDirectories = params.additionalDirectories;
    return this.request<ResumeSessionResponse>("session/resume", body);
  }

  listSessions(params: { cwd?: string; cursor?: string } = {}): Promise<ListSessionsResponse> {
    const body: Record<string, unknown> = {};
    if (params.cwd) body.cwd = params.cwd;
    if (params.cursor) body.cursor = params.cursor;
    return this.request<ListSessionsResponse>("session/list", body);
  }

  deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    return this.request<DeleteSessionResponse>("session/delete", { sessionId });
  }

  closeSession(sessionId: string): Promise<CloseSessionResponse> {
    return this.request<CloseSessionResponse>("session/close", { sessionId });
  }

  prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    return this.request<PromptResponse>("session/prompt", { sessionId, prompt });
  }

  cancel(sessionId: string): Promise<void> {
    return this.notify("session/cancel", { sessionId });
  }

  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<SetSessionConfigOptionResponse> {
    const params: Record<string, unknown> =
      typeof value === "boolean"
        ? { sessionId, configId, type: "boolean", value }
        : { sessionId, configId, value };
    return this.request<SetSessionConfigOptionResponse>("session/set_config_option", params);
  }

  setMode(sessionId: string, modeId: string): Promise<SetSessionModeResponse> {
    return this.request<SetSessionModeResponse>("session/set_mode", { sessionId, modeId });
  }

  /** Closes the transport and rejects all pending requests. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new AcpRpcError({ code: -32001, message: "The Antigravity ACP session was closed." }));
    await this.transport.close();
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
