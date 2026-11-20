/*
 * A stand-in OpenAI-compatible endpoint for the self-test's AI check
 * (src/dev/selftest.ts): `bun scripts/ai-stub.ts PORT`. It answers model
 * listings and chat completions; the suggestion it returns says whether the
 * prompt it got had the test's secret redacted. With `stream: true` it
 * answers with SSE chunks (a longer reply, word by word, `STREAM_GAP_MS`
 * apart) and `[DONE]`, for trying `ai_stream`.
 *
 * Explain and fix (prompts ending in "Explain:" / "Corrected command:"):
 * an explanation in Markdown naming the command in question (streamed), and
 * `echo midterm-fix-ok`. A fix for a command containing `midterm-slow` takes
 * `SLOW_MS`, to try cancelling it.
 *
 * Agent turns (a request with `tools`, MID-13), in the OpenAI tool-call
 * format, decided by the last user message and how many tool messages
 * follow it:
 * - by default: a `…__recent_blocks` call, then an answer containing
 *   `midterm-agent-ok` and the last command the tool returned;
 * - "midterm-agent-write": a `…__run_command` call for
 *   `echo midterm-agent-1`, then one for `echo midterm-agent-2`, then an
 *   answer quoting what each call returned (ran, or denied);
 * - "midterm-agent-slow": a long answer, one word every `STREAM_GAP_MS`,
 *   to try Stop.
 */

const port = Number(process.argv[2] ?? 47124);
const STREAM_GAP_MS = 80;
const SLOW_MS = 3000;

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function streamed(text: string, suffix = true): Response {
  const full = suffix ? `${text} — streamed by the AI stub, one word at a time, so the reply arrives in many small pieces.` : text;
  const words = full.split(/(?=[ \n])/);
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let at = 0;
      const next = () => {
        if (at === 0) controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "" })));
        if (at < words.length) {
          controller.enqueue(encoder.encode(chunk({ content: words[at++] })));
          timer = setTimeout(next, STREAM_GAP_MS);
          return;
        }
        controller.enqueue(encoder.encode(chunk({}, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };
      next();
    },
    cancel() {
      clearTimeout(timer);
      console.log("stream cancelled by the client");
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

type ToolCall = { id: string; name: string; arguments: string };

/** An assistant turn that calls tools: SSE with the arguments split over chunks, or JSON. */
function toolCalls(calls: ToolCall[], stream: boolean | undefined): Response {
  if (!stream) {
    return Response.json({
      id: "stub",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) },
          finish_reason: "tool_calls",
        },
      ],
    });
  }
  const frames: string[] = [chunk({ role: "assistant", content: null })];
  calls.forEach((c, index) => {
    frames.push(chunk({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] }));
    const half = Math.ceil(c.arguments.length / 2);
    for (const part of [c.arguments.slice(0, half), c.arguments.slice(half)]) {
      frames.push(chunk({ tool_calls: [{ index, function: { arguments: part } }] }));
    }
  });
  frames.push(chunk({}, "tool_calls"), "data: [DONE]\n\n");
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let at = 0;
      const next = () => {
        if (at < frames.length) {
          controller.enqueue(encoder.encode(frames[at++]));
          timer = setTimeout(next, 30);
          return;
        }
        controller.close();
      };
      next();
    },
    cancel() {
      clearTimeout(timer);
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

type ChatMessage = { role?: string; content?: string | null; tool_call_id?: string };
type ChatBody = { messages?: ChatMessage[]; stream?: boolean; tools?: { function?: { name?: string } }[] };

let callCounter = 0;

/** An agent turn (see the header). */
function agentTurn(body: ChatBody): Response {
  const messages = body.messages ?? [];
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const task = String(messages[lastUser]?.content ?? "");
  const results = messages.slice(lastUser + 1).filter((m) => m.role === "tool").map((m) => String(m.content ?? ""));
  const toolNamed = (suffix: string) => body.tools?.map((t) => t.function?.name ?? "").find((name) => name.endsWith(suffix));
  const call = (name: string, input: unknown): ToolCall => ({ id: `call_stub_${++callCounter}`, name, arguments: JSON.stringify(input) });

  if (task.includes("midterm-agent-slow")) {
    const words = Array.from({ length: 80 }, (_, n) => `word${n + 1}`).join(" ");
    return reply(`Working slowly (midterm-agent-slow): ${words}.`, body.stream, false);
  }
  if (task.includes("midterm-agent-write")) {
    const run = toolNamed("__run_command");
    if (run && results.length < 2) return toolCalls([call(run, { command: `echo midterm-agent-${results.length + 1}` })], body.stream);
    const said = results.map((r, n) => `${n + 1}. ${/did not allow|denied/i.test(r) ? "denied" : /"sent"/.test(r) ? "ran" : "failed"}`);
    return reply(`Done (midterm-agent-ok):\n\n${said.join("\n")}`, body.stream, false);
  }
  const recent = toolNamed("__recent_blocks");
  if (recent && results.length === 0) return toolCalls([call(recent, { count: 3 })], body.stream);
  const commands = [...(results[0] ?? "").matchAll(/"command":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const last = commands[commands.length - 1] ?? "nothing";
  return reply(`Read the recent blocks (midterm-agent-ok). The last command was \`${last}\`.`, body.stream, false);
}

function reply(text: string, stream: boolean | undefined, suffix = true): Response {
  if (stream) return streamed(text, suffix);
  return Response.json({
    id: "stub",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  });
}

function explanation(command: string): string {
  return [
    `**\`${command}\` failed** (midterm-explain-ok): the stub explains every command the same way.`,
    "",
    "Likely causes:",
    "",
    "- the path does not exist, or is spelled differently;",
    "- you lack permission to read it.",
    "",
    "Check what is there, then run it again:",
    "",
    "```sh",
    "ls -la",
    "```",
    "",
    "More in the [manual](https://example.com/manual).",
  ].join("\n");
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "stub-model", object: "model" }] });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = (await request.json()) as ChatBody;
      if (body.tools?.length) return agentTurn(body);
      const prompt = (body.messages ?? []).map((message) => message.content ?? "").join("\n");
      if (prompt.trimEnd().endsWith("Explain:")) {
        const command = /The command in question:\n\n\$ (.+)/.exec(prompt)?.[1] ?? "?";
        return reply(explanation(command), body.stream, false);
      }
      if (prompt.trimEnd().endsWith("Corrected command:")) {
        if (prompt.includes("midterm-slow")) await Bun.sleep(SLOW_MS);
        return reply("echo midterm-fix-ok", body.stream, false);
      }
      const leaked = prompt.includes("hunter2-selftest");
      const sawCommand = prompt.includes("MIDTERM_SELFTEST_PASSWORD");
      const text = leaked ? "echo leaked" : sawCommand ? "echo midterm-ai-ok" : "echo no-context";
      return reply(text, body.stream);
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`AI stub on http://127.0.0.1:${port}/v1`);
