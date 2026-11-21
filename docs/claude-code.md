# Claude Code pane

The `claude-code` pane runs a full, ordinary **Claude Code** session in a
project folder, like the VS Code extension: all built-in tools, the user's
own settings, CLAUDE.md files, plugins, skills, hooks and MCP servers. It is
for the user's own coding work and has nothing to do with Midterm's Agent
pane ([ai.md](ai.md#agent)), which is locked down to Midterm's skills.

Linear: project "Claude Code Pane" (MID-95 … MID-100).

## How it works

```
webview (src/claude/)  ──invoke/Channel──▶  backend (src-tauri/src/claude/)  ──stdio, JSON lines──▶  bridge (node, src/claude/bridge/)
   store, UI, client                          spawns + pipes, per window                               Agent SDK → `claude` processes
```

- **Bridge**: `src/claude/bridge/main.ts`, a Node program bundled by
  `bun run build:bridge` into `src-tauri/resources/claude-bridge.mjs`
  (git-ignored; built by `dev` and `build`). It uses
  `@anthropic-ai/claude-agent-sdk` (`query()` in streaming-input mode, one
  per session) and always passes `pathToClaudeCodeExecutable` = the user's
  installed `claude`, so the SDK's bundled binary is never used. Plugin and
  marketplace commands run `claude plugin … --json`.
- **Protocol**: `src/claude/protocol.ts`, types only, shared by both ends.
  One JSON object per line: requests `{id, method, params}`, answers
  `{id, result | error}`, events `{event, …}`.
- **Backend**: one bridge process per window, started on first use
  (`claude_bridge_open`), lines piped both ways (`claude_bridge_send`, a
  `Channel<String>` for stdout). Ended when the window's page loads or the
  window is destroyed, at app exit, or by `claude_bridge_close`. The process
  group is killed, so the `claude` processes go with it.
- **Webview**: `src/claude/client.ts` (requests, events by session),
  `src/claude/store.ts` (zustand, one `ClaudeSession` per pane, see
  `src/claude/types.ts`), `src/claude/reduce.ts` (pure: SDK message →
  session state; unit-tested), `src/claude/plugin.tsx` (the pane plugin),
  `src/claude/ui/` (components), `src/styles/claude.css`.
- **Browser dev** (`bun run dev`, no Tauri): `src/ipc/claude.ts` serves a
  mock bridge that plays a scripted session (streaming text, tools, an edit,
  a permission prompt, a subagent, context and plan usage, plugins), so the
  UI can be built and screenshotted in a browser.

## Session options

`session.start` passes: `cwd`; `resume` (the pane's saved session id);
`model`, `effort`, `permissionMode` from the pane; `systemPrompt: { type:
"preset", preset: "claude_code" }` (without it the SDK sends an empty
prompt); `settingSources: ["user", "project", "local"]` (the user's real
configuration); `allowDangerouslySkipPermissions` only when the
`allowBypassPermissions` setting is on (`allowBypass`);
`includePartialMessages: true` (streaming); `forwardSubagentText: true`
and `agentProgressSummaries: true` (subagent observability); `canUseTool`
(prompts become `permission` events); `env` without `CLAUDECODE` /
`CLAUDE_CODE_ENTRYPOINT`.

## Pane

- Pane data: `{ cwd, sessionId?, model?, effort?, permissionMode? }`.
  `createData(from)` takes `directoryOf(from)`, else the home folder. On
  restore a saved `sessionId` is resumed with its transcript
  (`sessions.messages`).
- `tabTitle`: the session title, else "Claude Code". `closeBlockers`: a
  running turn, running background agents ("Claude Code (2 agents
  running)") or a first message waiting for the start (`sessionWork`).
  New session (header, menu, command) asks first in the same cases
  (`ui/actions.ts`). `directory`: `cwd`. Menu: New session, Interrupt, panels.
- Plugin settings (`settings.fields`): `claudePath` (override), `nodePath`
  (override), `defaultPermissionMode`, `allowBypassPermissions` (offers the
  bypass mode; off by default), `showThinking`.
- Requirements: Claude Code installed and signed in, Node.js 18.14 or later
  on the login shell's PATH (the backend checks both when the bridge
  starts).

## Design

Midterm's compact, token-only style (see [design-tokens.md](design-tokens.md)):
no raw hex, no pixel font sizes. Inter for UI, JetBrains Mono for code,
commands, paths and numbers that line up. Sentence case everywhere; no
all-caps labels except the `IN`/`OUT` gutter of tool cards.

**The signature: the context strip.** A 3px bar under the header, full
width, that *is* the context window: one segment per used category
(system prompt, tools, MCP tools, memory files, skills, messages) in its
category color, the autocompact buffer hatched, free space as the track.
It grows as the conversation does and is the first thing that tells you how
close compaction is. Hover shows the category; click opens the Context
panel. Everything else stays quiet.

Category colors (`src/claude/ui/panels/categories.ts`, by category id; used
by the strip and the Context panel's grid and legend): fixed costs in
greys, what the user controls in color. System prompt `fg-faint`, system
tools `fg-dim`, MCP tools `ansi-cyan`, custom agents `keyword`, memory
files `type`, skills `string`, messages `accent`, autocompact buffer
`fg-faint` hatched, free space `line`.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ✳ Fix flaky race test          ~/Code/app   ◔ 34%  $0.42  ●2  ⧉ ⌂ ⚙ ✎ │  header, 28px, text-meta
├▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆░░░░░░░▒▒▒▒▒──────────────────────────────────┤  context strip, 3px
│ ┌ user message (field bg, line-strong border, 6px radius) ─────────┐ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ○ Thought for 2s                                                     │  timeline rail on the left:
│ ● Markdown answer…                                                   │  1px line, 7px node dots
│ ● Bash  Run the test suite                                     2.1s  │  tool: name bold, gist fg-mid
│   ┌ IN  bun test ────────────────────────────────────────────────┐   │  expandable card (mono)
│   │ OUT 64 pass                                                  │   │
│   └──────────────────────────────────────────────────────────────┘   │
│ ● Edit  src/run.ts  +4 −1                                            │  diff card (ok/err tints)
│ ▲ Permission: Bash  rm -rf build   [Allow ⏎] [Always: Bash(rm:*)] [Deny]
├──────────────────────────────────────────────────────────────────────┤
│ ☐ 3/7 to-dos  ▸                                                      │  pinned to-do summary
│ ┌ Message Claude…  ─────────────────────────────────────────────────┐ │
│ │ + / ⊘ Ask before edits  Opus 5.5 High  ●2 agents          34% ↑ │ │  composer bar
│ └───────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

- **Header** (28px, `text-meta`): a small asterisk glyph in `accent`
  (pulses while running, still otherwise), the session title (`fg-mid`),
  the folder (`fg-dim`, `~`-shortened, click to change before the first
  message). Right side, right-padded 52px for the pane's hover controls:
  the context ring (14px donut + percent, `warn` past 70%, `err` past 90%),
  session cost (`$0.42`, mono), a running-agents chip (accent dot + count;
  hidden at 0), then icon buttons for the side panels and New session.
- **Timeline rail**: like the VS Code extension. A 1px vertical line in
  `line-strong`; each item hangs a 7px dot on it: answers `fg-dim`,
  thinking hollow, tools by status (running `accent` pulsing, done `ok`,
  error `err`, denied/cancelled `warn`). User messages break the rail: a
  full-width box (`field`, 1px `line-strong`, 6px radius).
- **Tool rows**: `Name` (600, `fg-bright`) + a one-line gist (`fg-mid`):
  the command, the file path (relative to cwd), the pattern, the URL,
  the subagent's description. Elapsed time right-aligned (`fg-dim`, mono).
  Click toggles a card (`field` background, 1px `line`, 6px radius) with
  `IN` / `OUT` gutter labels in `fg-faint` mono, output clipped to 12 lines
  with "Show all". Renderers: Bash (command, output, exit), Edit /
  MultiEdit / Write (unified diff: added lines `ok` at 10%, removed `err`
  at 10%, `+n −m` in the row), Read (path, line range), Grep / Glob
  (pattern, match count), TodoWrite (checklist), WebFetch / WebSearch,
  Agent / Task (a nested card: subagent type badge, description, live last
  tool and counts, "Open in Agents"), MCP tools (`server › tool`), generic
  JSON otherwise.
- **Permission prompts** sit in the transcript where the tool would run,
  with a 2px `accent` left edge: what will run (command or diff), then
  **Allow** (⏎), one button per suggestion ("Always allow `Bash(npm
  test:*)` in this project"), **Deny** (Esc) with an optional reason.
  ExitPlanMode shows the plan as Markdown with "Approve and auto-accept
  edits", "Approve", "Keep planning". AskUserQuestion shows its options as
  choices (multi-select where asked) and sends the answers back.
- **Composer**: a box (`field`, 1px `line-strong`, 8px radius). Placeholder
  "Message Claude…", or "Queue another message…" while running. ⏎ sends,
  ⇧⏎ new line, Esc interrupts, ⇧⇥ cycles the permission mode, ↑ in an empty
  box recalls the last message. `/` at the start opens command
  autocomplete above the box (name in mono, argument hint `fg-faint`,
  description `fg-dim`; ↑↓ ⏎ ⇥). Pasted images attach as thumbnails. The
  bar below: attach, commands, the mode chip (icon + label; bypass in
  `err`, plan in `info`, accept edits in `ok`), model chip (names of
  `init.models`), effort chip (gauge + level, "Auto" for the model default;
  the model's `supportedEffortLevels`, or low…max before init; hidden only
  when the model has `supportsEffort: false`), running agents chip, then the
  context percentage and Send / Stop (Stop is an `err` square).
- **To-dos**: the latest TodoWrite, pinned above the composer as one line
  ("3/7 · Running the test suite") that expands to the checklist.
- **Side panels**: a drawer on the right of the pane (320px, `popover`
  background, 1px `line` left border) when the pane is at least 720px wide,
  else over the transcript. A small tab row picks Context, Usage, Agents,
  Plugins, Config, History; Esc closes.
  - **Context**: the SDK's grid (`gridRows`: 10×N squares, each filled to
    its `squareFullness`) in category colors, then a legend with tokens and
    percent, "x of y tokens", autocompact threshold, memory files, MCP tools
    by server, skills, message breakdown. Refresh, and Compact (sends
    `/compact`).
  - **Usage**: this session's cost, durations, lines changed, tokens per
    model (input, output, cache read/write, cost); plan limits as bars
    (5-hour, 7-day, per model) with "resets in 3h 12m", extra usage when
    enabled. Bars `accent`, `warn` past 70%, `err` past 90%.
  - **Agents**: every task and subagent as a tree (by `parentTaskId`):
    status dot, type badge, description, elapsed, tokens, tool uses, last
    tool. Selecting one shows its transcript (the same timeline, compact).
    Stop on running ones. Below: the session's available agents.
  - **Plugins**: Installed (enable switch, scope badge, update, uninstall),
    Discover (search over marketplace plugins, virtualized, install with a
    scope), Marketplaces (add by repo/URL/path, update, remove), MCP
    servers (status dot, enable switch, reconnect). After a change, a
    "Reload plugins into this session" bar on every live session the
    change reaches (by scope), and a reload button that is always there.
    Install and update never pass `--yes`: when a marketplace wants to run
    a command, the CLI's approval request comes back as `confirm`, the
    panel shows the command, and only an approval re-runs it with
    `--accept-command <digest>`. Installs for other projects and synced
    plugins are listed read-only.
  - **Config**: a scope switch (User, Project, Local) with the file path.
    Fields: model, effort, default permission mode, permission rules
    (allow / ask / deny lists of rule chips with add and remove), env
    variables (key/value rows). Edits are applied to the JSON with
    `jsonc-parser` (`modify`), keeping unknown keys and formatting, and
    saved with Save. "Edit JSON" shows the raw text in a mono editor with
    validation (strict JSON object, the bridge's own rule: no comments,
    trailing commas or empty text); "Open in editor" opens the file in an
    editor pane. Drafts are keyed by file path, shared by every pane, and
    Save re-reads the file first: if it changed since it was loaded, a bar
    offers Reload or Overwrite instead of saving. Saving keeps the file's
    mode and follows symlinks. Memory: User, Project, Project (.claude)
    and Local CLAUDE.md files, plus parent folders' files that exist, with
    Open (creating them on demand).
  - **History**: past sessions of this folder (title or first prompt,
    relative time, branch); click resumes it in this pane.
- **Motion**: only in answer to something: the running dot pulses, rows
  expand, the strip's segments ease their width. Respect
  `prefers-reduced-motion`.
- **Empty state**: the folder, a line of what Claude Code can do here, and
  three of the session's slash commands as starters.

## Webview internals

- **Reducer** (`reduce.ts`, pure, `reduce.test.ts`): `reduce(session, message, now)`.
  `stream_event`s build items live (`streams` holds the message id and
  per-block item per thread); tool input JSON is parsed as it arrives
  (`parsePartialJson`). Each finished block's `assistant` message replaces
  the streamed item (first still-streaming item of that kind and message
  id). Item ids: `<msg id>#<block index>` streamed, `tool:<tool_use id>`.
  `parent_tool_use_id` routes to `subTranscripts[parent]`. Tool results set
  status (`done`, `error`, `denied` from the rejection text or
  `permission_denied`, `cancelled` on "interrupted by user"), the result
  text (64 KB) and `structured` (`tool_use_result`). `task_*` build `tasks`
  (ambient tasks skipped). `todos` (main thread): TodoWrite's list, or
  the CLI's task tools once they succeed (TaskCreate adds one, its id from
  the structured result or "Task #3 created…"; TaskUpdate changes or
  deletes one; TaskList / TaskGet refresh). Blank thinking (display
  omitted) shows as one quiet "Thought" line per run. `result` → totals
  (cost and per-model usage are cumulative in the CLI), a `result` item
  with that turn's cost, `contextWindow`, status idle (running while
  `queued_turn_count > 0`), and settles anything still streaming or
  running. `contextTokens` = input + cache read + cache write of the last
  main-thread API message. Status `compacting`, `compact_boundary`,
  `api_retry` (coalesced), `local_command_output`, `informational`, failed
  hooks and errors become notice/command items. Unknown messages are
  ignored. `conversation_reset` clears the transcript for every trigger.
  After a resume the first result's cost is left out (the CLI's total
  includes earlier spend). Diffs (`diffTexts`) use jsdiff's
  `structuredPatch`, with a time limit and a changed-middle fallback.
  Replayed calls have no structured results: Edit/MultiEdit diffs come
  from the input (without line numbers), an Agent's report is its result
  text, and a card with nothing to show has no body.
  `fromSessionMessages` replays a saved transcript the same way.
- **Store** (`store.ts`): a pane holds its session through
  `acquirePaneSession(paneId, data)` (a `createPaneState`; disposing closes
  the process). New session / resume give the pane a new session key.
  Messages are applied once per animation frame. The plugin sets
  `setPaneDataWriter` so `sessionId`, `model`, `effort`, `permissionMode`
  and `cwd` are saved to the pane data. Mode, model and effort changes
  show at once but are saved only once the session acknowledged them
  (`changeSetting`: one at a time, after a pending start; a refusal brings
  the old value back with a notice). `setModel` and `setEffort` change one
  setting each. Only the user's choices are saved (chips, and a mode picked
  in a permission prompt): values the CLI reports (init, status) never are,
  so a restored pane keeps its saved model, effort and mode. Composer drafts (text and images) are
  kept per session key (`getDraft`/`setDraft`) across unmounts. While a
  restored transcript loads (`loadingTranscript`) sends wait for it. A message sent while a turn runs is
  shown queued until the CLI folds it in (`user_message_uuids`).
  `allowBypass` comes from the `allowBypassPermissions` setting at start
  (`bypassAllowed(session)`).
- **UI** (`ui/`): `ClaudePane` (layout, width → drawer or overlay),
  `Header`, `ContextStrip`, `Transcript` (also used compact by the Agents
  panel), `ToolCall` + `tools.tsx` (per-tool cards) + `Diff`,
  `PermissionPrompt` (tools, ExitPlanMode, AskUserQuestion; honours
  `defaultToNo` and `suppressAlwaysAllowRule`), `Composer`, `Todos`;
  helpers in `format.ts` (`format.test.ts`). Styles: `src/styles/claude.css`.
- The browser mock (`mock.ts`) speeds up with
  `localStorage["midterm.claudeMockSpeed"] = "10"`. Turn triggers after
  the first (showcase) turn: "plan", "ask", "compact", "/cost", "/context",
  "fail"/"error".
