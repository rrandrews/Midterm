/*
 * The Claude Code bridge protocol, shared by the bridge (src/claude/bridge/,
 * a Node program that runs Claude Code through the Agent SDK) and the
 * webview (src/claude/client.ts). The backend only pipes lines between the
 * two (src-tauri/src/claude/). See docs/claude-code.md.
 *
 * Wire format: one JSON object per line, both ways.
 *   webview → bridge   { id, method, params }            a request
 *   bridge  → webview  { id, result } | { id, error }    its answer
 *   bridge  → webview  { event, … }                      an event (no id)
 * The backend adds one event of its own: `bridgeExit` when the process ends.
 *
 * Only types live here (SDK types are imported as types, never at runtime),
 * so the webview bundle stays free of the SDK.
 */

import type {
  AccountInfo,
  AgentInfo,
  EffortLevel,
  McpServerStatus,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKControlReloadPluginsResponse,
  SDKMessage,
  SDKSessionInfo,
  SessionMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";

export type {
  AccountInfo,
  AgentInfo,
  EffortLevel,
  McpServerStatus,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKSessionInfo,
  SessionMessage,
  SlashCommand,
};
export type ContextUsage = SDKControlGetContextUsageResponse;
export type PlanUsage = SDKControlGetUsageResponse;
export type ReloadPluginsResult = SDKControlReloadPluginsResponse;

/** Bumped when requests or events change incompatibly; `hello` reports it. */
export const BRIDGE_PROTOCOL = 1;

/** A session key: chosen by the webview, one per pane session. Not the SDK's session id. */
export type SessionKey = string;

/** Where a Claude Code settings file lives (`~/.claude/…`, `<cwd>/.claude/…`). */
export type ConfigScope = "user" | "project" | "local";
/** Where a plugin is installed or enabled. */
export type PluginScope = "user" | "project" | "local";

/** An image attached to a message (base64, no data: prefix). */
export type ImageAttachment = { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string };

/** What the session's process reported when it started. */
export type SessionInit = {
  /** The SDK session id (the transcript on disk); saved in the pane data to resume. */
  sessionId?: string;
  claudeCodeVersion?: string;
  commands: SlashCommand[];
  models: ModelInfo[];
  agents: AgentInfo[];
  account?: AccountInfo;
  outputStyle?: string;
  availableOutputStyles?: string[];
  permissionMode?: PermissionMode;
  fastModeState?: string;
};

/** An installed plugin, as `claude plugin list --json` prints it. */
export type InstalledPlugin = {
  id: string; // name@marketplace
  version?: string;
  scope: PluginScope;
  enabled: boolean;
  installPath?: string;
  installedAt?: string;
  lastUpdated?: string;
  projectPath?: string;
};
/** A plugin a marketplace offers (`claude plugin list --available --json`). */
export type AvailablePlugin = {
  pluginId: string; // name@marketplace
  name: string;
  description?: string;
  marketplaceName: string;
  version?: string;
  installCount?: number;
  source?: unknown;
};
export type Marketplace = { name: string; source?: string; repo?: string; url?: string; path?: string; installLocation?: string };

export type ConfigFile = {
  scope: ConfigScope;
  path: string;
  exists: boolean;
  /** The file's text ("" when it does not exist). */
  text: string;
};
/** A plugin command's outcome; `confirm` when it did nothing yet because a marketplace command needs the user's approval. */
export type PluginCommandResult = { output: string; confirm?: { command: string; digest: string; message?: string } };

/** A memory file Claude Code would load for `cwd`. */
export type MemoryFile = { label: string; path: string; exists: boolean };

/* ---- Requests: method → [params, result] ---- */

export type BridgeMethods = {
  /** First request; the bridge answers once it is ready. */
  hello: [{}, { protocol: number; sdkVersion: string; nodeVersion: string; claudePath: string | null }];

  /**
   * Starts a session (a Claude Code process in streaming-input mode) in
   * `cwd`, resuming `resume` (an SDK session id) when given. Resolves once
   * the process has initialized. Its messages then arrive as `message`
   * events, permission prompts as `permission` events.
   */
  "session.start": [
    {
      session: SessionKey;
      cwd: string;
      resume?: string;
      model?: string;
      effort?: EffortLevel;
      permissionMode?: PermissionMode;
      /** Lets the session enter `bypassPermissions` (the SDK's `allowDangerouslySkipPermissions`); off unless the user turned it on in the plugin's settings. */
      allowBypass?: boolean;
    },
    SessionInit,
  ];
  /** Sends a user message. While a turn runs, it is queued by Claude Code and folded in. */
  "session.send": [{ session: SessionKey; text: string; images?: ImageAttachment[]; uuid: string }, {}];
  /** Interrupts the running turn (Esc). */
  "session.interrupt": [{ session: SessionKey }, {}];
  /** Ends the session and its process. Safe for an unknown key. */
  "session.close": [{ session: SessionKey }, {}];
  /** Answers a `permission` event. */
  /** `settled: false` when the prompt was already gone (cancelled or answered): the answer did nothing. */
  "session.permission": [{ session: SessionKey; requestId: string; result: PermissionResult }, { settled: boolean }];
  "session.setPermissionMode": [{ session: SessionKey; mode: PermissionMode }, {}];
  /** `undefined` model: the default. */
  "session.setModel": [{ session: SessionKey; model?: string }, {}];
  /** Session-only effort (`applyFlagSettings({ effortLevel })`); `null` = the model's default. */
  "session.setEffort": [{ session: SessionKey; effort: EffortLevel | null }, {}];
  "session.contextUsage": [{ session: SessionKey; detail?: "summary" | "full" }, ContextUsage];
  /** Session cost and plan rate limits (an experimental SDK call; may fail on other CLIs). */
  "session.usage": [{ session: SessionKey }, PlanUsage];
  "session.mcpStatus": [{ session: SessionKey }, McpServerStatus[]];
  "session.mcpToggle": [{ session: SessionKey; server: string; enabled: boolean }, {}];
  "session.mcpReconnect": [{ session: SessionKey; server: string }, {}];
  /** Reloads plugins from disk into the running session. */
  "session.reloadPlugins": [{ session: SessionKey }, ReloadPluginsResult];
  /** Fresh lists (after plugin changes). */
  "session.capabilities": [{ session: SessionKey }, { commands: SlashCommand[]; models: ModelInfo[]; agents: AgentInfo[] }];
  /** Stops a background task or subagent (`task_id` from task events). */
  "session.stopTask": [{ session: SessionKey; taskId: string }, {}];
  /**
   * A side question (`/btw`): answered from the conversation so far, with no
   * tools, and not added to it. Allowed while a turn runs. `answer` is null
   * when Claude gave none; `synthetic` when the answer is a canned notice.
   */
  "session.sideQuestion": [{ session: SessionKey; question: string }, { answer: string | null; synthetic: boolean }];

  /** Past sessions of a folder, newest first. */
  "sessions.list": [{ cwd: string; limit?: number }, SDKSessionInfo[]];
  /** A past session's messages, for showing its transcript when resuming. */
  "sessions.messages": [{ cwd: string; sessionId: string }, SessionMessage[]];
  /** Copies a past session into a new one (`/fork`) and returns its id. */
  "sessions.fork": [{ cwd: string; sessionId: string; title?: string }, { sessionId: string }];

  /** Through `claude plugin list --available --json`. `available` only when asked (it is large). */
  "plugins.list": [{ cwd: string; available?: boolean }, { installed: InstalledPlugin[]; available: AvailablePlugin[] }];
  /**
   * Installs without approving anything the marketplace asks to run. When the
   * CLI wants a command approved first, the answer carries `confirm`; show the
   * command and call again with `acceptCommand` = its digest.
   */
  "plugins.install": [{ cwd: string; id: string; scope: PluginScope; acceptCommand?: string }, PluginCommandResult];
  "plugins.uninstall": [{ cwd: string; id: string; scope: PluginScope }, { output: string }];
  "plugins.enable": [{ cwd: string; id: string; scope: PluginScope }, { output: string }];
  "plugins.disable": [{ cwd: string; id: string; scope: PluginScope }, { output: string }];
  /** Like `plugins.install`: may answer `confirm`. */
  "plugins.update": [{ cwd: string; id: string; scope: PluginScope; acceptCommand?: string }, PluginCommandResult];
  "marketplaces.list": [{ cwd: string }, Marketplace[]];
  "marketplaces.add": [{ cwd: string; source: string }, { output: string }];
  "marketplaces.remove": [{ cwd: string; name: string }, { output: string }];
  /** All marketplaces when `name` is not given. */
  "marketplaces.update": [{ cwd: string; name?: string }, { output: string }];

  /** A settings file of `scope` (user: `$CLAUDE_CONFIG_DIR` or `~/.claude`). */
  "config.read": [{ cwd: string; scope: ConfigScope }, ConfigFile];
  /**
   * Writes it atomically (creating `.claude/` as needed). Refuses text that
   * is not a JSON object. With `expected` (the file as the editor loaded it),
   * the write happens only if the file still matches, else it fails with code
   * "conflict"; writes to one file are serialized, so the check and the write
   * are one step. Leave `expected` out to overwrite on purpose.
   */
  "config.write": [{ cwd: string; scope: ConfigScope; text: string; expected?: { exists: boolean; text: string } }, ConfigFile];
  /** The CLAUDE.md files Claude Code would load for `cwd`, existing or not. */
  "config.memoryFiles": [{ cwd: string }, MemoryFile[]];
};

export type BridgeMethod = keyof BridgeMethods;
export type BridgeParams<M extends BridgeMethod> = BridgeMethods[M][0];
export type BridgeResult<M extends BridgeMethod> = BridgeMethods[M][1];

export type BridgeRequest<M extends BridgeMethod = BridgeMethod> = { id: number; method: M; params: BridgeParams<M> };
export type BridgeError = { message: string; code?: "notFound" | "auth" | "busy" | "invalid" | "closed" | "conflict" | "other" };
export type BridgeResponse = { id: number; result: unknown } | { id: number; error: BridgeError };

/** A tool-use permission prompt (the SDK's `canUseTool`), and also AskUserQuestion and ExitPlanMode. */
export type PermissionRequest = {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  /** Set when a subagent asks. */
  agentId?: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  /** "Always allow" rules the CLI proposes; send back as `updatedPermissions`. */
  suggestions?: PermissionUpdate[];
  /** A single keystroke must not approve this one: Allow is not the default action (⏎ does not allow). */
  defaultToNo?: boolean;
  /** Do not offer persistent ("always allow") grants for this one. */
  suppressAlwaysAllowRule?: boolean;
};

/* ---- Events ---- */

export type BridgeEvent =
  /** An SDK message of a session (assistant, user, stream_event, system/*, result, tool_progress…). */
  | { event: "message"; session: SessionKey; message: SDKMessage }
  | { event: "permission"; session: SessionKey; request: PermissionRequest }
  /** The CLI withdrew a prompt (the turn was interrupted). */
  | { event: "permissionCancelled"; session: SessionKey; requestId: string }
  /** The session's process ended; `error` when it was not closed on purpose. */
  | { event: "sessionEnded"; session: SessionKey; error?: string }
  /** A line the session's process wrote to stderr (debugging). */
  | { event: "stderr"; session: SessionKey; text: string }
  /** Sent by the backend when the bridge process exits. */
  | { event: "bridgeExit"; code: number | null; stderr: string };

export type BridgeLine = BridgeResponse | BridgeEvent;
