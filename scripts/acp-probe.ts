/*
 * ACP probe (MID-82): drives one session with an ACP agent adapter, serving
 * fake MCP tools over the ACP connection (MCP-over-ACP, `"type": "acp"`), and
 * logs every JSON-RPC message both ways. A debugging tool for the CLI-profile
 * agent (MID-80); it never runs anything itself.
 *
 *   bun scripts/acp-probe.ts [options] -- <adapter command> [args...]
 *
 * Options:
 *   --prompt TEXT        a prompt turn (repeatable; turns run in order)
 *   --system TEXT        `systemPrompt` on session/new
 *   --system-mode MODE   override (default) | append
 *   --meta JSON          `_meta` on session/new (or @file.json)
 *   --env K=V            extra env for the adapter (repeatable); K= unsets
 *   --cwd DIR            session cwd (default: a fresh empty temp dir)
 *   --log FILE           JSON-RPC log (default: <tmp>/acp-probe-<time>.log)
 *   --permission POLICY  ours (default: allow our tools, reject others) |
 *                        allow | reject | cancel
 *   --config ID=VALUE    session/set_config_option after session/new
 *                        (repeatable; ID may be a category such as
 *                        `thought_level` or `model`)
 *   --mode ID            session/set_mode after session/new
 *   --server-name NAME   MCP server name (default: midterm)
 *   --no-mcp             don't declare the MCP server
 *   --long-tool N[,N]    also serve tools whose names are N characters long
 *   --cancel-after MS    send session/cancel MS after each prompt starts
 *   --no-close           skip session/close at the end
 *   --timeout MS         per-prompt timeout (default 180000)
 *
 * Tools served: `probe_echo` ({ text }) returns `PROBE-MAGIC-7731: <text>`;
 * the long tool returns `PROBE-LONG-OK`. Both are harmless.
 *
 * Prints a summary (agent capabilities, config options, modes, tool calls,
 * MCP traffic, permission requests, the reply text) to stdout.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";

type Policy = "ours" | "allow" | "reject" | "cancel";

interface Args {
  prompts: string[];
  system?: string;
  systemMode: "override" | "append";
  meta?: Record<string, unknown>;
  env: Record<string, string | undefined>;
  cwd?: string;
  log: string;
  permission: Policy;
  config: [string, string][];
  mode?: string;
  serverName: string;
  mcp: boolean;
  longTools: number[];
  cancelAfter?: number;
  close: boolean;
  timeout: number;
  command: string[];
}

function usage(message: string): never {
  console.error(`acp-probe: ${message}\nusage: bun scripts/acp-probe.ts [options] -- <adapter command> [args...]`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    prompts: [],
    systemMode: "override",
    env: {},
    log: join(tmpdir(), `acp-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.log`),
    permission: "ours",
    config: [],
    longTools: [],
    serverName: "midterm",
    mcp: true,
    close: true,
    timeout: 180_000,
    command: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--":
        args.command = argv.slice(i + 1);
        i = argv.length;
        break;
      case "--prompt": args.prompts.push(value()); break;
      case "--system": args.system = value(); break;
      case "--system-mode": {
        const v = value();
        if (v !== "override" && v !== "append") usage("--system-mode is override or append");
        args.systemMode = v;
        break;
      }
      case "--meta": {
        const v = value();
        args.meta = JSON.parse(v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v);
        break;
      }
      case "--env": {
        const v = value();
        const eq = v.indexOf("=");
        if (eq < 1) usage("--env takes K=V");
        const val = v.slice(eq + 1);
        args.env[v.slice(0, eq)] = val === "" ? undefined : val;
        break;
      }
      case "--cwd": args.cwd = value(); break;
      case "--log": args.log = value(); break;
      case "--permission": {
        const v = value() as Policy;
        if (!["ours", "allow", "reject", "cancel"].includes(v)) usage("bad --permission");
        args.permission = v;
        break;
      }
      case "--config": {
        const v = value();
        const eq = v.indexOf("=");
        if (eq < 1) usage("--config takes ID=VALUE");
        args.config.push([v.slice(0, eq), v.slice(eq + 1)]);
        break;
      }
      case "--mode": args.mode = value(); break;
      case "--server-name": args.serverName = value(); break;
      case "--no-mcp": args.mcp = false; break;
      case "--long-tool": args.longTools.push(...value().split(",").map(Number)); break;
      case "--cancel-after": args.cancelAfter = Number(value()); break;
      case "--no-close": args.close = false; break;
      case "--timeout": args.timeout = Number(value()); break;
      default: usage(`unknown option ${flag}`);
    }
  }
  if (args.command.length === 0) usage("no adapter command after --");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const started = Date.now();

function log(direction: string, payload: unknown): void {
  const line = typeof payload === "string" ? payload : JSON.stringify(payload);
  appendFileSync(args.log, `${((Date.now() - started) / 1000).toFixed(3)} ${direction} ${line}\n`);
}

// --- Fake tools -------------------------------------------------------------

const MAGIC = "PROBE-MAGIC-7731";
// Long names end in their length (`probe_long_xxx…_115`), so the model can tell them apart.
const longNames = args.longTools.map((n) => {
  const suffix = `_${n}`;
  return ("probe_long_" + "x".repeat(Math.max(0, n))).slice(0, n - suffix.length) + suffix;
});
const tools = [
  {
    name: "probe_echo",
    description: "Echoes text back with a magic marker. Harmless; use it whenever asked to call probe_echo.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  ...longNames.map((name) => ({
    name,
    description: "A harmless tool with a long name. Returns PROBE-LONG-OK.",
    inputSchema: { type: "object", properties: {} },
  })),
];
const ourToolNames = new Set(tools.map((t) => t.name));
const cache = { ttlMs: 0, cacheScope: "private" };
const mcpLog: { method: string; params?: unknown }[] = [];

async function serveMcp(op: acp.McpOperationContext): Promise<acp.McpOutcome> {
  mcpLog.push({ method: op.method, params: op.params });
  switch (op.method) {
    case "server/discover":
      return {
        result: {
          resultType: "complete",
          supportedVersions: [acp.MCP_PROTOCOL_VERSION],
          capabilities: { tools: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: args.serverName, version: "0.1.0" } },
          ...cache,
        },
      };
    case "tools/list":
      return { result: { resultType: "complete", tools, ...cache } };
    case "tools/call": {
      const name = op.params?.name;
      const input = (op.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "probe_echo") {
        return { result: { resultType: "complete", content: [{ type: "text", text: `${MAGIC}: ${String(input.text ?? "")}` }] } };
      }
      if (longNames.includes(String(name))) {
        return { result: { resultType: "complete", content: [{ type: "text", text: "PROBE-LONG-OK" }] } };
      }
      return { result: { resultType: "complete", isError: true, content: [{ type: "text", text: `Unknown tool ${String(name)}` }] } };
    }
    default:
      throw new acp.McpProtocolError(-32601, `Unknown method: ${op.method}`);
  }
}

// --- Adapter process and logged stream ---------------------------------------

const env: Record<string, string | undefined> = { ...process.env };
for (const [k, v] of Object.entries(args.env)) {
  if (v === undefined) delete env[k];
  else env[k] = v;
}
// Running the probe from inside Claude Code must not mark the child as nested.
delete env.CLAUDECODE;

const child = spawn(args.command[0], args.command.slice(1), {
  env: env as NodeJS.ProcessEnv,
  stdio: ["pipe", "pipe", "pipe"],
  detached: true, // own process group, so cleanup takes the CLI it spawns too
});
child.stderr.on("data", (chunk: Buffer) => {
  for (const line of chunk.toString().split("\n")) if (line) log("stderr", line);
});
let exited = false;
child.on("exit", (code, signal) => {
  exited = true;
  log("exit", { code, signal });
});

const wire = acp.ndJsonStream(
  Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
);
const incoming = wire.readable.pipeThrough(
  new TransformStream<acp.AnyMessage, acp.AnyMessage>({
    transform(msg, c) {
      log("<-", msg);
      c.enqueue(msg);
    },
  }),
);
const outgoingTap = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
  transform(msg, c) {
    log("->", msg);
    c.enqueue(msg);
  },
});
void outgoingTap.readable.pipeTo(wire.writable).catch(() => {});
const stream: acp.Stream = { readable: incoming, writable: outgoingTap.writable };

// --- Client handlers ----------------------------------------------------------

const replies: string[] = [];
const thoughts: string[] = [];
const toolCalls = new Map<string, { title?: string; kind?: string; status?: string; meta?: unknown; rawInput?: unknown }>();
const permissions: { title?: string; ours: boolean; options: string[]; answer: string; meta?: unknown }[] = [];
const otherUpdates = new Map<string, number>();
let lastConfig: unknown;
let lastModes: unknown;

function isOurs(toolCall: Record<string, unknown>): boolean {
  const meta = toolCall._meta as { claudeCode?: { toolName?: string } } | undefined;
  const sdkName = meta?.claudeCode?.toolName;
  if (sdkName) return sdkName.startsWith(`mcp__${args.serverName}__`);
  // Codex: the request carries only the tool call id; the earlier
  // `tool_call` update has `rawInput.server` (MCP calls, `_meta.is_mcp_tool_call`).
  const seen = toolCalls.get(toolCall.toolCallId as string);
  const input = (toolCall.rawInput ?? seen?.rawInput) as { server?: string; tool?: string } | undefined;
  if (input?.server !== undefined) return input.server === args.serverName && ourToolNames.has(String(input.tool));
  return false;
}

const mcp = new acp.McpOverAcpProvider();
const app = acp
  .client({ name: "midterm-acp-probe" })
  .onRequest(acp.methods.client.mcp.message, mcp.handleRequest)
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    const tc = params.toolCall as unknown as Record<string, unknown>;
    const ours = isOurs(tc);
    const allow = args.permission === "allow" || (args.permission === "ours" && ours);
    const pick = (kinds: string[]) => params.options.find((o) => kinds.includes(o.kind));
    let outcome: acp.RequestPermissionResponse["outcome"];
    if (args.permission === "cancel") outcome = { outcome: "cancelled" };
    else {
      const option = allow ? pick(["allow_once"]) : pick(["reject_once", "reject_always"]);
      outcome = option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
    }
    permissions.push({
      title: tc.title as string | undefined,
      ours,
      options: params.options.map((o) => `${o.kind}:${o.optionId}`),
      answer: outcome.outcome === "selected" ? outcome.optionId : "cancelled",
      meta: tc._meta,
    });
    return { outcome };
  })
  .onNotification(acp.methods.client.session.update, ({ params }) => {
    const u = params.update as Record<string, unknown> & { sessionUpdate: string };
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const c = u.content as { type: string; text?: string };
        if (c.type === "text") replies.push(c.text ?? "");
        break;
      }
      case "agent_thought_chunk": {
        const c = u.content as { type: string; text?: string };
        if (c.type === "text") thoughts.push(c.text ?? "");
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = u.toolCallId as string;
        const prev = toolCalls.get(id) ?? {};
        toolCalls.set(id, {
          title: (u.title as string) ?? prev.title,
          kind: (u.kind as string) ?? prev.kind,
          status: (u.status as string) ?? prev.status,
          rawInput: u.rawInput ?? prev.rawInput,
          meta: u._meta ?? prev.meta,
        });
        break;
      }
      case "config_option_update":
        lastConfig = u.configOptions;
        break;
      case "current_mode_update":
        lastModes = u.currentModeId;
        break;
      default:
        otherUpdates.set(u.sessionUpdate, (otherUpdates.get(u.sessionUpdate) ?? 0) + 1);
    }
  });

// --- Session -------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)),
  ]);
}

function section(title: string, body: unknown): void {
  console.log(`\n== ${title}`);
  console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

type ConfigOption = { id: string; category?: string; currentValue?: unknown; options?: unknown[] };

function summarizeConfig(options: unknown): unknown {
  if (!Array.isArray(options)) return options;
  return (options as (ConfigOption & { name?: string; type?: string })[]).map((o) => ({
    id: o.id,
    category: o.category,
    type: o.type,
    current: o.currentValue,
    values: (o.options ?? []).flatMap((v) => {
      const x = v as { value?: string; options?: { value: string }[] };
      return x.options ? x.options.map((g) => g.value) : [x.value];
    }),
  }));
}

let exitCode = 0;
const cwd = args.cwd ?? realpathSync(mkdtempSync(join(tmpdir(), "acp-probe-cwd-")));
console.log(`log: ${args.log}\ncwd: ${cwd}`);

try {
  await app.connectWith(stream, async (agent) => {
    const init = await withTimeout(
      agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "midterm-acp-probe", version: "0.1.0" },
      }),
      60_000,
      "initialize",
    );
    section("initialize", {
      protocolVersion: init.protocolVersion,
      agentInfo: init.agentInfo,
      agentCapabilities: init.agentCapabilities,
      authMethods: init.authMethods?.map((m) => m.id),
    });

    const server = args.mcp ? mcp.registerServer(agent, { name: args.serverName, handler: serveMcp }) : undefined;
    const newSession: Record<string, unknown> = {
      cwd,
      mcpServers: server ? [server.declaration] : [],
    };
    if (args.system !== undefined) {
      newSession.systemPrompt = { mode: args.systemMode, content: [{ type: "text", text: args.system }] };
    }
    if (args.meta) newSession._meta = args.meta;
    const session = (await withTimeout(
      agent.request(acp.methods.agent.session.new, newSession as unknown as acp.NewSessionRequest),
      120_000,
      "session/new",
    )) as acp.NewSessionResponse & Record<string, unknown>;
    const sessionId = session.sessionId;
    lastConfig = session.configOptions;
    lastModes = session.modes;
    section("session/new", { sessionId, modes: session.modes, configOptions: summarizeConfig(session.configOptions), _meta: session._meta });

    for (const [key, value] of args.config) {
      const options = (lastConfig ?? []) as ConfigOption[];
      const option = options.find((o) => o.id === key) ?? options.find((o) => o.category === key);
      if (!option) {
        section(`config ${key}`, "no such option");
        continue;
      }
      const res = await agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: option.id,
        value,
      } as acp.SetSessionConfigOptionRequest);
      lastConfig = (res as { configOptions?: unknown }).configOptions ?? lastConfig;
      section(`config ${option.id}=${value}`, "ok");
    }
    if (args.mode) {
      await agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: args.mode });
      section(`mode ${args.mode}`, "ok");
    }

    for (const text of args.prompts) {
      replies.length = 0;
      const timer = args.cancelAfter
        ? setTimeout(() => void agent.notify(acp.methods.agent.session.cancel, { sessionId }), args.cancelAfter)
        : undefined;
      const res = await withTimeout(
        agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] }),
        args.timeout,
        "session/prompt",
      );
      clearTimeout(timer);
      section(`prompt: ${text}`, { stopReason: res.stopReason, reply: replies.join("") });
    }

    if (args.close && init.agentCapabilities?.sessionCapabilities?.close != null) {
      await withTimeout(agent.request(acp.methods.agent.session.close, { sessionId }), 15_000, "session/close");
      section("session/close", "ok");
    }
  });
} catch (error) {
  exitCode = 1;
  section("error", error instanceof Error ? `${error.message}\n${JSON.stringify((error as { data?: unknown }).data ?? null)}` : error);
} finally {
  section("final config options", summarizeConfig(lastConfig));
  section("final modes", lastModes);
  section("tool calls", [...toolCalls.values()]);
  section("permission requests", permissions);
  section("mcp traffic", mcpLog.map((m) => (m.method === "tools/call" ? `${m.method} ${JSON.stringify(m.params)}` : m.method)));
  if (otherUpdates.size) section("other updates", Object.fromEntries(otherUpdates));
  if (thoughts.length) section("thoughts", thoughts.join("").slice(0, 2000));
  child.stdin.end();
  if (!exited) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!exited && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
  process.exit(exitCode);
}
