/*
 * A stand-in OpenAI-compatible endpoint for the self-test's AI check
 * (src/dev/selftest.ts): `bun scripts/ai-stub.ts PORT`. It answers model
 * listings and chat completions; the suggestion it returns says whether the
 * prompt it got had the test's secret redacted.
 */

const port = Number(process.argv[2] ?? 47124);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "stub-model", object: "model" }] });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = (await request.json()) as { messages?: { content?: string }[] };
      const prompt = (body.messages ?? []).map((message) => message.content ?? "").join("\n");
      const leaked = prompt.includes("hunter2-selftest");
      const sawCommand = prompt.includes("MIDTERM_SELFTEST_PASSWORD");
      const text = leaked ? "echo leaked" : sawCommand ? "echo midterm-ai-ok" : "echo no-context";
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
