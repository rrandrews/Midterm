# Antigravity pane

The `antigravity` pane runs a full, interactive **Google Antigravity** coding
session in a project folder over the **Agent Client Protocol (`agy acp`)**:
all built-in tools, the user's own Antigravity sign-in, rules, skills, hooks,
and MCP servers. It is the counterpart to the [`claude-code`](claude-code.md)
pane and is separate from Midterm's locked-down Agent pane ([ai.md](ai.md#agent)).

Linear: `MID-104`.

## How it works

```
webview (src/antigravity/)  ──invoke/Channel──▶  backend (src-tauri/src/antigravity/)  ──stdio NDJSON──▶  `agy acp`
   UI, store, reducer, ACP v1 client                one process per pane session (LongChild)                 Antigravity CLI
```

- **Backend** (`src-tauri/src/antigravity/mod.rs`): no Node.js bridge is needed
  because `agy acp` speaks ACP v1 JSON-RPC 2.0 over stdio directly.
  `AntigravityManager` tracks connections by `connId` and window label (`owner`).
  Each pane session spawns its own `agy acp` process in its own process group
  via `LongChild`, located on the login shell's `PATH` (or the `agyPath`
  override). Connections are torn down on `antigravity_acp_close`, when the
  window reloads (`PageLoadEvent::Started`) or closes (`WindowEvent::Destroyed`),
  and on app exit (`RunEvent::Exit`).
- **ACP client** (`src/antigravity/acp.ts`): transport-agnostic JSON-RPC 2.0
  client typed against `@agentclientprotocol/sdk/unstable`. Supports
  `initialize`, `session/new`, `session/load`, `session/resume`, `session/list`,
  `session/delete`, `session/close`, `session/prompt`, `session/cancel`,
  `session/set_config_option`, and `session/set_mode`, plus agent-initiated
  `session/request_permission` and `elicitation/create` requests.
- **Reducer & Store** (`src/antigravity/reduce.ts`, `src/antigravity/store.ts`):
  pure `SessionUpdate` reducer + Zustand store with per-pane `createPaneState`,
  animation-frame update batching (100 ms fallback when hidden), client-side
  cancellable prompt queueing, and `session/load` / `session/resume` restore.
- **Browser dev mock** (`src/ipc/antigravity.ts`, `src/antigravity/mock.ts`):
  outside Tauri (`bun run dev`), swaps in an authentic ACP v1 JSON-RPC mock
  agent that exercises the real `AcpClient`, reducer, store, and UI. Speed up
  with `localStorage["midterm.antigravityMockSpeed"] = "10"`. Keyword triggers:
  `"ask"` (form elicitation), `"compact"`, `"auth"`, `"error"`, `"test"`.

## Pane & Settings

- Pane data: `{ cwd, sessionId?, mode?, model?, thoughtLevel? }`.
  `createData(from)` inherits `directoryOf(from)` else the home folder.
- `tabTitle`: session title (from `session_info_update`), else `"Antigravity"`.
- `closeBlockers`: warns when a turn is running or prompts are queued.
- Background activity: calls `api.panes.markActivity` when a turn completes or
  a permission/elicitation prompt arrives while the pane is not active.
- Plugin settings (`Settings → Plugins → Antigravity`):
  - `agyPath`: path override for `agy`
  - `sandbox`: pass `--sandbox` to `agy acp` (default `false` — interactive mode)
  - `defaultMode`: initial mode (`default`, `accept-edits`, `plan`)
  - `agentPreset`: optional `--agent <name>`
  - `additionalDirs`: extra paths passed via `--add-dir`
  - `showThinking`: show collapsible thinking blocks (default `true`)
  - `followFiles`: auto-reveal edited files in an editor pane (default `false`)

## UX Highlights

- **Context strip & ring**: 3px context bar under the 28px header fed by ACP
  `usage_update` (`used / size`, shifting `accent` → `warn` > 70% → `err` > 90%).
- **Clickable files & diffs**: every ACP `diff` card header and `ToolCallLocation`
  opens/reveals the file directly in Midterm's editor (`api.files.open`).
- **`@` file mentions**: typing `@` searches workspace files via `findFiles` +
  `fuzzysort` and attaches ACP `resource_link` blocks to the prompt.
- **Dynamic ACP config chips**: composer renders Mode (`⇧⇥` cycles), Model
  (flat or grouped), Thinking effort, and an overflow `⋯` menu for any extra
  boolean or select `configOptions` advertised by `agy acp`.
- **Slash commands (`/`)**: merges local pane commands (`/new`, `/clear`,
  `/plan`, `/mode`, `/model`, `/effort`, `/history`, `/files`, `/session`,
  `/status`, `/copy`, `/export`, `/login`) with live `available_commands_update`.
- **One-click auth recovery**: on `AUTH_REQUIRED` (`-32000`), displays a banner
  with a button to run `agy acp --login` in a new terminal pane and Retry.
- **4-tab right drawer**: **History** (`session/list`, folder toggle, search,
  load/resume, optional delete), **Files** (aggregated modified files with
  `+N −M`, inline diffs, open in editor), **Session** (context gauge, totals,
  all `configOptions`, `settings.json` shortcut), and **Plan** (`PlanEntry[]`).
