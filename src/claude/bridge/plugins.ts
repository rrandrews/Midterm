/*
 * Plugin and marketplace management by running `claude plugin ...`: the
 * CLI owns the cache layout, settings entries and trust prompts, so the
 * bridge never touches those itself.
 */
import { execFile } from "node:child_process";
import type { AvailablePlugin, InstalledPlugin, Marketplace, PluginScope } from "../protocol";
import { BridgeFailure } from "./errors";

export type ExecFile = typeof execFile;

const TIMEOUT_MS = 180_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export type CliContext = { claudePath: string | undefined; env: NodeJS.ProcessEnv; exec?: ExecFile };

/** Runs the CLI; resolves with the cleaned stdout+stderr, rejects with the output's last lines on failure. */
export function runClaude(ctx: CliContext, cwd: string, args: string[]): Promise<{ stdout: string; output: string }> {
  const claude = ctx.claudePath;
  if (!claude) return Promise.reject(new BridgeFailure("MIDTERM_CLAUDE_PATH is not set (claude not found)", "notFound"));
  const exec = ctx.exec ?? execFile;
  return new Promise((resolve, reject) => {
    exec(
      claude,
      args,
      { cwd, env: ctx.env, timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "").replace(ANSI, "");
        const err = String(stderr ?? "").replace(ANSI, "");
        const output = [out.trim(), err.trim()].filter(Boolean).join("\n").trim();
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return reject(new BridgeFailure(`claude not found at ${claude}`, "notFound"));
          const tail = (output || error.message).split("\n").slice(-8).join("\n");
          return reject(new BridgeFailure(tail, "other"));
        }
        resolve({ stdout: out, output });
      },
    );
  });
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BridgeFailure(`Unexpected output from claude (${what}): ${text.slice(0, 200)}`, "other");
  }
}

export async function listPlugins(
  ctx: CliContext,
  cwd: string,
  available: boolean,
): Promise<{ installed: InstalledPlugin[]; available: AvailablePlugin[] }> {
  const { stdout } = await runClaude(ctx, cwd, ["plugin", "list", ...(available ? ["--available"] : []), "--json"]);
  const data = parseJson<unknown>(stdout, "plugin list");
  if (Array.isArray(data)) return { installed: data as InstalledPlugin[], available: [] };
  const o = (data ?? {}) as { installed?: InstalledPlugin[]; available?: AvailablePlugin[] };
  return { installed: o.installed ?? [], available: o.available ?? [] };
}

export async function listMarketplaces(ctx: CliContext, cwd: string): Promise<Marketplace[]> {
  const { stdout } = await runClaude(ctx, cwd, ["plugin", "marketplace", "list", "--json"]);
  const data = parseJson<unknown>(stdout, "marketplace list");
  return Array.isArray(data) ? (data as Marketplace[]) : [];
}

/** Argument lists for the mutating commands (kept pure so they can be tested). */
export const pluginArgs = {
  install: (id: string, scope: PluginScope) => ["plugin", "install", "--scope", scope, "--yes", id],
  uninstall: (id: string, scope: PluginScope) => ["plugin", "uninstall", "--scope", scope, "--yes", id],
  enable: (id: string, scope: PluginScope) => ["plugin", "enable", "--scope", scope, id],
  disable: (id: string, scope: PluginScope) => ["plugin", "disable", "--scope", scope, id],
  update: (id: string, scope: PluginScope) => ["plugin", "update", "--scope", scope, "--yes", id],
  marketplaceAdd: (source: string) => ["plugin", "marketplace", "add", source],
  marketplaceRemove: (name: string) => ["plugin", "marketplace", "remove", name],
  marketplaceUpdate: (name?: string) => ["plugin", "marketplace", "update", ...(name ? [name] : [])],
};

export async function runMutation(ctx: CliContext, cwd: string, args: string[]): Promise<{ output: string }> {
  const { output } = await runClaude(ctx, cwd, args);
  return { output };
}
