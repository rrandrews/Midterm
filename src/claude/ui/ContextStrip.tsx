import { type MouseEvent, useMemo, useRef, useState } from "react";
import type { ContextUsage } from "../protocol";
import { formatTokens } from "../reduce";
import { setPanel, useSession } from "../store";
import type { ClaudeSession } from "../types";
import { categoryStyle } from "./panels/categories";

/*
 * The context strip: a 3px bar under the header that is the context window.
 * One segment per used category in its color, the autocompact buffer
 * hatched at the far end, free space as the track. Without a breakdown yet,
 * a single "used" segment from the token estimate. Hover names the
 * segment under the pointer; click opens the Context panel.
 */

export type StripSegment = {
  id: string;
  name: string;
  tokens: number;
  /** Share of the window, 0–1. */
  share: number;
  color: string;
  hatched?: boolean;
};

const DEFAULT_WINDOW = 200_000;

/** The strip's used segments (left) and buffer (right), as shares of the window. */
export function stripSegments(session: Pick<ClaudeSession, "context" | "contextTokens" | "contextWindow">): { used: StripSegment[]; buffer?: StripSegment; total: number; window: number } {
  const context: ContextUsage | undefined = session.context;
  const window = context?.maxTokens || session.contextWindow || DEFAULT_WINDOW;
  const share = (tokens: number) => Math.max(0, tokens / window);
  if (context?.categories.length) {
    const used: StripSegment[] = [];
    let buffer: StripSegment | undefined;
    for (const category of context.categories) {
      const style = categoryStyle(category);
      if (category.kind === "free" || style.free || category.isDeferred || category.kind === "deferred" || category.tokens <= 0) continue;
      const segment = { id: category.id ?? category.name, name: category.name, tokens: category.tokens, share: share(category.tokens), color: style.color, hatched: style.hatched };
      if (category.kind === "buffer" || style.hatched) buffer = segment;
      else used.push(segment);
    }
    // The conversation has grown since the breakdown: the estimate's extra goes to messages.
    const usedTokens = used.reduce((sum, segment) => sum + segment.tokens, 0);
    const extra = (session.contextTokens ?? 0) - usedTokens;
    if (extra > 0 && session.contextTokens !== context.totalTokens) {
      const messages = used.find((segment) => segment.id === "messages");
      if (messages) {
        messages.tokens += extra;
        messages.share = share(messages.tokens);
      } else used.push({ id: "messages", name: "Messages", tokens: extra, share: share(extra), color: categoryStyle({ id: "messages", kind: "used" }).color });
    }
    const total = used.reduce((sum, segment) => sum + segment.tokens, 0);
    return { used, buffer, total, window };
  }
  const tokens = session.contextTokens ?? 0;
  return {
    used: tokens ? [{ id: "used", name: "Used", tokens, share: share(tokens), color: "var(--color-accent)" }] : [],
    total: tokens,
    window,
  };
}

export function ContextStrip({ sessionKey }: { sessionKey: string }) {
  const context = useSession(sessionKey, (session) => session?.context);
  const contextTokens = useSession(sessionKey, (session) => session?.contextTokens);
  const contextWindow = useSession(sessionKey, (session) => session?.contextWindow);
  const panelOpen = useSession(sessionKey, (session) => session?.panel === "context");
  const { used, buffer, total, window } = useMemo(() => stripSegments({ context, contextTokens, contextWindow }), [context, contextTokens, contextWindow]);
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; segment?: StripSegment } | undefined>();

  // Total shares can exceed 1 just before compaction; scale them down to fit.
  const scale = Math.max(1, used.reduce((sum, segment) => sum + segment.share, 0) + (buffer?.share ?? 0));

  const onMove = (event: MouseEvent) => {
    const rect = bar.current?.getBoundingClientRect();
    if (!rect) return;
    const x = event.clientX - rect.left;
    const at = x / rect.width;
    let edge = 0;
    let segment: StripSegment | undefined;
    for (const candidate of used) {
      edge += candidate.share / scale;
      if (at <= edge) {
        segment = candidate;
        break;
      }
    }
    if (!segment && buffer && at >= 1 - buffer.share / scale) segment = buffer;
    setHover({ x, segment });
  };

  const percent = Math.round((total / window) * 100);
  const width = bar.current?.getBoundingClientRect().width ?? 0;
  return (
    <div
      className={`cc-strip${panelOpen ? " is-open" : ""}`}
      role="button"
      tabIndex={-1}
      aria-label={`Context: ${percent}% used. Open the context panel`}
      onClick={() => setPanel(sessionKey, "context")}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(undefined)}
    >
      <div ref={bar} className="cc-strip-bar">
        {used.map((segment) => (
          <span
            key={segment.id}
            className={`cc-strip-seg${hover?.segment === segment ? " is-hover" : ""}`}
            style={{ width: `${(segment.share / scale) * 100}%`, background: segment.color }}
          />
        ))}
        {buffer && (
          <span
            className={`cc-strip-seg cc-strip-buffer${hover?.segment === buffer ? " is-hover" : ""}`}
            style={{ width: `${(buffer.share / scale) * 100}%`, color: buffer.color }}
          />
        )}
      </div>
      {hover && (
        <div className="cc-strip-tip" style={{ left: Math.min(Math.max(hover.x, 90), Math.max(90, width - 90)) }} role="tooltip">
          {hover.segment ? (
            <>
              <span className={`cc-swatch${hover.segment.hatched ? " is-hatched" : ""}`} style={hover.segment.hatched ? { color: hover.segment.color } : { background: hover.segment.color }} />
              <span className="text-fg-soft">{hover.segment.name}</span>
              <span className="cc-num">{formatTokens(hover.segment.tokens)}</span>
              <span className="cc-num text-fg-faint">{Math.round((hover.segment.tokens / window) * 100)}%</span>
            </>
          ) : (
            <>
              <span className="text-fg-soft">{total ? "Free space" : "Context"}</span>
              <span className="cc-num">
                {formatTokens(total)} of {formatTokens(window)}
              </span>
              <span className="cc-num text-fg-faint">{percent}%</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
