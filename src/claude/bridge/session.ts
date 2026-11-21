/*
 * Sessions: one Agent SDK `query()` per session key, in streaming-input
 * mode. The SDK spawns the user's own `claude` (pathToClaudeCodeExecutable),
 * so settings, plugins, hooks and MCP servers are the real ones.
 */
import { getSessionMessages, listSessions, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentInfo, CanUseTool, Options, PermissionMode, PermissionResult, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BridgeEvent, BridgeParams, BridgeResult, PermissionRequest, SessionInit, SessionKey } from "../protocol";
import { BridgeFailure } from "./errors";
import { InputQueue } from "./queue";

export type Emit = (event: BridgeEvent) => void;

type Session = {
  key: SessionKey;
  q: Query;
  input: InputQueue<SDKUserMessage>;
  /** requestId → resolver of the pending canUseTool promise. */
  pending: Map<string, (r: PermissionResult) => void>;
  /** Set when the session was closed on purpose (close request, replaced, shutdown). */
  closing: boolean;
  /** Agents from the last reloadPlugins(); supportedAgents() only knows the init list. */
  agents?: AgentInfo[];
};

/** The environment the user's `claude` runs in: ours, without the markers of a Claude Code parent. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

export function buildUserMessage(p: BridgeParams<"session.send">): SDKUserMessage {
  const content: string | Array<Record<string, unknown>> = p.images?.length
    ? [
        ...p.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })),
        { type: "text", text: p.text },
      ]
    : p.text;
  return {
    type: "user",
    message: { role: "user", content } as SDKUserMessage["message"],
    parent_tool_use_id: null,
    session_id: "",
    uuid: p.uuid as SDKUserMessage["uuid"],
  };
}

export class Sessions {
  private sessions = new Map<SessionKey, Session>();

  constructor(
    private emit: Emit,
    private claudePath: () => string | undefined,
    private env: () => NodeJS.ProcessEnv = () => childEnv(),
  ) {}

  private get(key: SessionKey): Session {
    const s = this.sessions.get(key);
    if (!s || s.closing) throw new BridgeFailure(`No running session "${key}"`, "closed");
    return s;
  }

  async start(p: BridgeParams<"session.start">): Promise<SessionInit> {
    const claude = this.claudePath();
    if (!claude) throw new BridgeFailure("MIDTERM_CLAUDE_PATH is not set (claude not found)", "notFound");
    this.closeSession(p.session);

    const input = new InputQueue<SDKUserMessage>();
    const pending = new Map<string, (r: PermissionResult) => void>();
    const key = p.session;

    // Only the live session of a key may speak: a replaced or closed query must stay silent.
    const live = () => {
      const cur = this.sessions.get(key);
      return !!cur && cur === session && !cur.closing;
    };
    const emit: Emit = (e) => {
      if (live()) this.emit(e);
    };

    const canUseTool: CanUseTool = (toolName, toolInput, o) =>
      new Promise<PermissionResult>((resolve) => {
        const requestId = o.requestId;
        const settle = (r: PermissionResult) => {
          if (!pending.delete(requestId)) return;
          o.signal.removeEventListener("abort", onAbort);
          resolve(r);
        };
        const onAbort = () => {
          if (!pending.has(requestId)) return;
          settle({ behavior: "deny", message: "The request was cancelled" });
          emit({ event: "permissionCancelled", session: key, requestId });
        };
        pending.set(requestId, settle);
        if (o.signal.aborted) return onAbort();
        o.signal.addEventListener("abort", onAbort, { once: true });
        const request: PermissionRequest = {
          requestId,
          toolName,
          input: toolInput,
          toolUseId: o.toolUseID,
          agentId: o.agentID,
          title: o.title,
          displayName: o.displayName,
          description: o.description,
          decisionReason: o.decisionReason,
          blockedPath: o.blockedPath,
          suggestions: o.suggestions,
          defaultToNo: o.defaultToNo,
          suppressAlwaysAllowRule: o.suppressAlwaysAllowRule,
        };
        emit({ event: "permission", session: key, request });
      });

    const options: Options = {
      cwd: p.cwd,
      pathToClaudeCodeExecutable: claude,
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      env: this.env(),
      stderr: (text) => emit({ event: "stderr", session: key, text }),
      // The normal Claude Code system prompt, as the CLI and the VS Code extension use.
      systemPrompt: { type: "preset", preset: "claude_code" },
      canUseTool,
    };
    if (p.allowBypass) options.allowDangerouslySkipPermissions = true;
    if (p.resume) options.resume = p.resume;
    if (p.model) options.model = p.model;
    if (p.effort) options.effort = p.effort;
    if (p.permissionMode) options.permissionMode = p.permissionMode;

    const q = query({ prompt: input, options });
    const session: Session = { key, q, input, pending, closing: false };
    this.sessions.set(key, session);
    void this.consume(session);

    try {
      // current_permission_mode is reported by the CLI but not (yet) in the SDK's type.
      const r = (await q.initializationResult()) as Awaited<ReturnType<Query["initializationResult"]>> & {
        current_permission_mode?: PermissionMode;
      };
      return {
        sessionId: p.resume,
        claudeCodeVersion: r.claude_code_version,
        commands: r.commands ?? [],
        models: r.models ?? [],
        agents: r.agents ?? [],
        account: r.account,
        outputStyle: r.output_style,
        availableOutputStyles: r.available_output_styles,
        permissionMode: r.current_permission_mode,
        fastModeState: r.fast_mode_state,
      };
    } catch (e) {
      // A process that cannot initialize (bad resume id, not logged in) is useless: end it quietly, report via the request.
      if (this.sessions.get(key) === session) {
        this.closeSession(key);
      }
      throw e;
    }
  }

  /** Forwards every SDK message; ends the session when the stream does. */
  private async consume(s: Session): Promise<void> {
    let error: string | undefined;
    try {
      for await (const message of s.q) {
        if (this.sessions.get(s.key) === s && !s.closing) this.emit({ event: "message", session: s.key, message });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.denyAll(s);
    // A session replaced under the same key must not announce the end of its successor.
    if (this.sessions.get(s.key) !== s) return;
    this.sessions.delete(s.key);
    this.emit({ event: "sessionEnded", session: s.key, ...(error && !s.closing ? { error } : {}) });
  }

  private denyAll(s: Session): void {
    for (const resolve of [...s.pending.values()]) resolve({ behavior: "deny", message: "The session was closed" });
  }

  /** Closes on purpose. Returns whether a session existed. */
  private closeSession(key: SessionKey): boolean {
    const s = this.sessions.get(key);
    if (!s) return false;
    s.closing = true;
    this.sessions.delete(key);
    this.denyAll(s);
    s.input.close();
    try {
      s.q.close();
    } catch {
      // already gone
    }
    return true;
  }

  close(key: SessionKey): void {
    const had = this.sessions.has(key);
    this.closeSession(key);
    if (had) this.emit({ event: "sessionEnded", session: key });
  }

  closeAll(): void {
    for (const key of [...this.sessions.keys()]) this.closeSession(key);
  }

  send(p: BridgeParams<"session.send">): void {
    this.get(p.session).input.push(buildUserMessage(p));
  }

  /** Whether the prompt was still waiting; false when it was cancelled or answered meanwhile. */
  permission(p: BridgeParams<"session.permission">): boolean {
    const settle = this.get(p.session).pending.get(p.requestId);
    if (!settle) return false;
    settle(p.result);
    return true;
  }

  async interrupt(key: SessionKey): Promise<void> {
    await this.get(key).q.interrupt();
  }

  async setPermissionMode(p: BridgeParams<"session.setPermissionMode">): Promise<void> {
    await this.get(p.session).q.setPermissionMode(p.mode);
  }

  async setModel(p: BridgeParams<"session.setModel">): Promise<void> {
    await this.get(p.session).q.setModel(p.model);
  }

  async setEffort(p: BridgeParams<"session.setEffort">): Promise<void> {
    await this.get(p.session).q.applyFlagSettings({ effortLevel: p.effort });
  }

  contextUsage(p: BridgeParams<"session.contextUsage">): Promise<BridgeResult<"session.contextUsage">> {
    return this.get(p.session).q.getContextUsage(p.detail ? { detail: p.detail } : undefined);
  }

  usage(key: SessionKey): Promise<BridgeResult<"session.usage">> {
    return this.get(key).q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  }

  mcpStatus(key: SessionKey): Promise<BridgeResult<"session.mcpStatus">> {
    return this.get(key).q.mcpServerStatus();
  }

  async mcpToggle(p: BridgeParams<"session.mcpToggle">): Promise<void> {
    await this.get(p.session).q.toggleMcpServer(p.server, p.enabled);
  }

  async mcpReconnect(p: BridgeParams<"session.mcpReconnect">): Promise<void> {
    await this.get(p.session).q.reconnectMcpServer(p.server);
  }

  async reloadPlugins(key: SessionKey): Promise<BridgeResult<"session.reloadPlugins">> {
    const s = this.get(key);
    const r = await s.q.reloadPlugins();
    if (Array.isArray(r.agents)) s.agents = r.agents;
    return r;
  }

  async capabilities(key: SessionKey): Promise<BridgeResult<"session.capabilities">> {
    const s = this.get(key);
    const q = s.q;
    const [commands, models, listed] = await Promise.all([q.supportedCommands(), q.supportedModels(), q.supportedAgents()]);
    return { commands, models, agents: s.agents ?? listed };
  }

  async stopTask(p: BridgeParams<"session.stopTask">): Promise<void> {
    await this.get(p.session).q.stopTask(p.taskId);
  }
}

export function listPastSessions(p: BridgeParams<"sessions.list">): Promise<BridgeResult<"sessions.list">> {
  return listSessions({ dir: p.cwd, ...(p.limit ? { limit: p.limit } : {}) });
}

export function pastSessionMessages(p: BridgeParams<"sessions.messages">): Promise<BridgeResult<"sessions.messages">> {
  return getSessionMessages(p.sessionId, { dir: p.cwd });
}
