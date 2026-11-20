# AI providers

Next-command suggestions in blocks mode, `/cmd`, Explain and fix, and the
agent ([Agent](#agent)) come from a model the user picks: an HTTP API (with a key) or a coding CLI they already have
installed. Models are saved as **model profiles** (provider, model, effort,
extra request JSON, under a name), and each feature uses the default profile
or one of its own (see [Settings](#settings)). The
webview never talks to a provider and never sees a key. It calls the `ai_*`
commands, and the Rust backend (`src-tauri/src/ai/`) makes the request or
runs the CLI. The webview's CSP stays "nothing remote"
([architecture.md](architecture.md#content-security-policy)).

## Backend

### Source map (`src-tauri/src/ai/`)

| File | What lives there |
|---|---|
| `mod.rs` | `AiManager` (Tauri state): `prepare` (key, base URL, capabilities, effort, budget), `complete` and `stream` dispatching by provider, the `max_tokens` budget, cancellation registry, lazy HTTP client. |
| `commands.rs` | The Tauri commands below. Thin. |
| `extra.rs` | Extra request JSON: protected keys, size check, the JSON Merge Patch into a request body. |
| `effort.rs` | Reasoning effort: levels offered per provider and model, Midterm's pick, clamping, token headroom, timeout scaling. |
| `provider.rs` | `ProviderId`, `ProviderConfig`, `Target` (what a request goes to), default base URLs, which backend each provider uses. |
| `openai.rs` | OpenAI-compatible chat completions adapter: `complete`, `stream` and its accumulator `ChatStream` (with `ThinkFilter`). |
| `anthropic.rs` | Anthropic Messages adapter (raw HTTP): `complete`, `stream` and its accumulator `MessageStream`. |
| `http.rs` | Shared HTTP: client, `open` (status checked) + `json` (`send` is both), the effort retry, stream timeouts and chunk reads, HTTP-status → error mapping, error-body parsing. |
| `sse.rs` | A byte-level Server-Sent Events parser (`SseParser::push`/`finish`). |
| `stream.rs` | What the streaming adapters share: `Stop` (`end`, `length`, `tools`), `Streamed`, the `StreamState` accumulator trait, `Text` (leading whitespace, trimming), and the read loop (`read`/`read_with`: one delta per network chunk). |
| `agent.rs` | Agent turns (`ai_agent_turn`): the wire types, both adapters' request bodies with tools and the history (assistant turns spliced in verbatim as `RawValue`), strict tool-input parsing, and the turn read loop. The adapters' accumulators (`ChatStream`, `MessageStream`) gather tool calls and the native assistant message (`finish_turn`). |
| `cli.rs` | CLI providers: locating, status (`CliStatus`, with `agent` for ACP-capable CLIs), argument builders, running. |
| `shell_path.rs` | The login shell's PATH (marker extraction, merge, executable lookup). |
| `process.rs` | Child process with stdin, timeout, and process-group kill on drop; `LongChild` (piped stdio, long-lived, shut down or killed with its group) and `GroupHandle` (kills that group from another thread) for ACP adapters. |
| `keys.rs` | Keys in the OS credential store (`keyring`). |
| `error.rs` | `AiError { kind, message }`. |
| `acp/mod.rs` | `AcpManager` (in `AiManager.acp`): live ACP sessions by conversation id, the 8-session cap, `prompt` / `tool_result` / `close` / `close_owned_by` / `close_all`, adapter launch (`launch`), `AcpEvent`, `Stop`. |
| `acp/session.rs` | One session over a transport: `initialize`, `session/new`, config options, then prompts, cancels and close; timeouts (`Timing`), the permission policy, session updates → events, error mapping; `run_process` runs it over an adapter's stdio. |
| `acp/tools.rs` | Midterm's tools served as the MCP server `midterm` over the ACP connection; `Shared` (running turn, pending calls, idle clock). |
| `acp/agents.rs` | Per-agent recipe (`AgentSpec`, only `CLAUDE_CODE`): adapter, version bounds, env, `session/new` `_meta`, config option picks, prompt escaping, the status checks behind `ai_cli_status.agent`. |
| `acp/tests.rs` | Tests with an in-process fake agent and fake adapter scripts; the ignored `live_acp`. |
| `stub.rs` | Tests only: a stub HTTP server on 127.0.0.1 (JSON answers, or SSE frames with gaps). |

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

### Models

`ai_models` returns the provider's live list, sorted and deduplicated, with
a `models/` prefix (Gemini's native form) stripped. For every
OpenAI-compatible provider it keeps **text → text models only**
(`openai::parse_models`), per entry of `data[]`:

1. If `architecture.output_modalities` is an array (OpenRouter): kept only
   if it is exactly `["text"]` and `architecture.input_modalities` (when
   present) contains `"text"`.
2. Else if `architecture.modality` is a string `"in->out"`: kept only if
   `out` is `text` and `in` contains `text`.
3. Else by id (`is_text_model`): lowercased; dropped if it contains
   `dall-e` or `stable-diffusion`, or if any segment (split on every
   character outside `[a-z0-9]`) is one of `tts stt asr speech whisper
   transcribe transcription audio realtime live image images imagen video
   sora veo lyria embedding embeddings embed rerank reranker moderation
   aqa`.

`vision`, `instruct`, `search` and `computer-use` models stay (their
output is text). Anthropic's list and `agy models` are not filtered. Any id
can still be typed in Settings.

### Extra request JSON

A profile of an API provider can carry a JSON object (`Target.extra`) that
`extra.rs` merges into the request body as a **JSON Merge Patch (RFC
7386)**, after the adapter built it (`openai::build_body`,
`anthropic::build_body`): objects merge recursively, `null` removes a key,
anything else replaces. The user's values win, so it can add provider
options (`provider` routing on OpenRouter, `metadata`, …) or override
Midterm's own fields (`max_tokens`, the effort field).

- **Protected keys** are rejected: `model`, `messages`, `system`, `stream`,
  `tools`, `tool_choice`, `functions`, `function_call`, `n` (one list for
  both adapters, `extra::PROTECTED`, mirrored as `PROTECTED_EXTRA_KEYS` in
  `ipc/ai.ts`). Only top-level keys are checked.
- At most 16 KB serialized.
- `extra::check` runs in `AiManager::complete` before the key lookup and
  fails with `other` ("extra request JSON cannot set `model`"). CLI
  backends ignore `extra`, and `ai_effort_options` ignores it.
- It is applied on both attempts of the retry without effort. A rejected
  effort level is **not** remembered (`Rejections`) when `extra` sets
  `reasoning_effort`, `reasoning`, `thinking` or `output_config`: the
  rejection may be about the user's field.
- It cannot change the URL or headers, so a key still only goes to its
  provider.

Sampling parameters set this way are rejected by current Anthropic models;
the editor's hint says so.

### Request shapes

Common to every HTTP request: one call (non-streaming for `ai_suggest` and
`ai_test`, streaming for `ai_stream`; see [Streaming](#streaming)), a system prompt and
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
and max. A streamed request instead gets that (scaled) time for the headers
and for each chunk, and 600 s in total.

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

### Requests with tools (agent turns)

`ai_agent_turn` sends one streamed request per model turn with the
conversation so far. Everything else (token field, effort fields, retry
without effort, extra JSON, timeouts) is as for `ai_stream`; `tools` is
left out when the list is empty, and there is never a `tool_choice` field
(automatic; current Claude models reject forced tool use) or
`eager_input_streaming`.

- **OpenAI-compatible**: `messages` = the system message, then per history
  entry `{ role: "user", content }`, the assistant turn's `raw` spliced in
  verbatim, and one `{ role: "tool", tool_call_id, content }` per tool
  result (`isError` is not sent: the content is already an `{"error": …}`
  object); `tools: [{ type: "function", function: { name, description,
  parameters } }]`.
- **Anthropic**: `system` as usual; user text as `{ role: "user", content:
  [{ type: "text", text }] }`; `raw` spliced in; **all results of a round in
  one user message** of `{ type: "tool_result", tool_use_id, content,
  is_error: true? }` blocks (an empty round is skipped); `tools: [{ name,
  description, input_schema }]`.
- `raw` must be a JSON object and is spliced as a `serde_json::RawValue`, so
  it is never re-encoded: thinking blocks and signatures, DeepSeek
  `reasoning_content` and Gemini per-call extras go back byte for byte.
  The rest of the body is merged with extra JSON first (`messages`, `tools`
  and `system` are protected) and serialized with `messages` last.

Reading the stream (the Phase 2 accumulators, extended):

- **OpenAI**: `delta.tool_calls[]` by `index` (`id` and `function.name`
  once, `function.arguments` concatenated; a call without an id gets
  `call_<n>`). Unknown fields of the message delta and of each call (and its
  `function`) are kept for `raw`: strings concatenated, arrays extended,
  objects merged, other values last-wins. `raw` = `{ role: "assistant",
  content: <as received, a <think> block included, or null>, tool_calls?,
  …unknown }`; a JSON (non-streamed) answer's `raw` is `choices[0].message`
  as received. `stop` is `length` when `finish_reason` is `length` (even
  with calls, so a cut-off call is not run), else `tools` whenever there is
  a call, whatever `finish_reason` says.
- **Anthropic**: the whole `content` array is rebuilt in order from
  `content_block_start`/`_delta`/`_stop`: `text` (whitespace-only text
  blocks dropped: the API rejects them on replay), `thinking` with its
  `signature_delta`, `redacted_thinking` as received, `tool_use` with its
  input from the `input_json_delta` fragments, unknown blocks as received.
  `raw` = `{ role: "assistant", content: [...] }`. `stop_reason:
  "max_tokens"` → `length` (even with tool uses, so a cut-off call is not
  run), else any `tool_use` → `tools`, else `end`.
- Tool input is parsed strictly; empty arguments are `{}`. Anything that is
  not a JSON object gives `input: null` and `invalid` with the raw text
  (Anthropic's `raw` then carries `{}` as that block's input, so the history
  stays valid).
- Events: `text` (one per network chunk, through the request's `Gate` like
  `ai_stream`'s deltas) and `toolCall` (once a call's id and name are known;
  Anthropic at `content_block_start`). `text` in the result is trimmed, a
  leading `<think>` block removed. No text and no calls is `empty`; refusal
  and content filter are `refused` (that turn's tools are never run). A CLI
  target rejects with `other`: "The agent needs an API model. Choose another
  model for Agent in Settings → AI."

### Streaming

`ai_stream` asks the same request with `"stream": true` and reads the reply
as Server-Sent Events. No SSE or stream crates: `reqwest::Response::chunk()`
and `sse.rs` (lines split on `\n`/`\r\n` at the byte level before
decoding, multi-line `data:` joined with `\n`, `:` comments skipped, an
event without a closing blank line still counts at the end).

- **Before any byte streams**, `http::open` checks the status and reads a
  non-2xx body, so the retry without effort and the error mapping are the
  same as for `complete`. Nothing from the rejected attempt is emitted.
- **Deltas**: one per network chunk (the text of all its events together),
  not per token. Leading whitespace before the first text is dropped; the
  final text is trimmed. The command's result carries the full text and is
  **authoritative**: Channel messages and the invoke response are not
  ordered against each other.
- **Readers are accumulators** (`StreamState::event` per SSE event,
  `take_text` per chunk, then the adapter's `finish`), so tool calls can be
  added to the state later without touching the loop.
- **OpenAI-compatible**: text from `choices[0].delta.content` (a string or
  text parts); `data: [DONE]` ends it (reading stops there). Chunks with
  empty `choices` are fine; `reasoning_content`/`reasoning` are ignored.
  `ThinkFilter` holds text back while it could still be a leading
  `<think>` block and swallows the block. `delta.refusal` (accumulated) or
  `finish_reason: "content_filter"` → `refused`; a chunk with `error` →
  `http` (message redacted, then truncated); `finish_reason: "length"` →
  `stop: "length"` with text, `empty` with the token-limit hint without.
  A response that is not `text/event-stream` (a server that ignores
  `stream`) is read whole (each chunk within the idle timeout), parsed like
  a non-streaming reply, emitted as one delta, and keeps its `length` stop.
  The reply is complete once a finish reason or `[DONE]` arrived.
- **Anthropic**: `content_block_delta` with `text_delta` → text, across
  blocks; `thinking_delta`, `signature_delta`, `ping` and unknown events
  are ignored; `message_stop` ends it. `message_delta.delta.stop_reason`:
  `refusal` → `refused` (with `stop_details.explanation`), `max_tokens` → as
  `length` above. `event: error` → `http` with `error.message`. The reply
  is complete once a stop reason or `message_stop` arrived.
- **Cut short**: a body that ends cleanly before the reply was complete is
  `network` ("the connection closed before the reply was complete"), not a
  partial success.
- **CLIs**: the whole reply as one delta at the end (incremental Claude Code
  output is a follow-up).
- **Timeouts**: the effort-scaled request timeout (60/120/180 s) limits the
  wait for the headers and for each chunk; 600 s caps the whole stream.
  Either expiry is `timeout`.
- **Cancel**: `ai_cancel(requestId)` drops the stream. Each delta is sent
  through the request's `Gate`, which cancel (or a replacement) closes under
  the gate's lock, so no delta is sent once `ai_cancel` has returned.

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

### ACP sessions

Why: a CLI runs its own tool loop and, run headless (`-p`), cannot call the
webview's skills. Over the **Agent Client Protocol** (ACP) the CLI stays the
agent and Midterm supplies the system prompt, its tools and the
confirmations. `acp/` runs one long-lived session per agent conversation
(`ai_acp_prompt`); the one-shot CLI runs above are unchanged. Built on the
`agent-client-protocol` crate (5.4, `unstable_mcp_over_acp`); the adapter is
a separate program per CLI that speaks ACP on stdio. **Claude Code only**
(adapter `claude-agent-acp`); Codex (MID-90) and Antigravity (MID-81) are not
supported yet (`agents::spec` has no entry: the prompt fails with "The agent
doesn't support Codex yet. Choose a Claude Code or API model for Agent in
Settings → AI.").

Adding that crate turned on serde_json's `preserve_order` for the whole
backend: `serde_json::Map` keeps insertion order everywhere, so JSON the
backend builds or re-serializes keeps its key order (`Cargo.toml` notes it).

**The Claude Code recipe** (`agents.rs`, `session.rs`), verified live in the
MID-82 spike:

- **Process**: the adapter (`claude-agent-acp`, no arguments) in its own
  process group, working directory a fresh empty temporary directory
  `midterm-agent-*` (canonical path; deleted when the session ends). Env:
  the resolved PATH, `NO_COLOR=1`, `CLAUDE_CODE_EXECUTABLE` = the resolved
  `claude` (so `cliPath` applies), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`;
  removed: `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` (Claude Code refuses to
  start inside another session) and `CLAUDE_CODE_EFFORT_LEVEL` (it would
  outrank the effort option). Nothing is installed or fetched (no `npx`).
- **Handshake**: `initialize` (no client capabilities: no file system or
  terminal access for the agent). An adapter that does not advertise
  MCP-over-ACP is refused with the update command.
- **`session/new`**: `cwd` as above; the system prompt as `systemPrompt`
  with mode `override` when the adapter offers it (`append` when it only
  offers a system prompt; with neither, it is put in front of the first
  prompt text), so Claude Code's own prompt is not used; and
  `_meta.claudeCode.options`: `tools: []` (no built-in tools),
  `settingSources: []` (no settings, CLAUDE.md, skills, hooks),
  `persistSession: false`, `strictMcpConfig: true`,
  `allowDangerouslySkipPermissions: false`, `mcpServersDelivery:
  "initialize"` (the MCP config stays off the CLI's argv) and `allowedTools`
  = `mcp__midterm__<name>` for each of Midterm's tools. These win over the
  adapter's defaults.
- **MCP-over-ACP**: Midterm's tools are served to the agent as the MCP
  server `midterm` over the same connection (`tools.rs`, hand-written
  against the SDK's `McpService`: MCP revision 2026-07-28, stateless;
  `server/discover`, `tools/list`, `ping`, `tools/call`; the tool list is
  the frozen toolset's wire names, with `ttlMs: 0`). A `tools/call` is not
  run in Rust: it becomes a `toolCall` event (`callId` = the agent's tool
  use id when given, else `call-<n>`; `name` without the `mcp__midterm__`
  prefix) and waits for `ai_acp_tool_result`. If the prompt is cancelled
  meanwhile, the call is answered with an error ("The user stopped this
  request; the tool was not run.") and a later result is ignored.
- **Config options** (`session/set_config_option`, after `session/new`):
  `mode` = `default`; `model` = the profile's model matched against the
  option's values (exactly, then ignoring case; aliases such as `sonnet`
  are values; empty keeps the agent's default; an unlisted model fails with
  the list it offers); `thought_level` = the profile's effort, resolved as
  for the one-shot CLI (Midterm's pick: low; `default`: not set) and clamped
  to the levels offered.
- **Prompts**: the text of a message that starts with `/` is sent with a
  leading space (Claude Code would run it as a slash command; `" /context"`
  reaches the model as text).

**Permissions.** The agent asks `session/request_permission` before a
tool. For Midterm's tools (the SDK name `mcp__midterm__…`) Midterm answers
`allow_once` at once: the real confirmation happens in the webview inside
the tool call (Allow / Allow for this conversation / Deny). Any other tool
gets a reject option (`reject_once`, else `reject_always`) and shows as a
denied foreign row; an "always" option is never chosen. With no fitting
option, or during a cancel, the answer is `cancelled`. Other agent
requests get method-not-found; the client has no capabilities.

**Lifecycle.** One adapter process per conversation, started by its first
prompt (`system` and `tools` are only used then), kept for the later ones.

- At most **8** sessions: opening a ninth closes the idle one used longest
  ago; if all eight are answering, the new prompt fails ("8 agent sessions
  are already answering; try again when one finishes").
- A session ends on `ai_acp_close` (the conversation was dropped; waits up to
  6 s, then kills the group), when its window's page loads or the window is
  destroyed (`close_owned_by`, the window label owns it), at app exit
  (`close_all` kills every group and removes the directories), or when the
  process dies. The process's whole group is killed when its task is
  dropped. A dead or closed session is forgotten: the conversation's next
  prompt starts a fresh one.
- If the caller of `ai_acp_prompt` goes away or `ai_cancel` arrives, the
  turn is cancelled (`session/cancel`); a prompt for a session that is
  still answering fails.

**Timeouts** (`session::Timing`): **30 s** from spawn to the config
options set (`timeout`: "<adapter> did not start within 30 s"). An **idle
watchdog**: a prompt fails with `timeout` when the agent sends nothing for
180 s (scaled with effort like HTTP: ×2 high, ×3 xhigh and max), and the
clock is **paused while a tool call waits for the webview** (a confirmation
can take as long as the user needs). After a cancel the agent has **5 s** to
settle the prompt, else the session is killed and the prompt ends
`cancelled`. Closing: `session/close` 2 s, then the process's own exit 2 s
before the group is killed.

**Errors.** Stop reasons map `max_tokens` → `length`, `refusal` →
`refused`, `max_turn_requests` → `maxRequests`, `cancelled` → `cancelled`,
anything else `end` (a prompt cancelled by the user always ends
`cancelled`). An agent error answer is `auth` when it is ACP's
auth-required code (with "Sign in by running `claude` in a terminal."), else
`other` "the agent failed: <message>" (message and data, 400 characters). A
process that died is reported from the tail of its stderr through the same
mapping as CLI failures (the adapter's own `[session/…]` and `[authStatus]`
log lines left out; `auth` gets the sign-in hint). A missing adapter is
`notFound` with its install command; a missing `claude` as for any CLI.

**Adapter discovery and checks** (`ai_cli_status().agent`, no session
started, only `--version` calls). The adapter is found like a CLI (login
shell PATH, `locate_named`); `ProviderConfig.acpPath` overrides it (same
forms as `cliPath`; **no Settings field sets it yet**). Install with
`npm install -g @agentclientprotocol/claude-agent-acp`. Checks, in the order
a user would fix them; the first failure is `problem` and `ready` is false:

| Check | Requirement |
|---|---|
| Adapter | on PATH, and `--version` parses |
| Adapter version | `claude-agent-acp` **0.108.0 or later** (what the recipe needs). Newer than the tested **0.109.x** (a higher minor): still ready, with a `note` ("report problems") |
| Node.js | `node` on PATH, major **22 or later** (what the adapter runs on) |
| Claude Code | `claude` found, version **2.1.326 or later** (the first with `mcpServersDelivery: "initialize"`) |

Versions checked: `claude-agent-acp` 0.109.0 with Claude Code 2.1.329.

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

Builds with the `tauri-mcp` cargo feature (`bun run dev:mcp`) keep keys in a
process-wide in-memory map instead, with the same set/delete/status
semantics, so the agent-driven instance never touches the developer's
Keychain; keys are gone when it exits. `MIDTERM_KEYSTORE=os` opts back into
the OS store, `MIDTERM_KEYSTORE=memory` forces memory in any build
(`keys::select_store`). The chosen store is logged once at startup
(`ai keys: using the Memory store`).

OS store reads are cached for the life of the app, so the OS asks at most
once per account per launch, not once per request. Every OS store call
holds one lock together with its cache update (a cold read cannot overwrite
a newer save, and concurrent cold reads ask once). Errors are not cached; a
failed save or delete drops the account from the cache so it is read again.
A change made to the item outside the app shows up after a restart.

**Key file for debug builds.** A `tauri dev` binary is ad-hoc signed with
no Team ID, so the Keychain item's partition list ties it to the hash of
one build, and every rebuild asks for the login password, even with the
item set to "Allow all applications". `MIDTERM_KEYSTORE=file` (builds with
debug assertions, i.e. `tauri dev`, on Unix only; release and `tauri-mcp` builds ignore it, so a variable
exported in your shell never gives an agent's `dev:mcp` instance your keys) keeps keys in a JSON file instead:
`MIDTERM_KEYS_FILE`, or `~/.config/midterm-dev/keys.json`, an object of
account → key. Every access holds an exclusive `flock` on `keys.json.lock`
beside it, so two app instances cannot lose each other's saves. The
directory is created 700 and must be the user's and not writable by others.
The file is opened without following symlinks and checked through the open
handle (a regular file, owned by the user, no group or other bits: else
"run chmod 600"); it is replaced atomically from a `tempfile` created
exclusively with mode 600 in the same directory. A missing or empty file is
an empty store; malformed JSON is an error, so a write never overwrites it. Keys in the Keychain are not
copied over; save them again in Settings → AI.

### Commands

Arguments are camelCase on the wire (Tauri's default); results are
camelCase.

```ts
type ProviderId = "openai" | "anthropic" | "deepseek" | "openrouter" | "gemini" | "custom"
               | "claude-code" | "codex" | "antigravity";
type ProviderConfig = { id: ProviderId; baseUrl?: string; cliPath?: string;
                        acpPath?: string };   // the backend takes acpPath; the webview type does not carry it yet
// What a request goes to: a model profile resolved for a feature (Rust `Target`).
type AiTarget = { provider: ProviderConfig; model: string; effort?: EffortLevel;
                  extra?: Record<string, unknown> };

ai_suggest({ requestId: string, target: AiTarget, system: string, prompt: string,
             maxTokens?: number }) -> { text: string }
ai_stream({ requestId: string, target: AiTarget, system: string, prompt: string,
            maxTokens?: number, onEvent: Channel<{ type: "delta", text: string }> })
    -> { text: string, stop: "end" | "length", effortDropped: boolean }
ai_agent_turn({ requestId: string, target: AiTarget, system: string, tools: ToolDef[],
                messages: AgentMessage[], maxTokens?: number, onEvent: Channel<AgentEvent> })
    -> AgentTurn                                            // see Agent
ai_acp_prompt({ requestId: string, conversationId: string, target: AiTarget, system: string,
                tools: ToolDef[], text: string, onEvent: Channel<AcpEvent> })
    -> { stop: "end" | "length" | "refused" | "maxRequests" | "cancelled" }   // see ACP sessions
ai_acp_tool_result({ conversationId: string, callId: string, content: string,
                     isError: boolean }) -> void
ai_acp_close({ conversationId: string }) -> void
ai_cancel({ requestId: string }) -> void
ai_models({ provider: ProviderConfig }) -> string[]         // text -> text only (see Models)
ai_test({ target: AiTarget }) -> { ok: boolean, message: string }
ai_effort_options({ target: AiTarget })                      // extra ignored
    -> { levels: Effort[], effective: Effort | null, note: string | null }
ai_key_set({ provider: ProviderConfig, key: string }) -> void
ai_key_delete({ provider: ProviderConfig }) -> void
ai_key_status({ provider: ProviderConfig }) -> boolean
ai_cli_status({ provider: ProviderConfig })
    -> { found: boolean, path?: string, version?: string, outdated?: string, agent?: AgentStatus }
type AgentStatus = { ready: boolean, adapter?: { path: string, version: string },
                     problem?: string, note?: string };   // Claude Code only
```

- `ai_suggest`: `target.model` is required for HTTP providers and optional
  for CLIs (empty = the CLI's default). `maxTokens` is the reply budget;
  headroom for reasoning is added. `target.effort` is the profile's setting
  (absent: Midterm's pick). `target.extra` is merged into the body (see
  [Extra request JSON](#extra-request-json)).
- `ai_stream`: `ai_suggest` streamed (see [Streaming](#streaming)). Reply
  text arrives on `onEvent` as `delta`s; the result's `text` is the whole
  reply and wins over the deltas. `stop` is `length` when the token limit
  cut the reply short. Errors and cancellation as for `ai_suggest`.
  `ai_suggest` and `ai_test` stay non-streaming (one-line replies, and
  `stream: false` is the most compatible path for odd servers).
- `ai_agent_turn`: one model turn of an agent conversation (see
  [Requests with tools](#requests-with-tools-agent-turns) and
  [Agent](#agent)). Errors, `ai_cancel` and the gate as for `ai_stream`.
- `ai_acp_prompt`: one user message in the conversation's ACP session, which
  the first prompt starts (`system` and `tools` are only used then; see
  [ACP sessions](#acp-sessions)). `onEvent` gets `text` (reply text),
  `toolCall` (`callId`, `name`, `input`: run it and answer with
  `ai_acp_tool_result`) and `foreignTool` (`id`, `title`, `status` running,
  done, failed or denied: a tool the CLI ran itself). The result is the stop
  reason. `target` must be a CLI profile the agent supports; an API target
  rejects with `other`, an unsupported CLI with the not-supported message.
  Errors, `ai_cancel(requestId)` and the gate as for `ai_stream`: a cancel
  ends the turn with `cancelled` and later events are dropped.
- `ai_acp_tool_result`: the answer to a `toolCall` (`content` is what the
  model sees; `isError`). Results for unknown, finished or cancelled calls
  are ignored.
- `ai_acp_close`: ends the conversation's session and its process (waits up
  to 6 s); no session: nothing happens. The webview calls it when a
  conversation is dropped.
- `ai_cancel`: aborts the HTTP request or kills the CLI; the pending
  `ai_suggest`, `ai_stream`, `ai_agent_turn` or `ai_acp_prompt` rejects with `cancelled`. A cancel that arrives before its
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
- `ai_models`: the provider's live list, filtered to text models for
  OpenAI-compatible providers (see [Models](#models)); `[]` for Claude Code
  and Codex. Needs a key (except `custom`).
- `ai_test`: a tiny request ("Reply with OK", 16 reply tokens) to the
  target, extra JSON included (Settings sends the unsaved draft). Never
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
  `--version`. For Claude Code `agent` says whether the agent can run over
  ACP (the adapter, Node.js and `claude` checks of
  [ACP sessions](#acp-sessions)); it is absent for Codex and Antigravity.

### Errors

Every command rejects with `{ kind, message }`:

| `kind` | When |
|---|---|
| `noKey` | No key stored for a provider that needs one. |
| `auth` | HTTP 401/403, or a CLI that exited with a login/API-key message. |
| `network` | No HTTP answer (DNS, connection refused, TLS), or a stream that closed before the reply was complete. |
| `http` | Any other non-2xx status; the message has the status and the provider's error message. Also an error reported inside a stream. |
| `refused` | Anthropic `stop_reason: "refusal"`, OpenAI `message.refusal`, `finish_reason: "content_filter"`. |
| `empty` | The model returned no text (with a hint when the token limit was hit). |
| `timeout` | 60 s for HTTP, 120 s for a CLI run (×2 at high or "Provider default", ×3 at xhigh or max). A stream: that long without headers or a chunk, or 600 s in all. |
| `cancelled` | `ai_cancel` was called. |
| `notFound` | A CLI's executable was not found (or `cliPath` is not executable). |
| `other` | Everything else: no model chosen, bad base URL, keychain failure, unexpected response, CLI failure. A redirect (3xx) comes back as `http`. |

### Tests

`cargo test ai::` in `src-tauri/`. Adapters run against `stub.rs` (a
hand-rolled HTTP server on `127.0.0.1:0` serving canned responses and
recording requests): success, request shape (no sampling fields, effort
fields per level, Anthropic adaptive and budget shapes), retry without effort
(400 and 422) and its memo per level (not memoized when extra JSON sets a
reasoning field), extra JSON (merge patch, protected keys, size, body shapes
for both adapters, kept on the retry, checked before the key lookup),
`Target` deserialization, the text-model filter (ids and OpenRouter
modalities), Anthropic capabilities parsing and
the budget invariant, refusal, empty, 401/5xx, unreachable
server, model listing and pagination, cancel mid-request, a cancel or
replacement landing after the result is ready, redaction before
truncation, keychain accounts (`custom` bound to its URL), and keyless
`custom` surviving a failed key lookup. Streaming: the SSE parser (a
fixture split at every byte offset, CRLF, comments, multi-line data, no
final blank line), both adapters' accumulators (concatenation, `[DONE]`, a
think block split across deltas, refusal, content filter, length with and
without text, empty, error chunks and events, thinking and pings ignored,
several text blocks), the JSON fallback, retry without effort before the
stream (no delta from the first attempt, level memoized), 401 before the
stream, a stream cut short (`network`), the JSON
fallback's `length` stop, cancel mid-stream (no later delta) and the gate
closing on cancel and replacement, a stalled stream and stalled headers
(`timeout`), and extra JSON that tries to set `stream`. Socket tests compare
the joined deltas (TCP may merge writes); exact per-chunk grouping is tested
on the accumulators. Agent turns (`agent.rs`): tool definitions and
message translation for both adapters (one Anthropic user message for a
round's results, one OpenAI tool message each, tools left out when empty,
no `tool_choice`), `raw` spliced byte for byte, extra JSON merged around it
and unable to set `tools`, invalid `raw` rejected, strict input parsing, an
OpenAI stream with two interleaved calls and unknown fields kept, the JSON
fallback, an Anthropic stream with text, thinking + signature, redacted
thinking and two `tool_use` blocks in order, invalid arguments flagged, stop
mapping, refusal, error chunks, a stream cut short, CLI targets rejected,
and cancel mid-turn (no event after it). The credential store itself is not
exercised by tests. CLI tests use
fake executables (flags, empty working directory, stdin) and check that
cancel kills the process group. Pure helpers (PATH markers, merge, lookup,
argument builders, response parsing, ANSI stripping, effort levels,
clamping, headroom) have unit tests.
`cargo test live_clis -- --ignored --nocapture` runs the CLIs installed on
the machine at low and medium effort (spends a little quota).

ACP (`acp/tests.rs`, `cargo test ai::acp`): an in-process fake agent over a
duplex transport drives `session.rs` (handshake and `session/new` shape,
config options and picks, an unknown model, an adapter without MCP-over-ACP,
stop reasons, updates → events, the permission policy, the leading-slash
escape, version and Node.js judgments, death messages without adapter log
lines, an MCP round trip with permissions, cancel answering pending calls
and stopping events, the agent dying mid-turn, the idle watchdog pausing
for tool calls, the startup timeout). Fake adapter scripts exercise
`AcpManager` end to end: a session and `close` killing its process group,
window close and app exit killing groups, closing during startup, a dying
adapter's stderr, unsupported CLIs and a missing adapter.
`MIDTERM_ACP_ADAPTER=<path> cargo test live_acp -- --ignored --nocapture`
runs the real adapter and Claude Code (haiku, low effort) through a tool
call (`MIDTERM_ACP_ADAPTER` unset: `claude-agent-acp` on the login shell's
PATH; spends a little quota). Frontend: `agent/acp.test.ts` runs
`runAcpTurn` with fakes (below).

## Frontend

Code: `src/ai/` and `src/ipc/ai.ts`. Installed by `installAi()` from
`main.tsx`.

| File | What |
|---|---|
| `src/ipc/ai.ts` | Typed wrappers for the `ai_*` commands; `AiTarget`; `PROVIDERS` (names, API or CLI, key needed); `PROTECTED_EXTRA_KEYS`; `toAiError`; the agent wire types (`ToolDef`, `AgentMessage`, `AgentEvent`, `AgentTurn`). `aiStream`, `aiAgentTurn` and `aiAcpPrompt` create the Channel and drop messages that arrive after the promise settled; `aiAcpToolResult`, `aiAcpClose` and the ACP types (`AcpEvent`, `AcpStop`, `AcpPromptRequest`, `AgentStatus`). In a plain browser a mock answers: keys in memory, a canned suggestion after 600 ms, a canned Markdown stream in 12 chunks 40 ms apart (both cancellable), an agent (`mockAgentTurn`: a `…__recent_blocks` call, then a short answer), and a model list of ~40 ids for API providers (none for CLIs), and an ACP agent (`mockAcpPrompt`: a `…__recent_blocks` `toolCall` when offered, answered through `aiAcpToolResult`, then a short streamed answer; `ai_cli_status` for Claude Code reports the adapter missing). |
| `stream.ts` | `streamText(feature, { system, prompt, maxTokens }, onText)` → `{ result, cancel }`: resolves `targetFor(feature)`, makes the request id, accumulates deltas and calls `onText(soFar)` at most once per animation frame, then once with the authoritative text. Explain uses it. Tested in `stream.test.ts` against the mock. |
| `profiles.ts` | Pure apart from the settings store: which profile a feature uses (`profileFor`), `providerConfigOf`, `profileReady` / `profileProblem`, `featureReady` / `featureProblem`, `targetFor(feature)` (omits `extra` for CLIs), `FEATURES` (the rows under Features), `parseExtra`, and the mutations (`saveProfile`, `deleteProfile`, `duplicateProfile`, `setDefaultProfile`, `setFeatureProfile`). Unit-tested in `profiles.test.ts`. |
| `context.ts` | Pure: `contextBody` (facts, earlier commands, blocks; redacted), `buildContext` (body + "Next command:", and the body for other requests), `formatBlock`, `redact`, `trimOutput(output, limits?)`, `parseSuggestion`. Unit-tested in `context.test.ts`. |
| `engine.ts` | The suggestion engine, per pane and outside React; `contextFor(paneId, { block? })` over the pure `contextInputOf`; `aiConfigured`, `localPrediction`. Requests go to `targetFor("suggestions")`. |
| `editorRequests.ts` | Requests whose answer lands in a pane's blocks editor (`/cmd`, Fix), per pane outside React: `startEditorRequest`, `cancelEditorRequest`, `failEditorRequest`, the store `BlockInput` renders, and the bound editor's draft (`bindEditor`, `editorDraft`). Tested in `editorRequests.test.ts`. |
| `blockAi.ts` | Explain and fix: the prompts, `buildExplainRequest` / `buildFixRequest`, `explainRequest`, `fixCommand`, `canFix`, `fixBlock`. Tested in `blockAi.test.ts`. |
| `blockNotes.ts` | The notes under blocks (Explain): `useBlockNotes`, `explainBlock`, `stopNote`, `dismissNote`, `toggleNote`, `pruneNotes`, `dropPaneNotes`, and `runNote` (the stream seam). Tested in `blockNotes.test.ts` with a fake stream. |
| `slash.ts` | Slash commands for the blocks editor: the registry, `parseSlash`, `slashCompletion`, and `/cmd`'s request (`writeCommand`, `buildCmdRequest`). Unit-tested in `slash.test.ts`. |
| `predict.ts` | Pure: local next-command prediction from the command log (`predictNext`, `tokenize`). Unit-tested in `predict.test.ts`. |
| `AiSection.tsx` | Settings → AI: suggestions switches, Models, Features. |
| `settings/AgentStatus.tsx` | The agent's adapter status: `AgentStatusLine` (the profile editor's second status line), `useAgentAdapterProblem` (the Features row), `ProblemText` (a problem with its install command in mono and a copy button). |
| `settings/ProfileList.tsx`, `settings/ProfileEditor.tsx` | Settings → AI → Models: the profile rows and the inline draft editor (key and CLI status, model list, effort options). |
| `src/components/ui/Combobox.tsx` | The model field: a text field with a fuzzy-filtered list (Radix `Popover` + `cmdk` + `fuzzysort`). `comboItems` is the pure row logic, tested in `Combobox.test.ts`. |
| `commands.ts` | Commands, the terminal menu's per-pane switch and block items (`blockAiMenuItems`), registration (the Agent plugin and the `/agent` handler too). |
| `agent/tools.ts` | Pure: `buildToolset(skills, { acp? })` → `{ system, tools, resolve, loadSkill }`, wire names, `AGENT_SYSTEM_PROMPT`; the ACP variant caps names at 64 and adds a prompt line that our tools may appear under an `mcp__midterm__` prefix. Tested in `tools.test.ts`. |
| `agent/loop.ts` | The loop, pure apart from injected `LoopDeps` (`turn`, `cancel`, `invoke`, `ask`, `contextLine`): `runTurn`, `runToolCall` (one tool call: resolve, confirm, invoke, redact, clip; shared by both drivers), the transcript item types, limits, result clipping. Tested in `loop.test.ts` with fakes. |
| `agent/acp.ts` | The ACP driver `runAcpTurn` (CLI profiles), pure apart from `AcpDeps`: one `ai_acp_prompt` per message, events → transcript items, `MAX_ACP_TOOL_CALLS`, `CONTINUE_PROMPT`. Tested in `acp.test.ts` with fakes. |
| `agent/conversation.ts` | The conversation store (`useAgent`, keyed by id), owners (card or pane), runtime (abort controller, pending confirmations), cards (`askAgent`, `dismissCard`), Agent pane slots (`holdPaneConversation`, `newPaneConversation`), the work pane, the context line; picks the backend from the profile (`runTurn` for API, `runAcpTurn` for CLI) and closes a dropped conversation's ACP session. |
| `agent/actions.ts` | What the commands, menus and `/agent` do: `askAgentAbout`, `promptForAgent`, `continueInPane`, `openAgent`, `agentNewConversation`. |
| `agent/AgentCard.tsx`, `AgentPane.tsx`, `Transcript.tsx`, `plugin.tsx` | The card (rendered by `PaneHost`), the Agent pane, the shared transcript, the `agent` plugin. Styles in `src/styles/agent.css`. |
| `src/components/panes/BlockNote.tsx`, `src/components/ui/Markdown.tsx` | The note panel under a block; a sanitized Markdown block (`renderMarkdown`) whose http(s) links open in the browser. |

### Settings

`settings.ai` (`src/settings/schema.ts`):

| Field | Meaning |
|---|---|
| `suggestions` | On by default. Local predictions work right away; model requests wait until the suggestions feature resolves to a ready profile. |
| `contextBlocks` | Finished blocks sent as context (0–20, default 5). |
| `profiles` | Model profiles, in display order (at most 50). |
| `defaultProfile` | The profile id every feature without an override uses; `""` for none. |
| `features` | Per-feature overrides, feature → profile id. Features: `AI_FEATURES` = `suggestions`, `cmd`, `explain` ("Explain and fix": Explain and Fix share it), `agent` (API and Claude Code profiles: `featureProblem` reports any other CLI profile as not supported yet). |

A profile (`AiProfile`):

| Field | Meaning |
|---|---|
| `id` | Stable generated id, `p-` + 8 base36 chars (`default` for a migrated profile). Features reference ids, so renaming is one field. |
| `name` | The alias; 1–40 chars, unique case-insensitively. |
| `provider` | A provider id; an unknown id makes the profile "not ready". |
| `model` | The model id. Empty means the CLI's default (CLI providers only). |
| `baseUrl` | `custom` only (cleared for other providers). |
| `cliPath` | Executable override (CLI providers). There is no field for the ACP adapter's path (`acpPath`) yet. |
| `effort` | Missing (Midterm's pick), `default` (send nothing) or a level. See "Reasoning effort". |
| `extra` | Extra request JSON (API providers only). See [Extra request JSON](#extra-request-json). |

A profile is **ready** when its provider is known, it has a model (API
providers) and a base URL (`custom`); whether a key is stored is checked by
the backend. `validateAi` drops profiles without a valid id
(`/^[a-z0-9-]{1,40}$/`) or with a duplicate one, trims strings, names an
empty name `Profile N` and suffixes a duplicate name, drops an invalid
`effort` or `extra`, points `defaultProfile` at an existing profile (else
the first, else `""`), and keeps only known features pointing at existing
profiles. Deleting a profile removes its `features` entries; if it was the
default, the first remaining profile becomes the default.

Settings version 5 replaced the flat `provider`, `model`, `baseUrl`,
`cliPaths` and `effort` fields: a chosen provider became one profile
(`id: "default"`, named after the model or the provider, with that
provider's CLI path and effort) used by every feature. Effort and CLI paths
remembered for other providers were dropped.

A pane's own switch is `aiSuggestions: false` in the terminal pane's data
(terminal menu → "Suggestions in this pane", shown while suggestions are
on). It turns off local predictions too.

Keys never pass through the settings. The key field is write-only: Save
sends it to `ai_key_set`, and the UI only ever learns `ai_key_status`. Keys
stay per provider (a `custom` key per base URL), so all profiles of one
provider share one key.

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

`contextFor(paneId, { block })` is the context a request **about a block**
(Explain, Fix) starts with: the block's scope (`scopeOf(block.nested,
block)`), directory and branch (from when it ran), the remote host when it
ran over ssh, and only what came before it: the same shell's finished
blocks before it, and the earlier commands without it and without the
commands of the blocks after it (the pane's command list is de-duplicated,
so the list is cut where the block's command was last run, and the later
blocks' commands are left out by text). The block itself is not in the body; the
headings say "Commands run before the one in question".

The pure part is `contextInputOf(source, { limit, block?, branch? })`;
`contextFor` feeds it the session, and `contextBody` turns it into text.
`buildContext` returns `{ system, prompt, body }`; `/cmd`, Explain and Fix
append their own question to `body`.

`contextBody` strips escape sequences from each output, redacts it, and
only then trims it (`trimOutput`) to its first 15 and last 25 lines (240
characters per line, 3000 per block; the block a request is about gets
`{ head: 40, tail: 80, chars: 12000 }`). Commands are likewise redacted before they are
clipped to 500 characters. Redacting first means a secret that straddles a
cut is still recognised. The whole prompt is redacted again at the end. `redact` replaces:

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

Reused arguments are substituted (and shell-quoted if needed); every
other word keeps its text as written, so `"$HOME/x"` stays an expansion.
Pending pairs are saved on quit. A pair of
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
| `/agent <task>` | Runs the task through the agent against this terminal, in the pane's agent card (see [Agent](#agent)). Without a task, "Say what the agent should do: /agent <task>" shows above the editor. |

`/cmd`: on ⏎ the line moves above the editor ("writing a command… esc
cancels"; Esc or ⌃C cancels and puts the line back) and the request goes
out with the same context as a suggestion (`contextFor`): its body, then
`Task: <task>` (redacted) and "Command:", with `CMD_SYSTEM_PROMPT`. The reply budget is 400 tokens, and the reply goes through
`parseSuggestion`. The command lands in the editor, **under the request
line, never run**: edit it or press ⏎ (a held, auto-repeating ⏎ does not
run it). While the request runs, other keys are swallowed (⌃D does not
reach the shell) and focusing the editor asks for no suggestion. On failure the error shows next to
the line and the line goes back in the editor, so ⏎ tries again. `/cmd`
needs a ready profile (`targetFor("cmd")`; else "Choose a model for /cmd in
Settings → AI.") but not the suggestions switch. Slash
lines are not added to the history or the command log.

The request state lives in `editorRequests.ts` (per pane, outside React),
not in `BlockInput`, so a block's Fix goes the same way: `BlockInput`
renders the line and status from the store, puts `result` in the editor
when done and `restore` back on an error or a cancel (once per request,
`applied`), and cancels the request when it unmounts. Starting a request
cancels the pane's previous one.

### Explain and fix

Two actions on a finished block, both on the `explain` feature's profile
("Explain and fix" under Features). They show only when that feature has a
ready profile (`featureReady("explain")`).

- **Explain** ("Explain this error" when the exit status is non-zero, else
  "Explain this output"): any finished block with a command. The request is
  the block's context body (`contextFor(paneId, { block })`), then "The
  command in question:" with `$ command`, `(in cwd)` (`host:path` when
  remote), the output trimmed to `{ head: 40, tail: 80, chars: 12000 }` and
  `[exit N]`, then "Explain:". `EXPLAIN_SYSTEM_PROMPT` asks for short
  Markdown: what went wrong, the likely cause, how to fix it with commands
  in fenced blocks, without repeating the output. Reply budget 1200 tokens,
  streamed (`streamText("explain", …)`).
- **Fix** ("Fix this command"): only when the block failed and
  `canReplay(session, block)` holds (same shell, at a prompt). The same
  request ending in "Corrected command:", with `FIX_SYSTEM_PROMPT` (only
  the corrected command on one line, nothing if there is none), budget 400,
  not shown as it arrives, then `parseSuggestion`. It goes through
  `aiStream` rather than `aiSuggest` for the stop reason: a reply cut off at
  the token limit is refused ("The fix was cut off at the token limit.")
  instead of landing as a partial command. It goes through
  `startEditorRequest`: the line `fix: <command>` shows above the editor
  with "fixing the command… esc cancels", and the command **lands in the
  editor, never run**. Esc or ⌃C cancels and puts the editor's previous
  draft back, as does an error ("The model has no fix for this command."
  when the reply is empty).

Redaction as elsewhere: each output before it is trimmed, then the whole
prompt again.

**Notes** (`blockNotes.ts`) are kept per pane and block outside React, in
memory only: `{ status: loading | streaming | done | error, text, error?,
cut?, stopped?, collapsed }`. One request per block (Explain again or Retry
restarts it); several blocks may stream at once. Stop cancels the request
and keeps the text so far. While a pane has notes, `blockNotes.ts`
subscribes to its block tracker and runs `pruneNotes` whenever the blocks
change (cleared or out of the scrollback), also while the pane shows the
classic terminal; and
`dropPaneNotes` when the pane's session ends (`onSessionDisposed`, hooked
up by `installAi`); both cancel requests in flight. Without a ready
profile, Explain puts "Choose a model for Explain and fix in Settings → AI."
in the note.

The **panel** (`BlockNote.tsx`) sits inside the block under its output and
subscribes to its own note, so the memoized block does not re-render while
text streams. Header (`blocks-meta`): a chevron and "AI · explanation"
(collapses the body), then "thinking…" (pulsing) until the first text,
"cut off at the token limit", or "stopped"; on the right Stop (while
running), Copy (the Markdown source), Retry and Dismiss. The body is the
Markdown (`components/ui/Markdown.tsx`: `renderMarkdown`, `markdown-body
markdown-compact`; http(s) links open in the browser, others do nothing)
with an error in `text-err` under any partial text. Styles: `.block-ai` in
`styles/blocks.css` (`border-line-block`, `fg-bright` at 4%, tokens only).

### Agent

An agent over plugin skills ([plugins.md](plugins.md#skills)): the model
acts through the enabled skills' tools (read recent blocks, run a command,
list a directory, open, read or save a file…). **API profiles** run the loop
in the webview (`runTurn`, one `ai_agent_turn` per model turn). **Claude
Code profiles** run it in the CLI, over a per-conversation ACP session that
serves the skills' tools back to it (`runAcpTurn`, see
[ACP sessions](#acp-sessions) and [The ACP driver](#the-acp-driver)). Other
CLI profiles (Codex, Antigravity) are not supported yet: the card, the pane
and the Features row say "The agent does not support Codex yet. Choose an
API model or Claude Code for Agent in Settings → AI." (a CLI cannot call the
webview's skills headless, which is why ACP is needed).

**Two surfaces, one loop.** Conversations live in one store
(`agent/conversation.ts`) keyed by id; two views show them:

- **One-off requests**: `/agent <task>` in the blocks editor, `ai.askAgent`
  ("AI: Ask the agent…", which prompts for the task in the palette, see
  [palette.md](palette.md#pickers-and-prompts)) and the pane menu's Agent →
  "Ask the agent about this pane…" run a conversation against that pane in
  its **agent card**: an overlay docked at the bottom of the pane, any kind
  of pane, rendered by the pane host (not by `BlockInput`), so it survives
  the blocks editor unmounting while the agent runs commands. Header: model,
  state ("working…", "waiting for you"), Stop, Copy (the transcript as
  Markdown), "Continue in agent pane", collapse (to a header on the right,
  so the prompt underneath is usable), Dismiss. One card per pane: a new
  one-off replaces a finished card and asks first ("Replace the running
  request?") if one is running. In an Agent pane, `ai.askAgent` sends the
  task to its conversation instead. The card's conversation goes with its
  pane, and with Dismiss.
- **The Agent pane** (`agent` plugin, built in) for an extended exchange:
  `ai.openAgent` (palette), the pane menu's Agent → "Open the agent pane",
  the tab menu's "Open the agent" (each focuses the tab's Agent pane or
  opens one beside), or the card's "Continue in agent pane" (moves the
  conversation, history, transcript, allowed tools and all, into a new
  Agent pane; the button is disabled while the Agent plugin is, and the card
  keeps the conversation if the pane could not be opened). Header
  (`text-meta`): "Working with: <kind> · <directory>" (the tab's last active
  non-agent pane, fixed while a turn runs; none when the tab has no other
  pane, rather than a pane of another tab), the
  model, New conversation. Then the transcript and a textarea (⏎ sends, ⇧⏎
  adds a line, Esc stops; a Stop button while running). Plugin:
  `closeBlockers` → `{ type: "running", name: "the agent" }` while a turn
  runs, `tabTitle` "Agent", menu items New conversation and Stop. Without a
  ready profile it shows the problem and a button to Settings → AI.

**The transcript** (`Transcript.tsx`, shared): the user's messages,
Markdown answers (`components/ui/Markdown`; "stopped" or "cut off at the
token limit" under a partial one), one row per tool call (`skill › tool`,
the input's gist, status running / waiting for you / done / failed /
denied / cancelled / not run; expandable to the input and the result sent
back), "Loaded skill: …", errors with Retry, notes ("Stopped after 12
steps." with Continue). A write tool's row, while it waits, shows where it
acts ("In: Block terminal · ~/x": the pane its input names, else the
conversation's), its input (a command in mono) and **Allow / Allow for this
conversation / Deny**.
"Allow for this conversation" is remembered per tool (wire name) in the
conversation and forgotten by New conversation. It sticks to the bottom
unless scrolled up. No confirmation hook is installed globally
(`setWriteConfirmation`): the agent passes its own `confirm` to each
`invokeSkillTool` call.

**Frozen per conversation.** (API loop; the ACP driver freezes `system` and
`tools` at the session's first prompt, below.) Current Claude models reject replayed thinking
blocks (400) when `system`, `tools` or earlier turns changed, so:

- all enabled skills' tools are declared up front (`buildToolset`), with
  `load_skill` returning only instructions;
- the system prompt (`AGENT_SYSTEM_PROMPT` plus one sorted `id — title:
  description` line per skill) has nothing volatile in it;
- history is append-only, and assistant turns are replayed **verbatim**
  (`raw`, see [Requests with tools](#requests-with-tools-agent-turns));
- a conversation keeps the target (profile) it started with, also when the
  settings change; New conversation picks up changed settings and skills.

**The loop** (`agent/loop.ts`, in the webview; one `ai_agent_turn` per model
turn):

1. The user's text is appended (redacted). The first message of a
   conversation starts with a redacted context line: `[Context — OS: macOS;
   working with: Block terminal pane <id>; directory: ~/x; git branch:
   main]`.
2. Each round: `ai_agent_turn` with the frozen system and tools and the
   history, reply budget 4096 tokens (plus effort headroom); `text` events
   stream into an answer item; the complete turn's `raw` is appended.
3. Its tool calls run **in order, one at a time**: invalid JSON →
   `{"INVALID_JSON": …, "arguments": …}`; unknown name → an error;
   `load_skill` → `{ skill, title, instructions, tools }`; otherwise
   `invokeSkillTool(skillId, tool, input, { paneId: targetPane, signal,
   confirm })`. Each result is `JSON.stringify(result | { error })` with
   every string in it redacted first (before JSON escapes quotes and line
   breaks), the whole text redacted again, clipped to 16 000 characters (head and tail), and all
   of a round's results are appended as one `tool` message. Then the next
   round.
4. It ends when a turn calls no tool. After 12 rounds: "Stopped after 12
   steps." with Continue (another 12 from the history).

Every appended tool call always gets a result, so the history stays valid:
a reply cut off at the token limit gets "Not run: the reply was cut off" for
each call (and an error with Retry); Stop gets "Cancelled by the user" for
calls not yet finished. **Stop** cancels the turn (`ai_cancel`), aborts the
tools' `signal` and declines a pending confirmation; a turn cancelled before
it finished is not appended (its partial text stays, marked stopped). A
turn that fails (`network`, `http`, `auth`, …) leaves the history unchanged
and shows its error with Retry. The transcript is in memory only (lost on
restart).

What is sent: the user's messages, the context line, and whatever the tools
return (recent commands and output, directory listings, file contents),
all redacted (`redact`); Settings → AI says so.

#### The ACP driver

`runAcpTurn` (`agent/acp.ts`) is the loop for a CLI profile. The CLI runs
the tool loop; the webview only feeds it and runs the tools:

- **One `ai_acp_prompt` per user message.** The session keeps the history,
  so the conversation's `messages` only records the prompts the session has
  seen. `system` (`AGENT_SYSTEM_PROMPT` plus the skill lines, and the one
  line about the `mcp__midterm__` prefix) and `tools` are **frozen at the
  first prompt** (the toolset is built with `{ acp: true }`: names capped at
  64, since Claude Code drops longer ones silently), and the conversation
  keeps the profile it started with.
- **Context line**: the redacted `[Context — …]` line starts the first
  prompt the session has seen, not later ones.
- **Events** map onto the same transcript as the API loop: `text` streams
  into an answer (a new answer starts after a tool row), `toolCall` is run
  **serially** through `runToolCall` (shared with `runTurn`: the same
  resolve, Allow / Allow for this conversation / Deny confirmations, input
  validation, redaction of every string, clipping to 16 000 characters;
  the result goes back with `ai_acp_tool_result`), `foreignTool` is a muted
  "CLI tool: <title>" row with its status (a tool the CLI ran itself,
  which the lockdown should have prevented; its permission request is rejected). Events are
  handled in order, so a call waiting for confirmation holds back what
  follows.
- **Stop** cancels the prompt (`ai_cancel`), declines a pending
  confirmation and aborts the tool; the answer so far stays, marked
  stopped, and a call still running gets "Cancelled by the user". Stop
  reasons: `end` finishes; `length` shows "cut off at the token limit"
  (note, or the answer marked cut); `refused` is an error with Retry;
  `maxRequests` (the CLI's own request limit) a note with Continue;
  `cancelled` a stopped answer.
- **30-call cap** (`MAX_ACP_TOOL_CALLS`): past 30 of our tool calls in one
  prompt, further calls are answered "not run", the prompt is cancelled and
  a note "Stopped after 30 tool calls." offers **Continue** (sends "Continue
  where you left off." in the same session).
- **Errors** (including the backend's: adapter missing, `auth`, timeouts)
  show with **Retry**, which sends the **failed prompt again**
  (`retryText`; it was not recorded as seen, so a first prompt keeps its
  context line).
- **Lifecycle**: the session lives until the conversation is dropped (the
  card or pane goes, Dismiss, New conversation; then `ai_acp_close`).
  "Continue in agent pane" moves the conversation, so the session goes with
  it. A session the backend evicted (more than 8 alive), lost to a crash or
  closed with its window is simply started fresh by the next prompt, with
  the same frozen system and tools but **no memory** of the earlier
  messages (the transcript still shows them).

### Commands

- `ai.toggleSuggestions`: AI: Toggle suggestions.
- `ai.suggestNow`: AI: Suggest a command now. Opens the settings if AI is
  not set up.
- `ai.explainLastCommand`: AI: Explain the last command; and
  `ai.fixLastCommand`: AI: Fix the last command. They act on the active
  block terminal's last finished block with a command (nothing in a
  classic terminal), and open the settings when "Explain and fix" has no
  ready profile.
- `ai.askAgent`: AI: Ask the agent… (palette prompt; opens the settings
  when the agent has no ready profile); `ai.openAgent`: AI: Open the agent;
  `ai.agentNewConversation`: AI: New agent conversation (the active Agent
  pane, else the tab's). See [Agent](#agent).
- `ai.openSettings`: AI: Settings….

### Settings → AI

- A note on what leaves the machine (including that the agent sends what
  its tools read).
- **Suggestions**: the toggle, the context size, and "Preview what is sent".
- **Models**: one row per profile (name, `provider · model`, status:
  `text-ok` Ready or `text-warn` with the problem) with Edit, Duplicate and
  Delete, and "Add model". Deleting a profile a feature uses asks first
  (`confirm()`), naming the features that fall back. Edit opens the editor
  inline under the row, one at a time; a new profile is edited under the
  list and only added on Add.
- The **editor** works on a draft with explicit Save / Cancel (keys are the
  exception: saved and removed at once). Rows: Name; Provider, grouped into
  APIs and CLIs, with its status (key saved, or the CLI found with its path
  and version, and for Claude Code a second **Agent** line, see below); Base URL (custom), API key with Save and Remove (APIs; the
  hint says the key is shared by every profile of the provider), or
  Executable (CLIs); Model; Reasoning effort (Automatic, Provider default,
  and the levels `ai_effort_options` returns; the hint says what is sent
  when a level is clamped, or when nothing is); Extra request JSON (API
  providers: a monospace textarea validated by `parseExtra` on blur and on
  Save; the error shows under it and disables Save); Test (`ai_test` on the
  draft). Changing the provider clears model, effort and extra.
- The **Model** field is a `Combobox`: it opens on focus, click, typing or
  ↓ and shows the provider's list (`ai_models`) fuzzy-filtered with the
  matched characters in `text-accent-fg`; with an empty query every option
  shows (at most 200, plus the current value), the current one selected.
  When the text is not exactly an option the first row is `Use "<text>"`.
  ⏎ commits the selected row; ⇥ or blur commits the typed text. Esc closes
  the list first, then reverts the text (the field marks itself
  `data-escape-local` so the dialog does not close). A footer shows
  Loading…, the error with Retry, or "N models" with a refresh. The list is
  portaled; its wheel and touchmove events stop propagating so the modal
  dialog's scroll lock does not eat them.
- **Features**: "Default model" (a select of profiles), then one row per
  `FEATURES` entry with "Default (<name>)" plus every profile; the hint
  shows `featureProblem`. The Agent row also shows the adapter problem when
  its profile is Claude Code and `ai_cli_status().agent` is not ready
  (checked once per profile config, `useAgentAdapterProblem`), with the
  install command in mono and a copy button. Without profiles, one line
  pointing at Add model.
- The editor's **Agent status line** (`AgentStatusLine`, under the
  provider's status, CLIs only): `Agent: ready · claude-agent-acp <version>`
  in `text-ok`, with the adapter's `note` muted (a version newer than
  tested); or the problem in `text-warn` with its install command copyable;
  "Agent: not supported for <CLI> yet" for Codex and Antigravity. The
  adapter's path (`acpPath`) cannot be set in Settings yet.

### Self-test

With `aistub=PORT` in the self-test URL, and `bun scripts/ai-stub.ts PORT`
running (a stand-in OpenAI-compatible server), the self-test:

1. runs a command that exports a fake password;
2. checks that nothing is asked while no profile is chosen;
3. sets a `custom` profile pointed at the stub as the default and asks;
4. checks that the ghost text shows the stub's answer. The stub only gives
   that answer when the prompt contains the command and not the secret.
5. checks that ⇥ accepts it;
6. runs a failing `ls`, explains it, and checks the note under the block
   holds the stub's explanation (which names the command in question);
7. fixes it and checks the stub's command is in the editor and no block
   was added;
8. types `/agent what did I run last?` and checks the pane's agent card
   shows the `recent_blocks` tool row and the stub's answer naming the
   failed command;
9. when the backend runs with `MIDTERM_ACP_STUB` (below), sets a
   `claude-code` profile, asks `/agent what did I run last?` again and
   checks the card shows the `recent_blocks` tool row and the answer from
   the ACP stub; then puts the profiles back. Without the variable, this
   step is skipped.

The stub also answers `stream: true` with SSE chunks (a longer reply, one
word every 80 ms) and `[DONE]`, for trying `ai_stream` / `streamText` by
hand in a dev build. A prompt ending in "Explain:" gets a Markdown
explanation (streamed without the suffix) containing `midterm-explain-ok`,
and one ending in "Corrected command:" gets `echo midterm-fix-ok` (after 3
s when the prompt contains `midterm-slow`, to try cancelling).

A request with `tools` is an agent turn, answered in the OpenAI tool-call
format (streamed with the arguments split over chunks, or JSON), decided by
the last user message and the tool messages after it: by default a
`…__recent_blocks` call, then an answer with `midterm-agent-ok` and the last
command it returned; with `midterm-agent-write`, two `…__run_command` calls
(`echo midterm-agent-1`, `-2`, one per round, to try Allow, Allow for this
conversation and Deny), then an answer saying which ran and which were
denied; with `midterm-agent-slow`, a long answer one word every 80 ms, to
try Stop.

`scripts/acp-stub.ts` is a stdio ACP agent with no model behind it, for the
agent over ACP. It advertises MCP-over-ACP and a `systemPrompt` override,
offers the `model`, `effort` (`thought_level`) and `mode` options, and
streams `agent_message_chunk` updates. It calls Midterm's tools through the
attached `midterm` MCP server (`server/discover`, `tools/list`,
`tools/call`) and answers by prompt text like the API stub: by default a
`recent_blocks` call, then `midterm-agent-ok` and the last command;
`midterm-agent-write` makes two `run_command` calls (`echo midterm-agent-1`,
`-2`) and reports which ran or were denied; `midterm-agent-slow` streams a
long answer, stopped by `session/cancel`; `midterm-agent-plain` answers
without tool calls. `--version` prints `acp-stub 0.0.0`.

`MIDTERM_ACP_STUB="bun /abs/path/scripts/acp-stub.ts"` makes the backend run
that command (split on whitespace, the program looked up on the login
shell's PATH) in place of `claude-agent-acp`, with no Claude Code lookup. It
is read in debug builds and `bun run dev:mcp` builds only and ignored in
release (`agents::stub_command`). While it is set, `ai_cli_status` reports
the agent ready with an adapter whose version is `stub`; the self-test uses
that to decide whether to run its ACP step. Start the app with
`MIDTERM_ACP_STUB=... ` and `?selftest=PORT&aistub=PORT` in the dev URL. To
try the stub alone: `bun scripts/acp-probe.ts --prompt midterm-agent-slow
--cancel-after 600 -- bun scripts/acp-stub.ts`.
