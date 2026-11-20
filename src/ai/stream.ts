import { type AiError, type StreamReply, aiCancel, aiStream } from "../ipc/ai";
import type { AiFeature } from "../settings/schema";
import { featureProblem, targetFor } from "./profiles";

/*
 * Streamed replies for a feature (see docs/ai.md#streaming): resolves the
 * feature's model profile, makes the request, and hands the text so far to
 * `onText` at most once per animation frame. The resolved reply is
 * authoritative: `onText` gets its text once more before `result` resolves.
 * No calls after an error or `cancel()`.
 */

export type StreamRequest = { system: string; prompt: string; maxTokens?: number };

export type TextStream = { result: Promise<StreamReply>; cancel: () => void };

let counter = 0;

const nextFrame: (run: () => void) => () => void =
  typeof requestAnimationFrame === "function"
    ? (run) => {
        const id = requestAnimationFrame(run);
        return () => cancelAnimationFrame(id);
      }
    : (run) => {
        const id = setTimeout(run, 16);
        return () => clearTimeout(id);
      };

export function streamText(feature: AiFeature, request: StreamRequest, onText: (soFar: string) => void): TextStream {
  const target = targetFor(feature);
  if (!target) {
    const error: AiError = { kind: "other", message: featureProblem(feature) ?? "No model is set up for this feature." };
    return { result: Promise.reject(error), cancel: () => {} };
  }
  const requestId = `stream-${feature}-${Date.now().toString(36)}-${++counter}`;
  let soFar = "";
  let shown = "";
  let live = true;
  let pending: (() => void) | null = null;
  const show = (text: string) => {
    if (!live || text === shown) return;
    shown = text;
    onText(text);
  };
  const stop = () => {
    live = false;
    pending?.();
    pending = null;
  };
  const result = aiStream({ requestId, target, ...request }, (delta) => {
    if (!live) return;
    soFar += delta;
    pending ??= nextFrame(() => {
      pending = null;
      show(soFar);
    });
  }).then(
    (reply) => {
      pending?.();
      pending = null;
      show(reply.text);
      live = false;
      return reply;
    },
    (error: unknown) => {
      stop();
      throw error;
    },
  );
  return {
    result,
    cancel: () => {
      if (!live) return;
      stop();
      void aiCancel(requestId).catch(() => {});
    },
  };
}
