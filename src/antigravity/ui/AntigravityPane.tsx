import { ArrowDown, KeyRound, RotateCcw, Terminal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { displayPath } from "../../explorer/tree";
import { homeDirectory } from "../../ipc/system";
import type { PaneProps } from "../../plugins/types";
import { commandList, startNewSession } from "../commands";
import {
  acquirePaneSession,
  interrupt,
  reconnectSession,
  runLoginInTerminal,
  setCwd,
  setPanel,
  useAntigravityStore,
  useSession,
} from "../store";
import type { AntigravityPaneData, PendingElicitation, PendingPermission, TranscriptItem } from "../types";
import { AntigravityMark } from "./AntigravityMark";
import { Composer, insertIntoComposer } from "./Composer";
import { ContextStrip } from "./ContextStrip";
import { formatElapsed } from "./format";
import { Header, pickFolder } from "./Header";
import { SidePanel } from "./panels/SidePanel";
import { ElicitationPrompt, PermissionPrompt } from "./PermissionPrompt";
import { PlanBar } from "./PlanBar";
import { useNow } from "./ToolCall";
import { Transcript } from "./Transcript";

/*
 * The Antigravity ACP pane: header, 3px context meter strip, timeline
 * transcript (or empty state), inline permission/elicitation prompts, pinned
 * PlanBar, Composer, and 4-tab right drawer.
 */

const NARROW = 720;
const NO_ITEMS: TranscriptItem[] = [];
const NO_PERMS: PendingPermission[] = [];
const NO_ELICS: PendingElicitation[] = [];
const STARTERS = ["plan", "review", "history", "status"];

function EmptyState({ sessionKey }: { sessionKey: string }) {
  const cwd = useSession(sessionKey, (s) => s?.cwd ?? "");
  const availableCommands = useSession(sessionKey, (s) => s?.availableCommands ?? []);
  const commands = commandList({ availableCommands, cwd });
  const starters = [
    ...STARTERS.flatMap((name) => commands.filter((c) => c.name === name)),
    ...commands,
  ]
    .filter((cmd, idx, all) => all.indexOf(cmd) === idx)
    .slice(0, 3);

  return (
    <div className="ag-empty">
      <AntigravityMark size={24} />
      <div className="ag-empty-title">
        Antigravity in{" "}
        <button
          type="button"
          className="ag-empty-folder"
          title="Change the folder"
          onClick={async () => {
            const picked = await pickFolder(cwd);
            if (picked) setCwd(sessionKey, picked);
          }}
        >
          {displayPath(cwd, homeDirectory())}
        </button>
      </div>
      <p className="ag-empty-text">
        Connected over ACP (<code className="ag-mono">agy acp</code>). Mention files with <code className="ag-mono">@</code>, run commands with{" "}
        <code className="ag-mono">/</code>, and click any diff or path to open it in Midterm.
      </p>
      <div className="ag-starters">
        {starters.map((cmd) => (
          <button
            key={cmd.name}
            type="button"
            className="ag-starter"
            onClick={() => insertIntoComposer(sessionKey, `/${cmd.name}${cmd.argumentHint ? " " : ""}`)}
          >
            <span className="ag-mono text-fg-soft">/{cmd.name}</span>
            <span className="ag-starter-desc">{cmd.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Working({ sessionKey }: { sessionKey: string }) {
  const started = useSession(sessionKey, (s) => s?.turnStartedAt);
  const waiting = useSession(sessionKey, (s) => (s?.permissions.length ?? 0) > 0 || (s?.elicitations.length ?? 0) > 0);
  const now = useNow(true);
  if (waiting) return null;
  return (
    <div className="ag-working" aria-live="polite">
      <span className="ag-live-dot" />
      <span className="ag-shimmer">Working</span>
      {started && <span className="ag-num text-fg-faint">{formatElapsed(Math.max(0, now - started)) || "0.0s"}</span>}
      <button type="button" className="ag-link" onClick={() => void interrupt(sessionKey)}>
        esc to interrupt
      </button>
    </div>
  );
}

function useStickToBottom(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      stuck.current = atBottom;
      setAway(!atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, deps);
  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    stuck.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  return { away, toBottom };
}

export function AntigravityPane({ paneId, data, ctx }: PaneProps) {
  const pane = data as unknown as AntigravityPaneData;
  useEffect(() => acquirePaneSession(paneId, pane), [paneId]);
  const key = useAntigravityStore((s) => s.panes[paneId]);
  if (!key) return <div className="ag-pane" />;
  return <PaneBody key={key} sessionKey={key} ctx={ctx} />;
}

function PaneBody({ sessionKey, ctx }: { sessionKey: string; ctx: PaneProps["ctx"] }) {
  const items = useSession(sessionKey, (s) => s?.items ?? NO_ITEMS);
  const status = useSession(sessionKey, (s) => s?.status);
  const error = useSession(sessionKey, (s) => s?.error);
  const authRequired = useSession(sessionKey, (s) => s?.authRequired === true);
  const panel = useSession(sessionKey, (s) => s?.panel);
  const permissions = useSession(sessionKey, (s) => s?.permissions ?? NO_PERMS);
  const elicitations = useSession(sessionKey, (s) => s?.elicitations ?? NO_ELICS);
  const tools = useSession(sessionKey, (s) => s?.tools);
  const cwd = useSession(sessionKey, (s) => s?.cwd ?? "");

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [width, setWidth] = useState(1000);

  useEffect(() => ctx.onFocusRequest(() => inputRef.current?.focus({ preventScroll: true })), [ctx]);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { away, toBottom } = useStickToBottom(scrollerRef, [items, permissions, elicitations, status]);
  const orphanPermissions = permissions.filter((p) => !tools?.[p.toolCall.toolCallId]);
  const empty = items.length === 0 && status !== "running" && status !== "starting";
  const overlay = width < NARROW;

  return (
    <div ref={rootRef} className={`ag-pane${overlay ? " is-narrow" : ""}`}>
      <Header sessionKey={sessionKey} />
      <ContextStrip sessionKey={sessionKey} />
      <div className="ag-body">
        <div className="ag-main">
          <div ref={scrollerRef} className="ag-scroll">
            <div className="ag-column">
              {empty ? (
                <EmptyState sessionKey={sessionKey} />
              ) : (
                <>
                  <Transcript sessionKey={sessionKey} items={items} />
                  {orphanPermissions.map((req) => (
                    <div key={String(req.rpcId)} className="ag-rail">
                      <div className="ag-item" data-dot="asking">
                        <span className="ag-dot" aria-hidden="true" />
                        <PermissionPrompt sessionKey={sessionKey} request={req} cwd={cwd} />
                      </div>
                    </div>
                  ))}
                  {elicitations.map((el) => (
                    <div key={String(el.rpcId)} className="ag-rail">
                      <div className="ag-item" data-dot="asking">
                        <span className="ag-dot" aria-hidden="true" />
                        <ElicitationPrompt sessionKey={sessionKey} item={el} />
                      </div>
                    </div>
                  ))}
                  {status === "running" && <Working sessionKey={sessionKey} />}
                </>
              )}
            </div>
          </div>

          <div className="ag-dock">
            {away && !empty && (
              <button type="button" className="ag-jump" title="Scroll to latest" aria-label="Scroll to latest" onClick={toBottom}>
                <ArrowDown size={12} />
              </button>
            )}
            {status === "error" && authRequired && (
              <div className="ag-auth-banner" role="alert">
                <KeyRound size={13} className="text-warn flex-none" />
                <span className="ag-error-text">{error ?? "Sign in to Antigravity to continue."}</span>
                <button type="button" className="ag-button is-primary" onClick={() => runLoginInTerminal(sessionKey)}>
                  <Terminal size={11} /> Sign in (`agy acp --login`)
                </button>
                <button type="button" className="ag-button" onClick={() => void reconnectSession(sessionKey)}>
                  <RotateCcw size={11} /> Retry
                </button>
              </div>
            )}
            {status === "error" && !authRequired && (
              <div className="ag-error" role="alert">
                <span className="ag-error-text">{error ?? "Antigravity stopped."}</span>
                <button type="button" className="ag-link" onClick={() => void reconnectSession(sessionKey)}>
                  <RotateCcw size={10} /> Reconnect
                </button>
                <button type="button" className="ag-link" onClick={() => void startNewSession(sessionKey)}>
                  New session
                </button>
              </div>
            )}
            <PlanBar sessionKey={sessionKey} />
            <Composer sessionKey={sessionKey} inputRef={inputRef} />
          </div>
        </div>

        {panel && (
          <>
            {overlay && <div className="ag-scrim" onClick={() => setPanel(sessionKey, undefined)} />}
            <SidePanel sessionKey={sessionKey} overlay={overlay} />
          </>
        )}
      </div>
    </div>
  );
}
