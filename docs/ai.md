# AI providers

Next-command suggestions in blocks mode come from a model the user picks: an
HTTP API (with a key) or a coding CLI they already have installed. The
webview never talks to a provider and never sees a key. It calls the `ai_*`
commands, and the Rust backend (`src-tauri/src/ai/`) makes the request or
runs the CLI. The webview's CSP stays "nothing remote"
([architecture.md](architecture.md#content-security-policy)).

## Backend

### Source map (`src-tauri/src/ai/`)

| File | What lives there |
|---|---|
| `mod.rs` | `AiManager` (Tauri state): dispatch by provider, the `max_tokens` budget, cancellation registry, lazy HTTP client. |
| `commands.rs` | The Tauri commands below. Thin. |
| `effort.rs` | Reasoning effort: levels offered per provider and model, Midterm's pick, clamping, token headroom, timeout scaling. |
| `provider.rs` | `ProviderId`, `ProviderConfig`, default base URLs, which backend each provider uses. |
| `openai.rs` | OpenAI-compatible chat completions adapter. |
| `anthropic.rs` | Anthropic Messages adapter (raw HTTP). |
| `http.rs` | Shared HTTP: client, send, HTTP-status → error mapping, error-body parsing. |
| `cli.rs` | CLI providers: locating, status, argument builders, running. |
| `shell_path.rs` | The login shell's PATH (marker extraction, merge, executable lookup). |
| `process.rs` | Child process with stdin, timeout, and process-group kill on drop. |
| `keys.rs` | Keys in the OS credential store (`keyring`). |
| `error.rs` | `AiError { kind, message }`. |
| `stub.rs` | Tests only: a stub HTTP server on 127.0.0.1. |

### Providers

| Id | Backend | Default base URL | Key |
|---|---|---|---|
| `openai` | OpenAI-compatible | `https://api.openai.com/v1` | required |
| `deepseek` | OpenAI-compatible | `https://api.deepseek.com` | required |
| `openrouter` | OpenAI-compatible | `https://openrouter.ai/api/v1` | required |
| `gemini` | OpenAI-compatible | `https://generativelanguage.googleapis.com/v1beta/openai` | required |
| `custom` | OpenAI-compatible | none: `baseUrl` is required | optional |
| `anthropic` | Anthropic Messages | `https://api.anthropic.com/v1` | required |
| `claude-code` | CLI `claude` | | CLI's own login |
| `codex` | CLI `codex` | | CLI's own login |
| `antigravity` | CLI `agy` | | CLI's own login |

`baseUrl` is used **only by `custom`**; the other providers always use their
default, so a stored key can only ever go to its own provider whatever the
webview sends (a proxy or gateway is set up as `custom`, with its own key).
It must be `https://`, or `http://` to a loopback host (`localhost`,
`127.0.0.1`, `::1`) for a local server, with no query or fragment; a
trailing `/` is dropped. Paths are appended to it (`/chat/completions`,
`/models`, `/messages`). The HTTP client follows **no redirects** (a
redirect to another origin would carry `x-api-key` along; reqwest strips
only `Authorization`), and error messages have the request's key (of any
length) replaced with `[redacted]` in case a provider echoes it. The
provider's error detail is redacted **before** it is shortened to 300
characters, so a key straddling the cut cannot leak half of itself. A
`custom` key is bound to its base URL (see [Keys](#keys)), so editing the
URL never sends the old key to the new host. No model ids are
hard-coded anywhere: the UI lists them with `ai_models`.

### Request shapes

Common to every HTTP request: one non-streaming call, a system prompt and
one user message, **no sampling parameters** (`temperature`, `top_p`,
`top_k`: current Claude models reject them, and reasoning models on other
providers do too), a reasoning effort (see "Reasoning effort" below), and a
generous `max_tokens`. On current models `max_tokens` covers reasoning as
well as the reply, and too small a limit ends in an empty reply, so the
backend sends `maxTokens` (the reply budget, default 512, clamped to
16–32000) **plus headroom that grows with effort**: 4096 up to low, 8192 for
medium, 16384 for high and "Provider default", 32768 for xhigh and max
(`output_budget` in `mod.rs`, `effort::headroom`). Timeouts: 10 s to connect,
60 s in total, doubled for high and "Provider default", tripled for xhigh
and max.

**OpenAI-compatible** (`openai.rs`), `POST {base}/chat/completions`:

```json
{ "model": "…", "messages": [{ "role": "system", "content": "…" }, { "role": "user", "content": "…" }],
  "stream": false, "max_tokens": 4608, "reasoning_effort": "low" }
```

| Provider | Token field | Effort field |
|---|---|---|
| OpenAI | `max_completion_tokens` (its reasoning models reject `max_tokens`) | `reasoning_effort` |
| DeepSeek | `max_tokens` | `reasoning_effort`; off is `thinking: { type: "disabled" }` |
| Gemini | `max_tokens` | `reasoning_effort` (mapped server-side to its thinking level or budget) |
| OpenRouter | `max_tokens` | `reasoning: { effort, exclude: true }` (its normalized form) |
| custom | `max_tokens` | `reasoning_effort` when the user picked a level; nothing by default |

The system message uses role `system` (OpenAI maps it to `developer` for
its reasoning models). If the provider answers **400 or 422 with a body
mentioning "reasoning", "effort" or "thinking"** (a model without
reasoning, or a level it does not take), the request is sent once more
without the effort field, and that provider, base URL, model and level are
remembered until restart, so later requests skip the failed attempt. Auth is `Authorization: Bearer <key>`,
left out for `custom` without a key.

The reply is `choices[0].message.content` (a string, or an array of
`{ type: "text", text }` parts on some servers). A leading
`<think>…</think>` block (reasoning models behind compatible servers) is
removed. `message.refusal` or `finish_reason: "content_filter"` is
`refused`. No text is `empty`, with a token-limit hint when
`finish_reason` is `length`.

Models: `GET {base}/models` → `data[].id`, sorted, with a `models/` prefix
dropped.

**Anthropic** (`anthropic.rs`), `POST {base}/messages`, raw HTTP (there is
no official Rust SDK, and it is not routed through an OpenAI-compatible
shim):

```json
{ "model": "…", "max_tokens": 4608, "system": "…",
  "messages": [{ "role": "user", "content": "…" }],
  "output_config": { "effort": "low" } }
```

Headers `x-api-key` and `anthropic-version: 2026-10-21` (the current API
version; nothing it changed is used here). The model's capabilities come
from `GET {base}/models/{id}` (`capabilities.effort.<level>.supported`,
`capabilities.thinking.types.{adaptive,enabled}.supported`, `max_tokens`),
looked up once per model per launch (a failure for lack of a key or
network is retried next time; any other is remembered). The reasoning
fields (`anthropic::plan`):

- Midterm's pick: `output_config: { effort: "low" }` and no `thinking`
  field, as before: current models think adaptively by default (and some
  reject turning it off), older ones run without it.
- A level the user picked, on a model with effort: `output_config.effort`
  plus `thinking: { type: "adaptive" }` when the model supports it (on
  Opus 4.6–4.8 this turns thinking on; they run without it by default).
- A model with only budget thinking (Haiku 4.5, Sonnet 4.5 and older): off
  sends nothing; low/medium/high send `thinking: { type: "enabled",
  budget_tokens: 1024 / 4096 / 16384 }` with `max_tokens` = reply + budget,
  capped at the model's output limit (`1024 <= budget < max_tokens`, or no
  thinking).
- Capabilities unknown: `output_config.effort` only.

A 400/422 mentioning `effort`, `output_config`, `thinking` or
`budget_tokens` is retried once with neither field, and remembered as
above. The
reply is the concatenated `text` blocks of `content`. `stop_reason:
"refusal"` is `refused`, with `stop_details.explanation` as the message
when present. No text is `empty`, with a token-limit hint on `stop_reason:
"max_tokens"`.

Models: `GET {base}/models?limit=1000`, following `has_more` / `last_id`
(`after_id`), up to 10 pages.

### Reasoning effort

`settings.ai.effort[provider]` is unset (Midterm's pick), `default` (send
nothing; the provider decides) or a level: `none` (off), `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`. The backend (`effort.rs`) decides what each
provider and model offers and clamps a stored level that the model does not
offer to the nearest one below it (else the lowest above); the stored
setting is not rewritten. Midterm's pick reproduces the requests from before
the setting existed: low everywhere, nothing for `custom` or an Antigravity
model chosen by id, off for an Anthropic model with only budget thinking.

| Provider | Levels offered | How |
|---|---|---|
| OpenAI | full ladder; `gpt-6.2*`, `gpt-6.1-sol*`, `gpt-6-astra*`: low–max; other `gpt-6*`: off + low–max | id prefix |
| Anthropic | the model's `capabilities.effort` leaves; budget-only models: off, low, medium, high; unknown capabilities: low–max | Models API |
| Gemini | `gemini-4-neon`/`-hydrogen`: low–xhigh; other `gemini-4-`, `gemini-3.8-flash`, `gemini-3.1-pro`, `gemini-2.5-pro`: low–high; `gemini-3-pro`: low, high; other `gemini-3`: minimal–high; other `gemini-2.5-`: off + low–high; else low–high | id prefix |
| DeepSeek | off, low, high, max | one list |
| OpenRouter | full ladder (it normalizes) | — |
| custom | off, low, medium, high (dropped if rejected) | — |
| Claude Code, Codex | low–max | the CLI clamps |
| Antigravity | low–max; none when the model id ends in a level (`…-low`) | id suffix |

Model families are matched by id prefix (OpenRouter's `vendor/` prefix is
ignored): the providers other than Anthropic have no API that lists effort
levels. This is the one place model ids are hard-coded; an unknown id gets
the provider's full ladder and relies on the retry above.

### CLI providers

Found through **the login shell's PATH**. An app started from Finder
inherits launchd's minimal PATH, so `shell_path.rs` runs `$SHELL -l -i -c`
once (zsh on macOS if `SHELL` is unset; 10 s timeout, `TERM=dumb`, stdin
`/dev/null`) with a command that prints `$PATH` between two unique markers.
Start-up files can print anything, OSC sequences from shell integration
included, so the value is cut from between the last marker pair. The
result, followed by the app's own PATH and `/opt/homebrew/bin`,
`/usr/local/bin`, `~/.local/bin`, is cached for the life of the app
(`Discovery`). On Windows the process PATH is used as is.

`cliPath` overrides the executable: an absolute path, `~/…`, or a bare name
looked up on that PATH. The CLI is always run with the resolved PATH (an
`#!/usr/bin/env node` script needs it to find `node`), `NO_COLOR=1`,
`TERM=dumb`, and without `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` (Claude
Code refuses to start "inside another session" when those are inherited).

Every run: a fresh empty temporary directory as the working directory
(deleted afterwards), stdout/stderr captured, a 120 s timeout (scaled with
effort like HTTP), its own
process group, and the whole group is SIGKILLed on timeout or cancel
(`process.rs`). The group is never signalled once the CLI has been reaped
(its id could be reused), and output still held open by a leftover
descendant is read for at most 2 s after the CLI exits. On Windows only the
direct child is killed (an M11 item). Output has ANSI escapes stripped and is trimmed; a non-zero
exit is an error with the tail of what the CLI printed (`auth` if it looks
like a login problem). Flags, verified against the versions installed in
November 2026:

| CLI | Version checked | Invocation |
|---|---|---|
| Claude Code | 2.1.328 | `claude -p --safe-mode --output-format text --tools "" --strict-mcp-config --disable-slash-commands --permission-mode dontAsk --no-session-persistence [--effort E] --system-prompt S [--model M]`, prompt on stdin. `CLAUDE_CODE_EFFORT_LEVEL` (which outranks `--effort`) is removed from the environment when a level is sent. `--tools ""` turns off every built-in tool. `--system-prompt` is always passed (a one-line default when the caller has none), so Claude Code's own system prompt is never used; `--safe-mode` (Claude Code 2.1.169 or later; `ai_cli_status` reports an older version as `outdated` and Settings shows it) leaves out the user's CLAUDE.md files, skills, plugins, hooks and output styles. Claude Code still adds its environment and account context block; no supported flag removes it (`--bare` would, but it drops OAuth sign-in). |
| Codex | codex-cli 0.170.0 | `codex exec --ignore-user-config -c mcp_servers={} --sandbox read-only --skip-git-repo-check --ephemeral --color never [-c model_reasoning_effort="E"] -c model_instructions_file="<tmp>/instructions.md" -c include_{permissions,apps,collaboration_mode}_instructions=false -c include_environment_context=false -c project_doc_max_bytes=0 -C <tmp> -o <tmp>/last-message.txt [-m M] -`, prompt on stdin. The system prompt is written to `instructions.md` and replaces Codex's base instructions; the extra instruction sections and AGENTS.md are turned off. The reply is read from the `-o` file (stdout carries progress). The user's `config.toml` (and the MCP servers in it) is not loaded, so a run fed with terminal output has no side-effecting tools; sign-in still comes from `CODEX_HOME`. A failed run whose output mentions `reasoning_effort` is run once more without it. |
| Antigravity | 1.5.12 | `agy --sandbox --disable-slash-commands --output-format text [--effort E] [--model M] -p "<system>\n\n<prompt>"`. `-p` takes the prompt as its value (no stdin form). Model ids can carry their effort (`gemini-…-low`); then no `--effort` is passed. No `--dangerously-skip-permissions`, so tool permissions are not granted. agy has no flag to replace its own system prompt, so ours is prepended to the prompt; it runs in an empty workspace, so no project rules load. `--mode plan` is not used: it turns the reply into a planning session. |

`agy -p` printed nothing without a TTY in some versions (upstream issue
76); 1.5.12 prints normally with stdout piped, so it is run without a PTY.
If an older version prints nothing, the result is an `empty` error.
All three CLIs' flags were checked by running them headless (Codex
0.170.0 with exactly the flags above).

Models: `agy models` prints `id<TAB>name` lines, parsed into ids. Claude
Code and Codex have no listing command, so `ai_models` returns `[]` and the
UI takes free text (Claude Code accepts aliases such as `sonnet`).

CLI replies can come wrapped in backticks (Antigravity did in testing); the
backend returns the text as printed.

### Keys

`keys.rs` stores one entry per HTTP provider in the OS credential store via
`keyring` 4 (Keychain on macOS, Credential Manager on Windows, Secret
Service on Linux): service `com.ron.midterm.ai`, account =
`ProviderConfig::key_account()`:

- the provider id for every provider but `custom`;
- `custom:<base URL>` for `custom`, with the URL normalized exactly as
  requests use it (`ProviderConfig::base_url()`: trimmed, validated,
  trailing `/` dropped), e.g. `custom:http://localhost:1234/v1`.

So a custom key only ever goes to the endpoint it was saved for: changing
the base URL finds no key, and since `custom`'s key is optional the request
goes out without one (the UI shows "no key" for the new URL). Keys saved for
older URLs stay in the store until deleted with that URL.

If the lookup itself fails (no Secret Service on Linux, a denied Keychain
prompt), a provider whose key is optional (`custom`) logs it and continues
without a key, so a keyless local server works without a credential store.
Other providers reject with the store's error (`other`).

Keys are never written to settings files. The webview can set, delete and
ask whether a key is set; **no command returns a key**. The calls run on
the blocking pool, since the OS may show a prompt (a re-signed dev build can
trigger a Keychain "allow access" dialog). CLI providers take no key.

### Commands

Arguments are camelCase on the wire (Tauri's default); results are
camelCase.

```ts
type ProviderId = "openai" | "anthropic" | "deepseek" | "openrouter" | "gemini" | "custom"
               | "claude-code" | "codex" | "antigravity";
type ProviderConfig = { id: ProviderId; baseUrl?: string; cliPath?: string };

ai_suggest({ requestId: string, provider: ProviderConfig, model: string, system: string,
             prompt: string, maxTokens?: number, effort?: EffortLevel }) -> { text: string }
ai_cancel({ requestId: string }) -> void
ai_models({ provider: ProviderConfig }) -> string[]
ai_test({ provider: ProviderConfig, model: string, effort?: EffortLevel }) -> { ok: boolean, message: string }
ai_effort_options({ provider: ProviderConfig, model: string, effort?: EffortLevel })
    -> { levels: Effort[], effective: Effort | null, note: string | null }
ai_key_set({ provider: ProviderConfig, key: string }) -> void
ai_key_delete({ provider: ProviderConfig }) -> void
ai_key_status({ provider: ProviderConfig }) -> boolean
ai_cli_status({ provider: ProviderConfig }) -> { found: boolean, path?: string, version?: string }
```

- `ai_suggest`: `model` is required for HTTP providers and optional for CLIs
  (empty = the CLI's default). `maxTokens` is the reply budget; headroom for
  reasoning is added. `effort` is the stored setting (absent: Midterm's pick).
- `ai_cancel`: aborts the HTTP request or kills the CLI; the pending
  `ai_suggest` rejects with `cancelled`. A cancel that arrives before its
  `ai_suggest` registered is remembered (the last 64), so the request is
  cancelled as soon as it starts. Cancels for ids that already started
  (the last 256) are ignored, so a late or repeated cancel never cancels a
  later request that reuses the id. Reusing a running request's id cancels
  the older request. Completion is decided under the registry lock:
  `ai_cancel` and a replacement both remove the request's entry under that
  lock, and the request delivers its result only if its own entry (same
  generation) is still registered when it finalizes, removing it in the
  same critical section. So a request cancelled or replaced at any point
  before it finalizes, even after its result was ready, rejects with
  `cancelled`.
- `ai_models`: the provider's live list; `[]` for Claude Code and Codex.
  Needs a key (except `custom`).
- `ai_test`: a tiny request ("Reply with OK", 16 reply tokens). Never
  rejects for provider failures: they come back as `{ ok: false, message }`.
  The message names the effort sent, or says it was rejected.
- `ai_effort_options`: the levels offered for the model (lowest first; the
  UI adds "Automatic" and "Provider default"), what the stored setting
  would send, and a note (e.g. an Antigravity model id that sets its own
  effort). For Anthropic it looks up the model's capabilities (needs the
  key); the result is cached with the requests'.
- `ai_key_set` trims the key and rejects an empty one; `ai_key_delete` of a
  missing key succeeds. All three key commands take the full
  `ProviderConfig` and reject CLI providers. For `custom`, `baseUrl` is
  required (and validated like a request's): the key is stored under that
  URL. Other providers ignore `baseUrl`.
- `ai_cli_status`: rejects HTTP providers. `version` is the first line of
  `--version`.

### Errors

Every command rejects with `{ kind, message }`:

| `kind` | When |
|---|---|
| `noKey` | No key stored for a provider that needs one. |
| `auth` | HTTP 401/403, or a CLI that exited with a login/API-key message. |
| `network` | No HTTP answer (DNS, connection refused, TLS). |
| `http` | Any other non-2xx status; the message has the status and the provider's error message. |
| `refused` | Anthropic `stop_reason: "refusal"`, OpenAI `message.refusal`, `finish_reason: "content_filter"`. |
| `empty` | The model returned no text (with a hint when the token limit was hit). |
| `timeout` | 60 s for HTTP, 120 s for a CLI run (×2 at high or "Provider default", ×3 at xhigh or max). |
| `cancelled` | `ai_cancel` was called. |
| `notFound` | A CLI's executable was not found (or `cliPath` is not executable). |
| `other` | Everything else: no model chosen, bad base URL, keychain failure, unexpected response, CLI failure. A redirect (3xx) comes back as `http`. |

### Tests

`cargo test ai::` in `src-tauri/`. Adapters run against `stub.rs` (a
hand-rolled HTTP server on `127.0.0.1:0` serving canned responses and
recording requests): success, request shape (no sampling fields, effort
fields per level, Anthropic adaptive and budget shapes), retry without effort
(400 and 422) and its memo per level, Anthropic capabilities parsing and
the budget invariant, refusal, empty, 401/5xx, unreachable
server, model listing and pagination, cancel mid-request, a cancel or
replacement landing after the result is ready, redaction before
truncation, keychain accounts (`custom` bound to its URL), and keyless
`custom` surviving a failed key lookup. The credential store itself is not
exercised by tests. CLI tests use
fake executables (flags, empty working directory, stdin) and check that
cancel kills the process group. Pure helpers (PATH markers, merge, lookup,
argument builders, response parsing, ANSI stripping, effort levels,
clamping, headroom) have unit tests.
`cargo test live_clis -- --ignored --nocapture` runs the CLIs installed on
the machine at low and medium effort (spends a little quota).

## Frontend

Code: `src/ai/` and `src/ipc/ai.ts`. Installed by `installAi()` from
`main.tsx`.

| File | What |
|---|---|
| `src/ipc/ai.ts` | Typed wrappers for the `ai_*` commands; `PROVIDERS` (names, API or CLI, key needed); `toAiError`. In a plain browser a mock answers: keys in memory, a canned suggestion after 600 ms, cancellable. |
| `context.ts` | Pure: `buildContext` (system prompt and prompt), `redact`, `trimOutput`, `parseSuggestion`. Unit-tested in `context.test.ts`. |
| `engine.ts` | The suggestion engine, per pane and outside React; `contextFor(paneId)`; `aiConfigured`, `providerReady`, `providerConfig`, `localPrediction`. |
| `slash.ts` | Slash commands for the blocks editor: the registry, `parseSlash`, `slashCompletion`, and `/cmd`'s request (`writeCommand`, `buildCmdRequest`). Unit-tested in `slash.test.ts`. |
| `predict.ts` | Pure: local next-command prediction from the command log (`predictNext`, `tokenize`). Unit-tested in `predict.test.ts`. |
| `AiSection.tsx` | Settings → AI. |
| `commands.ts` | Commands, the terminal menu's per-pane switch, registration. |

### Settings

`settings.ai` (`src/settings/schema.ts`):

| Field | Meaning |
|---|---|
| `suggestions` | On by default. Local predictions work right away; model requests wait until a provider is chosen (and a model, for APIs; a base URL for `custom`). |
| `provider` | A provider id, or empty for none. |
| `model` | The model id. Empty means the CLI's default, for CLI providers only. |
| `baseUrl` | For `custom`. |
| `cliPaths` | Executable overrides, by provider id. |
| `contextBlocks` | Finished blocks sent as context (0–20, default 5). |
| `effort` | Reasoning effort by provider id: missing (Midterm's pick), `default` (send nothing) or a level. See "Reasoning effort". |

A pane's own switch is `aiSuggestions: false` in the terminal pane's data
(terminal menu → "Suggestions in this pane", shown while suggestions are
on). It turns off local predictions too.

Keys never pass through the settings. The key field is write-only: Save
sends it to `ai_key_set`, and the UI only ever learns `ai_key_status`. A
`custom` key is kept per base URL.

### Context

`contextFor(paneId)` collects:

- the OS and shell (the foreground program while at the prompt);
- the working directory, with home shown as `~`;
- the git branch;
- at a nested shell's prompt (over ssh, see
  [terminal.md](terminal.md#nested-shells)) instead: the remote host and
  its directory, no OS, shell or branch, and only that shell's commands;
- the last `contextBlocks` finished blocks: the command, its directory if
  different, its output (`blockOutput`), and the exit status;
- up to 20 earlier commands of the same terminal (never other panes' or
  the saved global history).

The branch is looked up at the current prompt, not taken from the last
block (which has the branch from when it started).

`buildContext` strips escape sequences from each output, redacts it, and
only then trims it to its first 15 and last 25 lines (240 characters per
line, 3000 per block). Redacting first means a secret that straddles a cut
is still recognised. The whole prompt is redacted again at the end. `redact` replaces:

- PEM private keys;
- well-known token shapes: OpenAI and Anthropic `sk-…`, GitHub `ghp_` and
  `github_pat_`, GitLab, Slack, AWS access key ids, Google API keys, npm,
  and JWTs;
- the value of assignments whose name contains SECRET, TOKEN, PASSWORD,
  PASSPHRASE, API_KEY, ACCESS_KEY, PRIVATE_KEY or CREDENTIAL;
- `--password`, `--token` and similar flags;
- `Bearer`, `Basic` and `Token` credentials;
- URL user info passwords.

"Preview what is sent" in the settings shows exactly the text for the
focused terminal.

The reply goes through `parseSuggestion`: the first line, with code fences,
backticks and a leading `$` removed. Empty replies, replies over 500
characters, or replies containing control characters give no suggestion.

### Local prediction

Before a model is asked, the engine looks for a likely follow-up to the
pane's last command in the **command log** (`src/terminal/commandLog.ts`):
pairs of (command, the next command run in the same terminal), oldest
first, up to 5000, saved to `command-log.json` in the app data directory.
`runFromBlocks` records a pair whenever this machine's shell runs a command
from the blocks editor; commands at a nested shell's prompt (over ssh) are
not recorded, and no local prediction is made there.

`predictNext` (`predict.ts`) scores every logged pair against the last
command, at three levels:

| Level | Weight | Matches when | Example |
|---|---|---|---|
| exact | 1 | the logged command is the same line | `git add .` → `git commit` |
| template | 0.8 | same program and word count; every word that differs is quoted free text, or an argument (not a flag) the next command reused, as a word or a path prefix | `mkdir foo` → `cd foo` gives `cd bar` after `mkdir bar`; `git commit -m "…"` → `git push` |
| last argument | 0.5 | same program, and the logged command's last argument was reused | `mkdir -p a` → `cd a` gives `cd c` after `mkdir c` |

Reused arguments are substituted (and shell-quoted if needed). A pair of
the same program that teaches nothing still counts against the candidates
at a quarter weight. Each pair's weight halves every 1000 pairs back. The
best candidate is used only with **at least 2 supporting pairs and at
least half of the weighted total**; otherwise the model is asked as below.

A local prediction is shown at once (no pause, focus or provider needed),
counts as this prompt's answer (no request follows), and is labelled
"predicted from history" in the footer. "Suggest now" always asks the
model.

### Engine

The blocks input editor (`BlockInput.tsx`) remounts at every prompt and
reports to the engine:

- `atPrompt(paneId)`: on mount, on focus, and when the editor becomes
  empty. A local prediction (above) answers at once if there is one.
  Otherwise it asks only if all of these hold:
  - AI is configured and the pane's switch is on;
  - the pane is the active one and the window has focus;
  - no backoff is in force;
  - nothing was asked at this prompt yet (`promptKey`: the block count and
    the last block's id).

  The request waits 350 ms and is dropped if the prompt or focus moved.
- `typed(paneId)`: cancels a pending or running request. A ready
  suggestion stays, since it may continue what was typed.
- `leftPrompt(paneId)`: the editor unmounts (a command runs, blocks mode is
  left, the pane closes, or its tab is hidden). Pending work is cancelled;
  an answer or a dismissal is kept, so returning to the tab at the same
  prompt neither asks again nor brings back a dismissed suggestion.
- `paneSwitchedOff(paneId)`: the pane's switch was turned off. Drops
  pending work and the suggestion; `shownSuggestion` also hides anything
  for a pane that is switched off or when AI is not configured.
- `dismiss(paneId)` (Esc): hides the suggestion at this prompt.
- `suggestNow(paneId)` (command): asks at once, whatever the pause, the
  backoff or an earlier answer, but only while the pane shows its blocks
  prompt.

Eligibility is checked again right before the request goes out (after the
context is built): still configured, the pane allowed, at the same visible
prompt and, for automatic requests, still focused and not backed off.

Each pane has at most one request in flight (`ai_cancel` on replacement),
with a reply budget of 120 tokens.

Backoff after errors:
- `network`, `http` and `timeout` errors double from 15 s up to 10 min.
- `noKey`, `auth` and `notFound` stop automatic requests until the AI
  settings change.
- `empty`, `refused` and `cancelled` are not errors.

Any change to `settings.ai` cancels everything and clears the backoff, and
so does saving a key.

State for the UI is `useAiSuggestions[paneId]`: `{ promptKey, status:
loading | ready | none | error, source?: local | ai, text?, error?,
dismissed? }`.

### Blocks input

At an empty prompt the AI suggestion is the ghost text. Once the user
types, the AI suggestion stays only while it continues the typed text;
otherwise the history's suggestion shows. ⇥ or → accepts the suggestion
into the editor, and it is never run. Esc dismisses it.

The footer shows where the suggestion comes from ("AI suggestion",
"predicted from history" for a local prediction, or "from history" for a
prefix match), a pulsing "AI…" while a request runs, or "AI unavailable" with
the error as a tooltip.

### Slash commands

A line in the blocks editor that starts with a **registered** `/name` is
handled by Midterm and never reaches the shell. Anything else starting
with `/` (`/usr/bin/ls`, `/cm`) runs as usual. While the line is a prefix
of a command name, the ghost text shows its usage (`/cmd <what to do>`),
⇥ completes the name, and the footer describes it.

| Command | What it does |
|---|---|
| `/cmd <task>` | Asks the model for a shell command that does the task. |

`/cmd`: on ⏎ the line moves above the editor ("writing a command… esc
cancels"; Esc or ⌃C cancels and puts the line back) and the request goes
out with the same context as a suggestion (`contextFor`), with
`CMD_SYSTEM_PROMPT` and `Task: <task>` (redacted) in place of "Next
command:". The reply budget is 400 tokens, and the reply goes through
`parseSuggestion`. The command lands in the editor, **under the request
line, never run**: edit it or press ⏎. On failure the error shows next to
the line and the line goes back in the editor, so ⏎ tries again. `/cmd`
needs a provider (`providerReady`) but not the suggestions switch. Slash
lines are not added to the history or the command log.

### Commands

- `ai.toggleSuggestions`: AI: Toggle suggestions.
- `ai.suggestNow`: AI: Suggest a command now. Opens the settings if AI is
  not set up.
- `ai.openSettings`: AI: Settings….

### Settings → AI

- A note on what leaves the machine.
- The suggestions toggle and the context size.
- The provider, grouped into APIs and CLIs, with its status (key saved, or
  the CLI found with its path and version).
- The base URL (custom), the key field with Save and Remove (APIs), or the
  executable path (CLIs).
- The model: free text, plus the provider's live list (`ai_models`) with a
  refresh.
- Reasoning effort: Automatic, Provider default, and the levels
  `ai_effort_options` returns for the model. The hint says what is sent when
  a level is clamped, or when nothing is.
- Test (`ai_test`) and "Preview what is sent".

### Self-test

With `aistub=PORT` in the self-test URL, and `bun scripts/ai-stub.ts PORT`
running (a stand-in OpenAI-compatible server), the self-test:

1. runs a command that exports a fake password;
2. checks that nothing is asked while no provider is chosen;
3. points `custom` at the stub and asks;
4. checks that the ghost text shows the stub's answer. The stub only gives
   that answer when the prompt contains the command and not the secret.
5. checks that ⇥ accepts it.
