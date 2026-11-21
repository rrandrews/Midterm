import { ArrowDown, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { displayPath } from "../../explorer/tree";
import { homeDirectory } from "../../ipc/system";
import type { PaneProps } from "../../plugins/types";
import type { PermissionRequest } from "../protocol";
import { startNewSession } from "./actions";
import { acquirePaneSession, interrupt, setCwd, setPanel, useClaudeStore, useSession, type ClaudePaneData } from "../store";
import type { TranscriptItem } from "../types";
import { ClaudeMark } from "./ClaudeMark";
import { Composer, insertIntoComposer, sessionCommands } from "./Composer";
import { ContextStrip } from "./ContextStrip";
import { formatElapsed } from "./format";
import { Header } from "./Header";
import { PermissionPrompt } from "./PermissionPrompt";
import { SidePanel } from "./panels/SidePanel";
import { pickFolder } from "./pickFolder";
import { Todos } from "./Todos";
import { useNow } from "./ToolCall";
import { Transcript } from "./Transcript";

/*
 * The Claude Code pane: header, context strip, then the transcript (or the
 * empty state), the pinned to-dos and the composer, with the side panel as
 * a drawer on the right (over the transcript when the pane is narrow).
 */

const NARROW = 720;
const NO_ITEMS: TranscriptItem[] = [];
const NO_PERMISSIONS: PermissionRequest[] = [];

const STARTERS = ["init", "review", "security-review", "context", "compact"];

function EmptyState({ sessionKey }: { sessionKey: string }) {
  const cwd = useSession(sessionKey, (session) => session?.cwd ?? "");
  const init = useSession(sessionKey, (session) => session?.init);
  const commands = sessionCommands({ init });
  const starters = [...STARTERS.flatMap((name) => commands.filter((command) => command.name === name)), ...commands].filter((command, index, all) => all.indexOf(command) === index).slice(0, 3);
  return (
    <div className="cc-empty">
      <ClaudeMark size={22} />
      <div className="cc-empty-title">
        Claude Code in{" "}
        <button
          type="button"
          className="cc-empty-folder"
          title="Change the folder"
          onClick={async () => {
            const picked = await pickFolder(cwd);
            if (picked) setCwd(sessionKey, picked);
          }}
        >
          {displayPath(cwd, homeDirectory())}
        </button>
      </div>
      <p className="cc-empty-text">Ask about this codebase, fix bugs, build features and run commands. Claude reads your files and asks before it changes anything.</p>
      <div className="cc-starters">
        {starters.map((command) => (
          <button key={command.name} type="button" className="cc-starter" onClick={() => insertIntoComposer(sessionKey, `/${command.name}${command.argumentHint ? " " : ""}`)}>
            <span className="cc-mono text-fg-soft">/{command.name}</span>
            <span className="cc-starter-desc">{command.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Working({ sessionKey }: { sessionKey: string }) {
  const started = useSession(sessionKey, (session) => session?.turnStartedAt);
  const compacting = useSession(sessionKey, (session) => session?.compacting);
  const waiting = useSession(sessionKey, (session) => (session?.permissions.length ?? 0) > 0);
  const now = useNow(true);
  if (waiting) return null;
  return (
    <div className="cc-working" aria-live="polite">
      <span className="cc-live-dot" />
      <span className="cc-shimmer">{compacting ? "Compacting" : "Working"}</span>
      {started && <span className="cc-num text-fg-faint">{formatElapsed(Math.max(0, now - started)) || "0.0s"}</span>}
      <button type="button" className="cc-link" onClick={() => void interrupt(sessionKey)}>
        esc to interrupt
      </button>
    </div>
  );
}

/** Keeps a scroll container at the bottom while content grows, unless the user scrolled up. */
function useStickToBottom(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onScroll = () => {
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      stuck.current = atBottom;
      setAway(!atBottom);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    // Content that grows without a render here (images, expanding cards) keeps the bottom too.
    const observer = new ResizeObserver(() => {
      if (stuck.current) element.scrollTop = element.scrollHeight;
    });
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [ref]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && stuck.current) element.scrollTop = element.scrollHeight;
  }, deps);
  const toBottom = () => {
    const element = ref.current;
    if (!element) return;
    stuck.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };
  return { away, toBottom };
}

export function ClaudePane({ paneId, data, ctx }: PaneProps) {
  const pane = data as unknown as ClaudePaneData;
  // Acquired once per pane; later data changes are the session's own (saved by the store).
  useEffect(() => acquirePaneSession(paneId, pane), [paneId]);
  const key = useClaudeStore((state) => state.panes[paneId]);
  if (!key) return <div className="cc-pane" />;
  return <PaneBody key={key} sessionKey={key} ctx={ctx} />;
}

function PaneBody({ sessionKey, ctx }: { sessionKey: string; ctx: PaneProps["ctx"] }) {
  const items = useSession(sessionKey, (session) => session?.items ?? NO_ITEMS);
  const status = useSession(sessionKey, (session) => session?.status);
  const error = useSession(sessionKey, (session) => session?.error);
  const panel = useSession(sessionKey, (session) => session?.panel);
  const permissions = useSession(sessionKey, (session) => session?.permissions ?? NO_PERMISSIONS);
  const tools = useSession(sessionKey, (session) => session?.tools);
  const cwd = useSession(sessionKey, (session) => session?.cwd ?? "");
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [width, setWidth] = useState(1000);

  useEffect(() => ctx.onFocusRequest(() => input.current?.focus({ preventScroll: true })), [ctx]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { away, toBottom } = useStickToBottom(scroller, [items, permissions, status]);
  // Prompts whose tool is not on the main timeline (a subagent's) show at the end.
  const orphans = permissions.filter((request) => !tools?.[request.toolUseId] || tools[request.toolUseId].parentToolUseId !== null);
  const empty = items.length === 0 && status !== "running" && status !== "starting";
  const overlay = width < NARROW;

  return (
    <div ref={root} className={`cc-pane${overlay ? " is-narrow" : ""}`}>
      <Header sessionKey={sessionKey} />
      <ContextStrip sessionKey={sessionKey} />
      <div className="cc-body">
        <div className="cc-main">
          <div ref={scroller} className="cc-scroll">
            <div className="cc-column">
              {empty ? (
                <EmptyState sessionKey={sessionKey} />
              ) : (
                <>
                  <Transcript sessionKey={sessionKey} items={items} />
                  {orphans.map((request) => (
                    <div key={request.requestId} className="cc-rail">
                      <div className="cc-item" data-dot="asking">
                        <span className="cc-dot" aria-hidden="true" />
                        <PermissionPrompt sessionKey={sessionKey} request={request} cwd={cwd} />
                      </div>
                    </div>
                  ))}
                  {status === "running" && <Working sessionKey={sessionKey} />}
                </>
              )}
            </div>
          </div>
          <div className="cc-dock">
            {away && !empty && (
              <button type="button" className="cc-jump" title="Scroll to the latest" aria-label="Scroll to the latest" onClick={toBottom}>
                <ArrowDown size={12} />
              </button>
            )}
            {status === "error" && (
              <div className="cc-error" role="alert">
                <span className="cc-error-text">{error ?? "Claude Code stopped."} Your next message resumes the session.</span>
                <button type="button" className="cc-link" onClick={() => void startNewSession(sessionKey)}>
                  <RotateCcw size={10} /> New session
                </button>
              </div>
            )}
            <Todos sessionKey={sessionKey} />
            <Composer sessionKey={sessionKey} inputRef={input} />
          </div>
        </div>
        {panel && (
          <>
            {overlay && <div className="cc-scrim" onClick={() => setPanel(sessionKey, undefined)} />}
            <SidePanel sessionKey={sessionKey} overlay={overlay} />
          </>
        )}
      </div>
    </div>
  );
}
