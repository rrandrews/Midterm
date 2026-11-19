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
providers do too), reasoning effort asked to be **low**, and a generous
`max_tokens`. On current models `max_tokens` covers reasoning as well as the
reply, and too small a limit ends in an empty reply, so the backend sends
`maxTokens` (the reply budget, default 512, clamped to 16–32000) **plus 4096
tokens of headroom** (`output_budget` in `mod.rs`). Timeouts: 10 s to
connect, 60 s in total.

**OpenAI-compatible** (`openai.rs`), `POST {base}/chat/completions`:

```json
{ "model": "…", "messages": [{ "role": "system", "content": "…" }, { "role": "user", "content": "…" }],
  "stream": false, "max_tokens": 4608, "reasoning_effort": "low" }
```

| Provider | Token field | Effort field |
|---|---|---|
| OpenAI | `max_completion_tokens` (its reasoning models reject `max_tokens`) | `reasoning_effort: "low"` |
| DeepSeek | `max_tokens` | `reasoning_effort: "low"` |
| Gemini | `max_tokens` | `reasoning_effort: "low"` |
| OpenRouter | `max_tokens` | `reasoning: { effort: "low", exclude: true }` (its normalized form) |
| custom | `max_tokens` | none (unknown server) |

The system message uses role `system` (OpenAI maps it to `developer` for
its reasoning models). If the provider answers **400 with a body mentioning
"reasoning" or "effort"** (a model without reasoning), the request is sent
once more without the effort field. Auth is `Authorization: Bearer <key>`,
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
version; nothing it changed is used here). No `thinking` field: current
models think adaptively by default (and some reject turning it off), older
ones run without it. A 400 mentioning `effort`/`output_config` (models
without the effort parameter) is retried once without `output_config`. The
reply is the concatenated `text` blocks of `content`. `stop_reason:
"refusal"` is `refused`, with `stop_details.explanation` as the message
when present. No text is `empty`, with a token-limit hint on `stop_reason:
"max_tokens"`.

Models: `GET {base}/models?limit=1000`, following `has_more` / `last_id`
(`after_id`), up to 10 pages.

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
(deleted afterwards), stdout/stderr captured, a 120 s timeout, its own
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
| Claude Code | 2.1.328 | `claude -p --output-format text --tools "" --strict-mcp-config --disable-slash-commands --permission-mode dontAsk --no-session-persistence --effort low [--system-prompt S] [--model M]`, prompt on stdin. `--tools ""` turns off every built-in tool. |
| Codex | codex-cli 0.170.0 | `codex exec --sandbox read-only --skip-git-repo-check --ephemeral --color never -c model_reasoning_effort="low" -C <tmp> -o <tmp>/last-message.txt [-m M] -`, system + prompt on stdin (no system flag). The reply is read from the `-o` file (stdout carries progress). |
| Antigravity | 1.5.12 | `agy --sandbox --disable-slash-commands --output-format text (--model M \| --effort low) -p "<system>\n\n<prompt>"`. `-p` takes the prompt as its value (no stdin form). Model ids carry their effort (`gemini-…-low`), so `--effort low` is passed only without a model. No `--dangerously-skip-permissions`, so tool permissions are not granted. `--mode plan` is not used: it turns the reply into a planning session. |

`agy -p` printed nothing without a TTY in some versions (upstream issue
76); 1.5.12 prints normally with stdout piped, so it is run without a PTY.
If an older version prints nothing, the result is an `empty` error.
Flags for Claude Code and Antigravity were also checked by running them
headless; Codex flags are from `codex exec --help` only.

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
             prompt: string, maxTokens?: number }) -> { text: string }
ai_cancel({ requestId: string }) -> void
ai_models({ provider: ProviderConfig }) -> string[]
ai_test({ provider: ProviderConfig, model: string }) -> { ok: boolean, message: string }
ai_key_set({ provider: ProviderConfig, key: string }) -> void
ai_key_delete({ provider: ProviderConfig }) -> void
ai_key_status({ provider: ProviderConfig }) -> boolean
ai_cli_status({ provider: ProviderConfig }) -> { found: boolean, path?: string, version?: string }
```

- `ai_suggest`: `model` is required for HTTP providers and optional for CLIs
  (empty = the CLI's default). `maxTokens` is the reply budget; headroom for
  reasoning is added.
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
| `timeout` | 60 s for HTTP, 120 s for a CLI run. |
| `cancelled` | `ai_cancel` was called. |
| `notFound` | A CLI's executable was not found (or `cliPath` is not executable). |
| `other` | Everything else: no model chosen, bad base URL, keychain failure, unexpected response, CLI failure. A redirect (3xx) comes back as `http`. |

### Tests

`cargo test ai::` in `src-tauri/`. Adapters run against `stub.rs` (a
hand-rolled HTTP server on `127.0.0.1:0` serving canned responses and
recording requests): success, request shape (no sampling fields, effort
fields, headers), retry without effort, refusal, empty, 401/5xx, unreachable
server, model listing and pagination, cancel mid-request, a cancel or
replacement landing after the result is ready, redaction before
truncation, keychain accounts (`custom` bound to its URL), and keyless
`custom` surviving a failed key lookup. The credential store itself is not
exercised by tests. CLI tests use
fake executables (flags, empty working directory, stdin) and check that
cancel kills the process group. Pure helpers (PATH markers, merge, lookup,
argument builders, response parsing, ANSI stripping) have unit tests.
`cargo test live_clis -- --ignored --nocapture` runs the CLIs installed on
the machine (spends a little quota).

## Frontend

Code: `src/ai/` and `src/ipc/ai.ts`. Installed by `installAi()` from
`main.tsx`.

| File | What |
|---|---|
| `src/ipc/ai.ts` | Typed wrappers for the `ai_*` commands; `PROVIDERS` (names, API or CLI, key needed); `toAiError`. In a plain browser a mock answers: keys in memory, a canned suggestion after 600 ms, cancellable. |
| `context.ts` | Pure: `buildContext` (system prompt and prompt), `redact`, `trimOutput`, `parseSuggestion`. Unit-tested in `context.test.ts`. |
| `engine.ts` | The suggestion engine, per pane and outside React; `contextFor(paneId)`; `aiConfigured`, `providerConfig`. |
| `AiSection.tsx` | Settings → AI. |
| `commands.ts` | Commands, the terminal menu's per-pane switch, registration. |

### Settings

`settings.ai` (`src/settings/schema.ts`):

| Field | Meaning |
|---|---|
| `suggestions` | On by default, but inert until a provider is chosen (and a model, for APIs; a base URL for `custom`). |
| `provider` | A provider id, or empty for none. |
| `model` | The model id. Empty means the CLI's default, for CLI providers only. |
| `baseUrl` | For `custom`. |
| `cliPaths` | Executable overrides, by provider id. |
| `contextBlocks` | Finished blocks sent as context (0–20, default 5). |

A pane's own switch is `aiSuggestions: false` in the terminal pane's data
(terminal menu → "AI suggestions in this pane", shown in blocks mode once AI
is set up).

Keys never pass through the settings. The key field is write-only: Save
sends it to `ai_key_set`, and the UI only ever learns `ai_key_status`. A
`custom` key is kept per base URL.

### Context

`contextFor(paneId)` collects:

- the OS and shell (the foreground program while at the prompt);
- the working directory, with home shown as `~`;
- the git branch;
- the last `contextBlocks` finished blocks: the command, its directory if
  different, its output (`blockOutput`), and the exit status;
- up to 20 earlier commands from the pane and the global history.

`buildContext` then trims each output to its first 15 and last 25 lines
(240 characters per line, 3000 per block), strips escape sequences, and
redacts the whole prompt. `redact` replaces:

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

### Engine

The blocks input editor (`BlockInput.tsx`) remounts at every prompt and
reports to the engine:

- `atPrompt(paneId)`: on mount, on focus, and when the editor becomes
  empty. It asks only if all of these hold:
  - AI is configured and the pane's switch is on;
  - the pane is the active one and the window has focus;
  - no backoff is in force;
  - nothing was asked at this prompt yet (`promptKey`: the block count and
    the last block's id).

  The request waits 350 ms and is dropped if the prompt or focus moved.
- `typed(paneId)`: cancels a pending or running request. A ready
  suggestion stays, since it may continue what was typed.
- `leftPrompt(paneId)`: a command runs, the pane closes, or blocks mode is
  left. Cancels and forgets.
- `dismiss(paneId)` (Esc): hides the suggestion at this prompt.
- `suggestNow(paneId)` (command): asks at once, whatever the pause, the
  backoff or an earlier answer.

Each pane has at most one request in flight (`ai_cancel` on replacement),
with a reply budget of 120 tokens.

Backoff after errors:
- `network`, `http` and `timeout` errors double from 15 s up to 10 min.
- `noKey`, `auth` and `notFound` stop automatic requests until the AI
  settings change.
- `empty`, `refused` and `cancelled` are not errors.

Any change to `settings.ai` cancels everything and clears the backoff.

State for the UI is `useAiSuggestions[paneId]`: `{ promptKey, status:
loading | ready | none | error, text?, error?, dismissed? }`.

### Blocks input

At an empty prompt the AI suggestion is the ghost text. Once the user
types, the AI suggestion stays only while it continues the typed text;
otherwise the history's suggestion shows. ⇥ or → accepts the suggestion
into the editor, and it is never run. Esc dismisses it.

The footer shows where the suggestion comes from ("AI suggestion" or "from
history"), a pulsing "AI…" while a request runs, or "AI unavailable" with
the error as a tooltip.

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
