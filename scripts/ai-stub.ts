/*
 * A stand-in OpenAI-compatible endpoint for the self-test's AI check
 * (src/dev/selftest.ts): `bun scripts/ai-stub.ts PORT`. It answers model
 * listings and chat completions; the suggestion it returns says whether the
 * prompt it got had the test's secret redacted. With `stream: true` it
 * answers with SSE chunks (a longer reply, word by word, `STREAM_GAP_MS`
 * apart) and `[DONE]`, for trying `ai_stream`.
 */

const port = Number(process.argv[2] ?? 47124);
const STREAM_GAP_MS = 80;

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function streamed(text: string): Response {
  const words = `${text} — streamed by the AI stub, one word at a time, so the reply arrives in many small pieces.`.split(/(?= )/);
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

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "stub-model", object: "model" }] });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = (await request.json()) as { messages?: { content?: string }[]; stream?: boolean };
      const prompt = (body.messages ?? []).map((message) => message.content ?? "").join("\n");
      const leaked = prompt.includes("hunter2-selftest");
      const sawCommand = prompt.includes("MIDTERM_SELFTEST_PASSWORD");
      const text = leaked ? "echo leaked" : sawCommand ? "echo midterm-ai-ok" : "echo no-context";
      if (body.stream) return streamed(text);
      return Response.json({
        id: "stub",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`AI stub on http://127.0.0.1:${port}/v1`);
