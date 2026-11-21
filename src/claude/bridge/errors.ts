import type { BridgeError } from "../protocol";

/** An error that carries a protocol error code to the webview. */
export class BridgeFailure extends Error {
  constructor(
    message: string,
    readonly code: NonNullable<BridgeError["code"]> = "other",
  ) {
    super(message);
  }
}

export function toBridgeError(e: unknown): BridgeError {
  if (e instanceof BridgeFailure) return { message: e.message, code: e.code };
  const message = e instanceof Error ? e.message : String(e);
  // Sign-in problems surface as plain messages from the CLI; tag them so the UI can say "run claude /login".
  const code = /not logged in|\/login|authentication|invalid api key|oauth/i.test(message) ? "auth" : "other";
  return { message, code };
}
