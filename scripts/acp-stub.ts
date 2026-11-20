/*
 * A stand-in ACP agent for the self-test's agent check (src/dev/selftest.ts)
 * and for trying the agent over ACP by hand: a stdio agent that looks enough
 * like claude-agent-acp for Midterm's backend, with no model behind it.
 *
 *   MIDTERM_ACP_STUB="bun scripts/acp-stub.ts" bun run dev:mcp
 *
 * (`MIDTERM_ACP_STUB` is read in debug and `dev:mcp` builds only; see
 * docs/ai.md.) `--version` prints a version line and exits.
 *
 * It advertises MCP-over-ACP and a `systemPrompt` override, offers the
 * `mode`, `model` and `effort` (thought_level) config options, and calls
 * Midterm's tools through the `midterm` MCP server Midterm attached
 * (`server/discover`, `tools/list`, `tools/call`). Text goes out as
 * `agent_message_chunk` updates. Behaviour by prompt text, mirroring
 * scripts/ai-stub.ts:
 * - by default: a `recent_blocks` call, then an answer containing
 *   `midterm-agent-ok` and the last command the tool returned;
 * - "midterm-agent-write": a `run_command` call for `echo midterm-agent-1`,
 *   then one for `echo midterm-agent-2`, then an answer quoting what each
 *   returned (ran, or denied);
 * - "midterm-agent-slow": a long answer, one word every `STREAM_GAP_MS`,
 *   stopped by `session/cancel`;
 * - "midterm-agent-plain": a canned answer without tool calls.
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";

const VERSION = "0.0.0";
const STREAM_GAP_MS = 80;

if (process.argv.includes("--version")) {
  console.log(`acp-stub ${VERSION}`);
  process.exit(0);
}

function select(id: string, category: string, current: string, values: string[]) {
  return {
    id,
    name: id,
    category,
    type: "select" as const,
    currentValue: current,
    options: values.map((value) => ({ value, name: value })),
  };
}

function configOptions(state: Record<string, string>) {
  return [
    select("model", "model", state.model, ["default", "opus", "sonnet", "haiku"]),
    select("effort", "thought_level", state.effort, ["default", "low", "medium", "high", "max"]),
    select("mode", "mode", state.mode, ["default", "acceptEdits", "plan", "auto"]),
  ] as unknown as acp.SessionConfigOption[];
}

interface Session {
  serverId?: string;
  config: Record<string, string>;
  abort?: AbortController;
}
const sessions = new Map<string, Session>();
let nextSession = 1;

const mcp = new acp.McpOverAcpCaller({ clientInfo: { name: "acp-stub", version: VERSION } });

type Tool = { name: string };

async function toolNamed(client: acp.AgentContext, serverId: string, suffix: string, signal: AbortSignal): Promise<string | undefined> {
  await mcp.request(client, serverId, "server/discover", {}, { signal });
  const listed = await mcp.request(client, serverId, "tools/list", {}, { signal });
  const tools = ((listed as { result?: { tools?: Tool[] } }).result?.tools ?? []) as Tool[];
  return tools.find((t) => t.name.endsWith(suffix))?.name;
}

/** The text of a `tools/call` outcome, and whether it was an error. */
async function callTool(client: acp.AgentContext, serverId: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const outcome = (await mcp.request(client, serverId, "tools/call", { name, arguments: args }, { signal })) as {
    result?: { content?: { type: string; text?: string }[] };
    error?: { message?: string };
  };
  if (outcome.error) return `error: ${outcome.error.message ?? "failed"}`;
  return (outcome.result?.content ?? []).map((c) => c.text ?? "").join("");
}

async function say(client: acp.AgentContext, sessionId: string, text: string): Promise<void> {
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

/** Streams `text` word by word; stops early (returning false) when aborted. */
async function sayWords(client: acp.AgentContext, sessionId: string, text: string, signal: AbortSignal, gap = STREAM_GAP_MS): Promise<boolean> {
  for (const word of text.split(/(?=[ \n])/)) {
    if (signal.aborted) return false;
    await say(client, sessionId, word);
    await Bun.sleep(gap);
  }
  return !signal.aborted;
}

async function answer(client: acp.AgentContext, sessionId: string, session: Session, task: string, signal: AbortSignal): Promise<boolean> {
  if (task.includes("midterm-agent-slow")) {
    const words = Array.from({ length: 80 }, (_, n) => `word${n + 1}`).join(" ");
    return sayWords(client, sessionId, `Working slowly (midterm-agent-slow): ${words}.`, signal);
  }
  const serverId = session.serverId;
  if (serverId && !task.includes("midterm-agent-plain")) {
    if (task.includes("midterm-agent-write")) {
      const run = await toolNamed(client, serverId, "run_command", signal);
      const results: string[] = [];
      if (run) {
        for (const n of [1, 2]) results.push(await callTool(client, serverId, run, { command: `echo midterm-agent-${n}` }, signal));
      }
      const said = results.map((r, n) => `${n + 1}. ${/did not allow|denied|stopped/i.test(r) ? "denied" : /"sent"/.test(r) ? "ran" : "failed"}`);
      return sayWords(client, sessionId, `Done (midterm-agent-ok):\n\n${said.join("\n")}`, signal, 0);
    }
    const recent = await toolNamed(client, serverId, "recent_blocks", signal);
    if (recent) {
      const result = await callTool(client, serverId, recent, { count: 3 }, signal);
      const commands = [...result.matchAll(/"command":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
      const last = commands[commands.length - 1] ?? "nothing";
      return sayWords(client, sessionId, `Read the recent blocks (midterm-agent-ok). The last command was \`${last}\`.`, signal, 0);
    }
  }
  return sayWords(client, sessionId, "The ACP stub has no model: this is a canned answer (midterm-agent-plain).", signal, 0);
}

const app = acp
  .agent({ name: "acp-stub" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "acp-stub", version: VERSION },
    agentCapabilities: {
      mcpCapabilities: { acp: true },
      sessionCapabilities: { close: {}, systemPrompt: { mode: { override: {} } } },
    },
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = `stub-${nextSession++}`;
    const servers = (params.mcpServers ?? []) as unknown[];
    const declared = servers.find((s) => acp.isMcpServerAcp(s) && s.name === "midterm") as acp.McpServerAcpDeclaration | undefined;
    const session: Session = { serverId: declared?.serverId, config: { model: "default", effort: "medium", mode: "auto" } };
    sessions.set(sessionId, session);
    return { sessionId, configOptions: configOptions(session.config) };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new acp.RequestError(-32602, `unknown session ${params.sessionId}`);
    session.config[params.configId] = String((params as { value: unknown }).value);
    return { configOptions: configOptions(session.config) };
  })
  .onRequest(acp.methods.agent.session.setMode, () => ({}))
  .onRequest(acp.methods.agent.session.close, ({ params }) => {
    sessions.get(params.sessionId)?.abort?.abort();
    sessions.delete(params.sessionId);
    return {};
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.abort?.abort();
  })
  .onNotification(acp.methods.agent.mcp.message, mcp.handleNotification)
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new acp.RequestError(-32602, `unknown session ${params.sessionId}`);
    const abort = new AbortController();
    session.abort = abort;
    const stop = () => abort.abort();
    signal.addEventListener("abort", stop);
    const task = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    try {
      const done = await answer(client, params.sessionId, session, task, abort.signal);
      return { stopReason: done ? "end_turn" : "cancelled" };
    } catch (error) {
      if (abort.signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
      if (session.abort === abort) session.abort = undefined;
    }
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);
await app.connect(stream).closed;
