import { MOCK_HOME } from "../ipc/fsMock";
import type {
  AvailablePlugin,
  BridgeParams,
  ConfigFile,
  ConfigScope,
  InstalledPlugin,
  Marketplace,
  McpServerStatus,
  MemoryFile,
  PluginCommandResult,
  SDKSessionInfo,
} from "./protocol";

/*
 * Fake answers for the mock bridge (src/claude/mock.ts) to the requests the
 * side panels make: plugins, marketplaces, config files, past sessions and
 * the session's MCP servers. State (installs, written settings) lives in
 * memory for the page's lifetime. `undefined` means "not mine".
 */

/* ---- Plugins and marketplaces ---- */

const MARKETPLACES: Marketplace[] = [
  { name: "claude-plugins-official", source: "github", repo: "anthropics/claude-plugins-official", installLocation: `${MOCK_HOME}/.claude/plugins/marketplaces/claude-plugins-official` },
  { name: "community", source: "github", repo: "claude-community/marketplace", installLocation: `${MOCK_HOME}/.claude/plugins/marketplaces/community` },
  { name: "acme-internal", source: "git", url: "https://git.acme.dev/platform/claude-plugins.git", installLocation: `${MOCK_HOME}/.claude/plugins/marketplaces/acme-internal` },
];

/** A deterministic random generator, so the generated list is the same on every load. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const CURATED: Omit<AvailablePlugin, "pluginId">[] = [
  { name: "commit-commands", marketplaceName: "claude-plugins-official", description: "Streamline your git workflow with simple commands for committing, pushing, and creating pull requests.", installCount: 184_220, version: "1.4.0" },
  { name: "frontend-design", marketplaceName: "claude-plugins-official", description: "Create distinctive, production-grade frontend interfaces with high design quality. Generates creative, polished code that avoids generic AI aesthetics.", installCount: 156_031, version: "2.0.1" },
  { name: "feature-dev", marketplaceName: "claude-plugins-official", description: "Comprehensive feature development workflow with specialized agents for codebase exploration, architecture design, and quality review.", installCount: 98_412, version: "1.2.0" },
  { name: "code-review", marketplaceName: "claude-plugins-official", description: "Automated code review for pull requests using multiple specialized agents with confidence-based scoring.", installCount: 91_877, version: "1.1.3" },
  { name: "security-guidance", marketplaceName: "claude-plugins-official", description: "Security reminder hook that warns about potential security issues when editing files, including command injection, XSS, and unsafe code patterns.", installCount: 64_590, version: "1.0.2" },
  { name: "pr-review-toolkit", marketplaceName: "claude-plugins-official", description: "Comprehensive PR review agents specializing in comments, tests, error handling, type design, code quality, and code simplification.", installCount: 51_203, version: "1.3.0" },
  { name: "agent-sdk-dev", marketplaceName: "claude-plugins-official", description: "Development kit for working with the Claude Agent SDK.", installCount: 22_815, version: "0.9.4" },
  { name: "playwright", marketplaceName: "claude-plugins-official", description: "Browser automation and end-to-end testing with Playwright, as an MCP server and skills.", installCount: 77_340, version: "0.4.2" },
  { name: "context7", marketplaceName: "community", description: "Up-to-date, version-specific library documentation pulled straight into your prompts.", installCount: 120_554, version: "1.0.8" },
  { name: "linear", marketplaceName: "community", description: "Read and update Linear issues, projects and cycles from Claude Code.", installCount: 33_902, version: "1.6.0" },
  { name: "db-tools", marketplaceName: "acme-internal", description: "Query Acme's staging databases safely, with read-only roles and schema-aware completions. Builds a native SQLite driver on install.", installCount: 412, version: "3.1.0" },
  { name: "deploy-helper", marketplaceName: "acme-internal", description: "Deploy services to Acme's Kubernetes clusters with guard rails, dry runs and rollbacks.", installCount: 1_208, version: "2.4.0" },
  { name: "broken-plugin", marketplaceName: "community", description: "A plugin whose manifest fails to validate (for trying error states).", installCount: 3, version: "0.0.1" },
];

const WORDS_A = ["swift", "rust", "go", "python", "react", "vue", "svelte", "docker", "k8s", "terraform", "aws", "gcp", "postgres", "redis", "kafka", "graphql", "openapi", "jest", "vitest", "cypress", "tailwind", "astro", "next", "django", "rails", "elixir", "zig", "deno", "bun", "sentry", "datadog", "stripe", "slack", "notion", "figma", "jira", "github", "gitlab", "vercel", "supabase"];
const WORDS_B = ["toolkit", "helper", "linter", "reviewer", "migrator", "assistant", "scaffold", "docs", "skills", "agents", "hooks", "tester", "profiler", "formatter", "snippets", "guard", "explorer", "ops", "runner", "bench"];
const BLURBS = [
  "Skills and slash commands for everyday {a} work: scaffolding, refactors and idiomatic fixes.",
  "A {b} agent that knows {a} conventions and reviews your changes before you commit.",
  "Hooks that run {a} checks after every edit and report problems back to Claude.",
  "MCP server exposing {a} APIs as tools, with read-only defaults and per-project credentials.",
  "Opinionated {a} project templates and a /new command to start from them.",
  "Explains {a} errors, suggests fixes and links to the relevant documentation.",
];

function generateAvailable(): AvailablePlugin[] {
  const random = seeded(42);
  const markets = ["claude-plugins-official", "community", "community", "acme-internal"];
  const seen = new Set(CURATED.map((plugin) => `${plugin.name}@${plugin.marketplaceName}`));
  const out: AvailablePlugin[] = CURATED.map((plugin) => ({ ...plugin, pluginId: `${plugin.name}@${plugin.marketplaceName}` }));
  while (out.length < 300) {
    const a = WORDS_A[Math.floor(random() * WORDS_A.length)];
    const b = WORDS_B[Math.floor(random() * WORDS_B.length)];
    const marketplaceName = markets[Math.floor(random() * markets.length)];
    const name = `${a}-${b}`;
    const pluginId = `${name}@${marketplaceName}`;
    if (seen.has(pluginId)) continue;
    seen.add(pluginId);
    const blurb = BLURBS[Math.floor(random() * BLURBS.length)].replace("{a}", a).replace("{b}", b);
    const short = random() < 0.25;
    out.push({
      pluginId,
      name,
      marketplaceName,
      description: short ? blurb.split(":")[0].replace(/\.$/, "") + "." : blurb,
      installCount: Math.floor(Math.pow(random(), 3) * 40_000),
      version: `${Math.floor(random() * 3)}.${Math.floor(random() * 10)}.${Math.floor(random() * 10)}`,
    });
  }
  return out;
}

let available: AvailablePlugin[] | undefined;
const availablePlugins = () => (available ??= generateAvailable());

const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const installed: InstalledPlugin[] = [
  { id: "commit-commands@claude-plugins-official", version: "1.4.0", scope: "user", enabled: true, installedAt: days(40), lastUpdated: days(3) },
  { id: "frontend-design@claude-plugins-official", version: "2.0.1", scope: "user", enabled: true, installedAt: days(21), lastUpdated: days(21) },
  { id: "context7@community", version: "1.0.6", scope: "user", enabled: true, installedAt: days(60), lastUpdated: days(30) },
  { id: "security-guidance@claude-plugins-official", version: "1.0.2", scope: "user", enabled: false, installedAt: days(90), lastUpdated: days(90) },
  { id: "deploy-helper@acme-internal", version: "2.3.1", scope: "project", enabled: true, installedAt: days(12), lastUpdated: days(12) },
  { id: "playwright@claude-plugins-official", version: "0.4.2", scope: "local", enabled: true, installedAt: days(2), lastUpdated: days(2) },
];

/** Plugins whose install or update needs a marketplace command approved first. */
const NEEDS_APPROVAL: Record<string, { command: string; digest: string; message?: string }> = {
  "db-tools@acme-internal": {
    command: "npm install --prefix \"${CLAUDE_PLUGIN_ROOT}\" --no-audit better-sqlite3@11.8.1",
    digest: "sha256:5f0c1d7e9a2b4c6d8e0f1a3b5c7d9e1f",
    message: "Builds the native SQLite driver the plugin's MCP server uses.",
  },
  "deploy-helper@acme-internal": {
    command: "./scripts/install-kubectl-plugin.sh --version 2.4.0",
    digest: "sha256:9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a49",
  },
};

let marketplaces: Marketplace[] = [...MARKETPLACES];

function pluginCommand(id: string, acceptCommand: string | undefined, run: () => void): PluginCommandResult {
  const approval = NEEDS_APPROVAL[id];
  if (approval && acceptCommand !== approval.digest) return { output: "", confirm: approval };
  run();
  return { output: `✔ Done: ${id}` };
}

function findInstalled(id: string, scope: string): InstalledPlugin {
  const plugin = installed.find((candidate) => candidate.id === id && candidate.scope === scope);
  if (!plugin) throw new Error(`Plugin "${id}" is not installed in ${scope} scope.`);
  return plugin;
}

/* ---- Config ---- */

const USER_SETTINGS = `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "model": "opus",
  "effortLevel": "high",
  "permissions": {
    "allow": [
      "Bash(npm test:*)",
      "Bash(git status)",
      "Bash(git diff:*)",
      "WebFetch(domain:docs.anthropic.com)"
    ],
    "deny": [
      "Read(./.env)",
      "Bash(rm -rf:*)"
    ],
    "defaultMode": "acceptEdits"
  },
  "env": {
    "BASH_DEFAULT_TIMEOUT_MS": "120000",
    "DISABLE_TELEMETRY": "1"
  },
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh"
  },
  "enabledPlugins": {
    "commit-commands@claude-plugins-official": true,
    "frontend-design@claude-plugins-official": true
  }
}
`;

const PROJECT_SETTINGS = `{
    "permissions": {
        "allow": ["Bash(bun run typecheck)", "Bash(bun test:*)"],
        "ask": ["Bash(git push:*)"]
    },
    "hooks": {
        "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "bunx biome format --write $FILE" }] }]
    }
}
`;

const configTexts = new Map<string, string>();

function configPath(cwd: string, scope: ConfigScope): string {
  if (scope === "user") return `${MOCK_HOME}/.claude/settings.json`;
  return `${cwd}/.claude/${scope === "project" ? "settings.json" : "settings.local.json"}`;
}

function readConfig(cwd: string, scope: ConfigScope): ConfigFile {
  const path = configPath(cwd, scope);
  if (!configTexts.has(path)) {
    if (scope === "user") configTexts.set(path, USER_SETTINGS);
    else if (scope === "project") configTexts.set(path, PROJECT_SETTINGS);
  }
  const text = configTexts.get(path);
  return { scope, path, exists: text !== undefined, text: text ?? "" };
}

function writeConfig(cwd: string, scope: ConfigScope, text: string): ConfigFile {
  let value: unknown;
  try {
    // The mock's check is plain JSON (the bridge accepts comments too).
    value = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  } catch {
    throw new Error("The settings are not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The settings must be a JSON object.");
  configTexts.set(configPath(cwd, scope), text);
  return readConfig(cwd, scope);
}

function memoryFiles(cwd: string): MemoryFile[] {
  return [
    { label: "User memory", path: `${MOCK_HOME}/.claude/CLAUDE.md`, exists: true },
    { label: "Project memory", path: `${cwd}/CLAUDE.md`, exists: true },
    { label: "Project memory (.claude)", path: `${cwd}/.claude/CLAUDE.md`, exists: false },
    { label: "Local memory", path: `${cwd}/CLAUDE.local.md`, exists: false },
  ];
}

/* ---- Past sessions ---- */

function pastSessions(cwd: string, limit = 50): SDKSessionInfo[] {
  const now = Date.now();
  const minutes = (n: number) => now - n * 60_000;
  const list: SDKSessionInfo[] = [
    { sessionId: "6a1f9c2e-0d4b-4c8e-9f3a-2b7d5e8c1a40", summary: "Fix flaky race in the queue worker test", firstPrompt: "the worker test fails about 1 in 5 runs, find out why", gitBranch: "fix/worker-race", lastModified: minutes(14), createdAt: minutes(55), fileSize: 482_113 },
    { sessionId: "2c7e4a91-5b3d-4f6e-8a2c-9d1e0f7b3c58", summary: "Add retry with backoff to the scheduler", customTitle: "Scheduler retries", gitBranch: "feat/scheduler-retry", lastModified: minutes(190), createdAt: minutes(260), fileSize: 913_207 },
    { sessionId: "f3b8d2c6-7a1e-4d9b-b5c4-1e6f8a2d7c93", summary: "Migrate config loading to zod schemas", firstPrompt: "replace the hand-written config validation with zod", gitBranch: "main", lastModified: minutes(60 * 26), fileSize: 254_880 },
    { sessionId: "8d5a3e7f-2c9b-4a1d-9e6f-4b8c2d0a5e17", summary: "Explain how job leases are renewed", gitBranch: "main", lastModified: minutes(60 * 30), fileSize: 66_301 },
    { sessionId: "c1e9f4a2-6d8b-4e3c-a7f5-0b2d9c6e8a34", summary: "Review PR #482: batch dequeue", firstPrompt: "/review 482", gitBranch: "pr/482", tag: "review", lastModified: minutes(60 * 24 * 3), fileSize: 340_552 },
    { sessionId: "5b2d8f6c-1a7e-4c9d-8b3f-6e0a4d2c9f71", summary: "Set up Vitest and port the Jest suites", gitBranch: "chore/vitest", lastModified: minutes(60 * 24 * 6), fileSize: 1_204_998 },
    { sessionId: "9e4c1b7a-3f8d-4b2e-9c6a-5d0f2e8b4a63", summary: "", firstPrompt: "why is the dashboard p99 latency so high after the deploy on tuesday? look at the traces in ./traces", gitBranch: "main", lastModified: minutes(60 * 24 * 12), fileSize: 721_045 },
    { sessionId: "4f7a2c9e-8b1d-4e5f-a3c6-7d9b0e2f1a85", summary: "Initial CLAUDE.md for the repo", firstPrompt: "/init", gitBranch: "main", lastModified: minutes(60 * 24 * 45), fileSize: 98_870 },
  ];
  return list.map((session) => ({ ...session, cwd })).slice(0, limit);
}

/* ---- MCP (used when the mock bridge leaves session.* to this file) ---- */

const mcpServers: McpServerStatus[] = [
  { name: "context7", status: "connected", scope: "user", source: "plugin", serverInfo: { name: "context7", version: "1.0.8" }, tools: [{ name: "resolve-library-id" }, { name: "query-docs" }] },
  { name: "linear", status: "needs-auth", scope: "user", source: "user" },
  { name: "postgres-staging", status: "failed", scope: "project", source: "project", error: "connect ECONNREFUSED 127.0.0.1:5433" },
];

/* ---- Requests ---- */

export function mockRequest(method: string, params: unknown): unknown | undefined {
  switch (method) {
    case "plugins.list": {
      const p = params as BridgeParams<"plugins.list">;
      return { installed: installed.map((plugin) => ({ ...plugin })), available: p.available ? availablePlugins().filter((plugin) => marketplaces.some((market) => market.name === plugin.marketplaceName)) : [] };
    }
    case "plugins.install": {
      const p = params as BridgeParams<"plugins.install">;
      if (p.id.startsWith("broken-plugin@")) throw new Error("Plugin manifest is invalid: commands[0].name must be a string (plugin.json:7)");
      if (installed.some((plugin) => plugin.id === p.id && plugin.scope === p.scope)) throw new Error(`"${p.id}" is already installed in ${p.scope} scope.`);
      return pluginCommand(p.id, p.acceptCommand, () => {
        const source = availablePlugins().find((plugin) => plugin.pluginId === p.id);
        installed.push({ id: p.id, version: source?.version, scope: p.scope, enabled: true, installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() });
      });
    }
    case "plugins.uninstall": {
      const p = params as BridgeParams<"plugins.uninstall">;
      installed.splice(installed.indexOf(findInstalled(p.id, p.scope)), 1);
      return { output: `✔ Uninstalled ${p.id}` };
    }
    case "plugins.enable":
    case "plugins.disable": {
      const p = params as BridgeParams<"plugins.enable">;
      findInstalled(p.id, p.scope).enabled = method === "plugins.enable";
      return { output: `✔ ${method === "plugins.enable" ? "Enabled" : "Disabled"} ${p.id}` };
    }
    case "plugins.update": {
      const p = params as BridgeParams<"plugins.update">;
      const plugin = findInstalled(p.id, p.scope);
      const latest = availablePlugins().find((candidate) => candidate.pluginId === p.id)?.version;
      if (!latest || latest === plugin.version) return { output: `${p.id} is already at the latest version.` };
      return pluginCommand(p.id, p.acceptCommand, () => {
        plugin.version = latest;
        plugin.lastUpdated = new Date().toISOString();
      });
    }
    case "marketplaces.list":
      return marketplaces.map((market) => ({ ...market }));
    case "marketplaces.add": {
      const { source } = params as BridgeParams<"marketplaces.add">;
      const name = source.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? source;
      if (marketplaces.some((market) => market.name === name)) throw new Error(`Marketplace "${name}" is already added.`);
      if (!/^[\w.-]+\/[\w.-]+$/.test(source) && !/^(https?:|git@|\/|~|\.)/.test(source)) throw new Error(`"${source}" is not a GitHub repo (owner/repo), a git URL or a path.`);
      const market: Marketplace = /^[\w.-]+\/[\w.-]+$/.test(source) ? { name, source: "github", repo: source } : /^(\/|~|\.)/.test(source) ? { name, source: "directory", path: source } : { name, source: "git", url: source };
      marketplaces = [...marketplaces, market];
      return { output: `✔ Added marketplace ${name}` };
    }
    case "marketplaces.remove": {
      const { name } = params as BridgeParams<"marketplaces.remove">;
      if (!marketplaces.some((market) => market.name === name)) throw new Error(`No marketplace named "${name}".`);
      marketplaces = marketplaces.filter((market) => market.name !== name);
      for (let index = installed.length - 1; index >= 0; index--) if (installed[index].id.endsWith(`@${name}`)) installed.splice(index, 1);
      return { output: `✔ Removed marketplace ${name}` };
    }
    case "marketplaces.update": {
      const { name } = params as BridgeParams<"marketplaces.update">;
      if (name === "acme-internal") throw new Error("git fetch failed: Could not resolve host: git.acme.dev");
      return { output: name ? `✔ Updated ${name}` : `✔ Updated ${marketplaces.length} marketplaces` };
    }
    case "config.read": {
      const p = params as BridgeParams<"config.read">;
      return readConfig(p.cwd, p.scope);
    }
    case "config.write": {
      const p = params as BridgeParams<"config.write">;
      return writeConfig(p.cwd, p.scope, p.text);
    }
    case "config.memoryFiles":
      return memoryFiles((params as BridgeParams<"config.memoryFiles">).cwd);
    case "sessions.list": {
      const p = params as BridgeParams<"sessions.list">;
      return pastSessions(p.cwd, p.limit);
    }
    // sessions.messages: the mock bridge's own scripted transcript (mock.ts) is richer.
    case "session.mcpStatus":
      return mcpServers.map((server) => ({ ...server }));
    case "session.mcpToggle": {
      const p = params as BridgeParams<"session.mcpToggle">;
      const server = mcpServers.find((candidate) => candidate.name === p.server);
      if (!server) throw new Error(`No MCP server named "${p.server}".`);
      server.status = p.enabled ? "connected" : "disabled";
      return {};
    }
    case "session.mcpReconnect": {
      const p = params as BridgeParams<"session.mcpReconnect">;
      const server = mcpServers.find((candidate) => candidate.name === p.server);
      if (!server) throw new Error(`No MCP server named "${p.server}".`);
      if (server.status !== "failed") server.status = "connected";
      return {};
    }
    default:
      return undefined;
  }
}
