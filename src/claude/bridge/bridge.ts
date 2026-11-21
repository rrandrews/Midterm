/*
 * Request dispatch: parses protocol lines, routes methods, shapes answers.
 * `emit` is injected so tests (and main.ts) decide where lines go.
 */
import { BRIDGE_PROTOCOL } from "../protocol";
import type { BridgeEvent, BridgeLine, BridgeMethod, BridgeParams } from "../protocol";
import { memoryFiles, readConfig, writeConfig } from "./config";
import { BridgeFailure, toBridgeError } from "./errors";
import { listMarketplaces, listPlugins, pluginArgs, runMutation } from "./plugins";
import type { ExecFile } from "./plugins";
import { Sessions, childEnv, listPastSessions, pastSessionMessages } from "./session";

export type BridgeDeps = {
  write: (line: BridgeLine) => void;
  sdkVersion: string;
  claudePath?: string;
  exec?: ExecFile;
  env?: () => NodeJS.ProcessEnv;
};

type Handler = (params: any) => unknown | Promise<unknown>;

export function createBridge(deps: BridgeDeps) {
  const env = deps.env ?? (() => childEnv());
  const claudePath = () => deps.claudePath;
  const sessions = new Sessions((e: BridgeEvent) => deps.write(e), claudePath, env);
  const cli = () => ({ claudePath: deps.claudePath, env: env(), exec: deps.exec });
  const mutate = (args: (p: any) => string[]): Handler => (p) => runMutation(cli(), p.cwd, args(p));

  const handlers: { [M in BridgeMethod]: Handler } = {
    hello: () => ({
      protocol: BRIDGE_PROTOCOL,
      sdkVersion: deps.sdkVersion,
      nodeVersion: process.version,
      claudePath: deps.claudePath ?? null,
    }),
    "session.start": (p) => sessions.start(p),
    "session.send": (p) => (sessions.send(p), {}),
    "session.interrupt": async (p) => (await sessions.interrupt(p.session), {}),
    "session.close": (p) => (sessions.close(p.session), {}),
    "session.permission": (p) => (sessions.permission(p), {}),
    "session.setPermissionMode": async (p) => (await sessions.setPermissionMode(p), {}),
    "session.setModel": async (p) => (await sessions.setModel(p), {}),
    "session.setEffort": async (p) => (await sessions.setEffort(p), {}),
    "session.contextUsage": (p) => sessions.contextUsage(p),
    "session.usage": (p) => sessions.usage(p.session),
    "session.mcpStatus": (p) => sessions.mcpStatus(p.session),
    "session.mcpToggle": async (p) => (await sessions.mcpToggle(p), {}),
    "session.mcpReconnect": async (p) => (await sessions.mcpReconnect(p), {}),
    "session.reloadPlugins": (p) => sessions.reloadPlugins(p.session),
    "session.capabilities": (p) => sessions.capabilities(p.session),
    "session.stopTask": async (p) => (await sessions.stopTask(p), {}),
    "sessions.list": (p) => listPastSessions(p),
    "sessions.messages": (p) => pastSessionMessages(p),
    "plugins.list": (p: BridgeParams<"plugins.list">) => listPlugins(cli(), p.cwd, !!p.available),
    "plugins.install": mutate((p) => pluginArgs.install(p.id, p.scope)),
    "plugins.uninstall": mutate((p) => pluginArgs.uninstall(p.id, p.scope)),
    "plugins.enable": mutate((p) => pluginArgs.enable(p.id, p.scope)),
    "plugins.disable": mutate((p) => pluginArgs.disable(p.id, p.scope)),
    "plugins.update": mutate((p) => pluginArgs.update(p.id, p.scope)),
    "marketplaces.list": (p) => listMarketplaces(cli(), p.cwd),
    "marketplaces.add": mutate((p) => pluginArgs.marketplaceAdd(p.source)),
    "marketplaces.remove": mutate((p) => pluginArgs.marketplaceRemove(p.name)),
    "marketplaces.update": mutate((p) => pluginArgs.marketplaceUpdate(p.name)),
    "config.read": (p) => readConfig(p.cwd, p.scope),
    "config.write": (p) => writeConfig(p.cwd, p.scope, p.text),
    "config.memoryFiles": (p) => memoryFiles(p.cwd),
  };

  /** Handles one input line; never throws. Resolves once the answer has been written. */
  async function handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let id: number | undefined;
    try {
      const req = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown };
      if (typeof req.id !== "number") return; // cannot answer a request without an id
      id = req.id;
      const handler = typeof req.method === "string" && Object.prototype.hasOwnProperty.call(handlers, req.method) ? handlers[req.method as BridgeMethod] : undefined;
      if (!handler) throw new BridgeFailure(`Unknown method: ${String(req.method)}`, "invalid");
      const result = await handler((req.params ?? {}) as object);
      deps.write({ id, result: result ?? {} });
    } catch (e) {
      if (id !== undefined) deps.write({ id, error: toBridgeError(e) });
      else process.stderr.write(`bridge: bad line: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  return { handleLine, shutdown: () => sessions.closeAll() };
}
