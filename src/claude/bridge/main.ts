/*
 * Entry point: `node claude-bridge.mjs`, spawned by the Rust backend.
 * stdin/stdout carry the protocol (src/claude/protocol.ts), one JSON object
 * per line; everything human-readable goes to stderr.
 */
import { createInterface } from "node:readline";
// The SDK does not export its package.json, so it is imported by path (bun inlines it into the bundle).
import sdkPackage from "../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json" with { type: "json" };
import { createBridge } from "./bridge";

// stdout is the protocol: keep stray logging (ours or a library's) off it.
const toStderr = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
console.log = console.info = console.warn = console.debug = toStderr;

const stdout = process.stdout;
const bridge = createBridge({
  write: (line) => {
    try {
      stdout.write(JSON.stringify(line) + "\n");
    } catch (e) {
      toStderr("bridge: cannot write line:", e instanceof Error ? e.message : e);
    }
  },
  sdkVersion: (sdkPackage as { version: string }).version,
  claudePath: process.env.MIDTERM_CLAUDE_PATH || undefined,
});

// A bug in one request must not take every session down.
process.on("uncaughtException", (e) => toStderr("bridge: uncaught:", e instanceof Error ? (e.stack ?? e.message) : e));
process.on("unhandledRejection", (e) => toStderr("bridge: unhandled rejection:", e instanceof Error ? (e.stack ?? e.message) : e));
// A closed stdout means the backend is gone.
stdout.on("error", () => process.exit(0));

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const inflight = new Set<Promise<void>>();
rl.on("line", (line) => {
  const p = bridge.handleLine(line).finally(() => inflight.delete(p));
  inflight.add(p);
});
rl.on("close", () => {
  bridge.shutdown();
  // Give child processes a moment to receive EOF, then leave even if something hangs.
  setTimeout(() => process.exit(0), 300).unref();
  void Promise.allSettled([...inflight]).then(() => setTimeout(() => process.exit(0), 100));
});
