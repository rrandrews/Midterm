/*
 * Plugin and marketplace management by running `claude plugin ...`: the
 * CLI owns the cache layout, settings entries and trust prompts, so the
 * bridge never touches those itself.
 */
import { execFile } from "node:child_process";
import type { AvailablePlugin, InstalledPlugin, Marketplace, PluginCommandResult, PluginScope } from "../protocol";
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
          return reject(new BridgeFailure(tail, "other", out));
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
  // No --yes: it would approve marketplace-declared commands unseen. Without it the CLI reports the
  // command (shownCommand) and refuses; the user approves it and we pass --accept-command <digest>.
  install: (id: string, scope: PluginScope, accept?: string) => [
    "plugin", "install", "--json", "--scope", scope, ...(accept ? ["--accept-command", accept] : []), id,
  ],
  uninstall: (id: string, scope: PluginScope) => ["plugin", "uninstall", "--scope", scope, "--yes", id],
  enable: (id: string, scope: PluginScope) => ["plugin", "enable", "--scope", scope, id],
  disable: (id: string, scope: PluginScope) => ["plugin", "disable", "--scope", scope, id],
  update: (id: string, scope: PluginScope, accept?: string) => [
    "plugin", "update", "--json", "--scope", scope, ...(accept ? ["--accept-command", accept] : []), id,
  ],
  marketplaceAdd: (source: string) => ["plugin", "marketplace", "add", source],
  marketplaceRemove: (name: string) => ["plugin", "marketplace", "remove", name],
  marketplaceUpdate: (name?: string) => ["plugin", "marketplace", "update", ...(name ? [name] : [])],
};

export async function runMutation(ctx: CliContext, cwd: string, args: string[]): Promise<{ output: string }> {
  const { output } = await runClaude(ctx, cwd, args);
  return { output };
}

/** Last parseable JSON object among the lines of `--json` output. */
function lastJson(text: string): Record<string, any> | undefined {
  for (const line of text.split("\n").reverse()) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") return v;
    } catch {
      // not the JSON line
    }
  }
  return undefined;
}

/** install/update with `--json`: a `shownCommand` in the result means the CLI wants the user's approval first. */
export async function runApproved(ctx: CliContext, cwd: string, args: string[]): Promise<PluginCommandResult> {
  let stdout: string;
  let output: string;
  try {
    ({ stdout, output } = await runClaude(ctx, cwd, args));
  } catch (e) {
    const json = e instanceof BridgeFailure && e.stdout ? lastJson(e.stdout) : undefined;
    const shown = json?.shownCommand;
    if (shown?.sha256) {
      const command = typeof shown.command === "string" ? shown.command : JSON.stringify(shown);
      return { output: String(json?.message ?? ""), confirm: { command, digest: String(shown.sha256), message: json?.message } };
    }
    if (json?.message && e instanceof BridgeFailure) throw new BridgeFailure(String(json.message), e.code);
    throw e;
  }
  const json = lastJson(stdout);
  return { output: json?.message ? String(json.message) : output };
}
