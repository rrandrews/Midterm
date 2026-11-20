import { ClipboardCopy, Copy, RotateCw, Sparkles, Wrench } from "lucide-react";
import { fixBlock } from "../../ai/blockAi";
import { explainBlock, pruneNotes } from "../../ai/blockNotes";
import { featureReady } from "../../ai/profiles";
import { useSettings } from "../../settings/settings";
import { useThemeRevision } from "../../theme/state";
import { type CSSProperties, type RefObject, memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { homeDirectory } from "../../ipc/system";
import { type Line, type Run, formatDuration, logicalLines, renderRows } from "../../terminal/blockRender";
import {
  canReplay,
  copyBlockCommand,
  copyBlockOutput,
  replayBlock,
  setContextBlock,
} from "../../terminal/blockMode";
import { type Block, type BlocksSnapshot, outputRows, scopeOf } from "../../terminal/blocks";
import { branchOf } from "../../terminal/gitBranch";
import type { TerminalSession } from "../../terminal/session";
import { BlockInput } from "./BlockInput";
import { BlockNote } from "./BlockNote";

/** Output lines a finished block shows before "Show earlier lines". */
const INITIAL_LINES = 300;
/** Lines each "Show earlier lines" adds. */
const MORE_LINES = 2000;
/** Rows of a running command drawn live (the end of its output). */
const LIVE_ROWS = 500;

/**
 * Blocks mode: every command the shell ran as a block (header with its
 * directory, branch, exit status and duration; the command; its output),
 * oldest at the top and bottom-aligned, with the input editor below.
 *
 * Everything shown is read from the terminal's buffer, which keeps
 * running underneath (hidden) and stays the source of truth. While a
 * command runs, keys go to that hidden terminal and the block redraws
 * live; at a prompt, the input editor has the keyboard.
 */
export function BlocksView({
  session,
  snapshot,
  inputRef,
  onFocusRequest,
  hidden = false,
}: {
  session: TerminalSession;
  snapshot: BlocksSnapshot;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onFocusRequest: () => void;
  /** Kept mounted but not shown (the input editor keeps its draft), e.g. while Find is open. */
  hidden?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const atPrompt = snapshot.integration === "present" && snapshot.phase === "prompt";

  // Stay scrolled to the bottom as blocks grow, unless the user scrolled up.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    const stick = () => {
      if (stuck.current) scroller.scrollTop = scroller.scrollHeight;
    };
    stick();
    const observer = new ResizeObserver(stick);
    observer.observe(list);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    // Running a command always brings its block into view.
    if (snapshot.phase === "running") stuck.current = true;
    const scroller = scrollRef.current;
    if (scroller && stuck.current) scroller.scrollTop = scroller.scrollHeight;
  }, [snapshot]);

  // A nested shell (over ssh) is somewhere else: its own report, never the pane's cwd.
  const where = snapshot.nested ? snapshot.location : { cwd: session.cwd };
  // Never looked up here for a nested shell: even reporting this host, it may be another machine.
  const branch = useBranch(snapshot.nested ? undefined : where.cwd, snapshot.blocks.length + (atPrompt ? 1 : 0));
  const promptScope = scopeOf(snapshot.nested, snapshot.location);
  const aiReady = useSettings((state) => featureReady("explain", state));

  // AI notes of blocks that are gone (cleared, out of the scrollback) go too.
  useEffect(() => {
    pruneNotes(
      session.paneId,
      snapshot.blocks.map((block) => block.id),
    );
  }, [session, snapshot]);

  return (
    <div
      className="blocks-view"
      style={hidden ? { display: "none" } : undefined}
      onMouseUp={(event) => {
        // A click (not a selection, not a button) gives the keyboard back.
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        if (window.getSelection()?.isCollapsed !== false) onFocusRequest();
      }}
      onContextMenuCapture={() => setContextBlock(session.paneId, null)}
    >
      <div
        ref={scrollRef}
        className="blocks-scroll"
        onScroll={(event) => {
          const el = event.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
        }}
      >
        <div ref={listRef} className="blocks-list">
          {snapshot.blocks.map((block) =>
            block.end ? (
              <FinishedBlock
                key={block.id}
                session={session}
                block={block}
                branch={block.branch}
                // Only at a prompt of the same shell: "Run again" must not run a remote command here.
                runnable={atPrompt && canReplay(session, block)}
                aiReady={aiReady}
              />
            ) : (
              <RunningBlock key={block.id} session={session} block={block} branch={block.branch} />
            ),
          )}
        </div>
      </div>
      {atPrompt && (
        <BlockInput
          // A new editor (no draft, no history walk) when the prompt is
          // another shell's: ssh ended or started under it.
          key={promptScope}
          scope={promptScope}
          session={session}
          inputRef={inputRef}
          footer={(status) => (
            <div className="blocks-meta mt-1.5">
              <Location cwd={where.cwd} host={where.host} />
              {branch && <span className="truncate">{branch}</span>}
              <span className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
                {status}
                <span>⇥ accept · ⏎ run</span>
              </span>
            </div>
          )}
        />
      )}
    </div>
  );
}

const FinishedBlock = memo(function FinishedBlock({
  session,
  block,
  branch,
  runnable,
  aiReady,
}: {
  session: TerminalSession;
  block: Block;
  branch: string | null | undefined;
  runnable: boolean;
  /** The `explain` feature has a ready model: Explain and Fix show. */
  aiReady: boolean;
}) {
  const [limit, setLimit] = useState(INITIAL_LINES);
  // Output is drawn with the theme's colors.
  const themeRevision = useThemeRevision();
  const { lines, hidden } = useMemo(() => {
    const buffer = session.blocks.buffer;
    const rows = outputRows(block, buffer);
    if (!rows) return { lines: [], hidden: 0 };
    const logical = logicalLines(buffer, rows.from, rows.to);
    const shown = logical.slice(-limit);
    const from = shown[0]?.[0] ?? rows.to;
    const rendered = renderRows(buffer, from, rows.to, { theme: session.theme, cols: session.cols, lastCells: rows.lastCells });
    // Blank lines at the end (a trailing newline before the prompt) are not output.
    while (rendered.length && rendered[rendered.length - 1].every((run) => !run.text.trim() && !run.bg)) rendered.pop();
    return { lines: rendered, hidden: logical.length - shown.length };
    // `themeRevision`: colors come from `session.theme`, which changes with the theme.
  }, [session, block, limit, themeRevision]);

  const failed = block.exitCode !== undefined && block.exitCode !== 0;
  const duration = block.endedAt !== undefined ? formatDuration(block.endedAt - block.startedAt) : "";
  const status = [block.exitCode !== undefined ? `exit ${block.exitCode}` : "", duration].filter(Boolean).join(" · ");

  return (
    <div className="block" onContextMenu={() => setContextBlock(session.paneId, block.id)}>
      <BlockHeader block={block} branch={branch}>
        <span className="block-actions">
          <ActionButton label="Copy command" onClick={() => copyBlockCommand(block)}>
            <Copy size={12} />
          </ActionButton>
          <ActionButton label="Copy output" onClick={() => copyBlockOutput(session, block)}>
            <ClipboardCopy size={12} />
          </ActionButton>
          <ActionButton
            label="Run again"
            disabled={!runnable || !block.command}
            onClick={() => replayBlock(session, block)}
          >
            <RotateCw size={12} />
          </ActionButton>
          {aiReady && (
            <>
              <ActionButton
                label={failed ? "Explain this error" : "Explain this output"}
                disabled={!block.command}
                onClick={() => explainBlock(session.paneId, block)}
              >
                <Sparkles size={12} />
              </ActionButton>
              <ActionButton
                label="Fix this command"
                disabled={!runnable || !failed}
                onClick={() => fixBlock(session.paneId, block)}
              >
                <Wrench size={12} />
              </ActionButton>
            </>
          )}
        </span>
        <span className={`shrink-0${failed ? " text-err" : ""}`}>{status}</span>
      </BlockHeader>
      <BlockCommand command={block.command} />
      {hidden > 0 && (
        <button type="button" className="block-more" onClick={() => setLimit((n) => n + MORE_LINES)}>
          Show {Math.min(hidden, MORE_LINES).toLocaleString()} earlier line{hidden === 1 ? "" : "s"}
          {hidden > MORE_LINES ? ` (${hidden.toLocaleString()} hidden)` : ""}
        </button>
      )}
      {block.truncated && hidden === 0 && <div className="block-note">Earlier output is no longer in the scrollback.</div>}
      <Output lines={lines} />
      <BlockNote paneId={session.paneId} block={block} />
    </div>
  );
});

function RunningBlock({ session, block, branch }: { session: TerminalSession; block: Block; branch: string | null | undefined }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const elapsed = useElapsed(block.startedAt);
  useThemeRevision();

  // Redraw at most once a frame while output arrives.
  useEffect(() => {
    let frame = 0;
    const off = session.blocks.onOutput(() => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        redraw();
      });
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, [session]);

  const buffer = session.blocks.buffer;
  const rows = outputRows(block, buffer);
  let lines: Line[] = [];
  if (rows) {
    const from = Math.max(rows.from, rows.to - LIVE_ROWS);
    lines = renderRows(buffer, from, rows.to, {
      theme: session.theme,
      cols: session.cols,
      cursor: { row: buffer.baseY + buffer.cursorY, col: buffer.cursorX },
    });
  }

  return (
    <div className="block is-running">
      <BlockHeader block={block} branch={branch}>
        <span className="shrink-0">running{elapsed >= 1000 ? ` · ${Math.floor(elapsed / 1000)}s` : ""}</span>
      </BlockHeader>
      <BlockCommand command={block.command} />
      <Output lines={lines} />
    </div>
  );
}

function BlockHeader({ block, branch, children }: { block: Block; branch: string | null | undefined; children: React.ReactNode }) {
  return (
    <div className="blocks-meta block-header">
      <Location cwd={block.cwd} host={block.host} />
      {branch && <span className="truncate">{branch}</span>}
      <span className="ml-auto" />
      {children}
    </div>
  );
}

function BlockCommand({ command }: { command: string }) {
  if (!command) return null;
  return (
    <div className="block-command">
      <span className="text-accent">❯</span> {command}
    </div>
  );
}

function ActionButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className="block-action" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

const Output = memo(function Output({ lines }: { lines: Line[] }) {
  if (!lines.length) return null;
  return (
    <div className="block-output">
      {lines.map((runs, i) => (
        <div key={i}>{runs.length ? runs.map((run, j) => <RunSpan key={j} run={run} />) : "​"}</div>
      ))}
    </div>
  );
});

function RunSpan({ run }: { run: Run }) {
  const style: CSSProperties = {};
  if (run.fg) style.color = run.fg;
  if (run.bg) style.backgroundColor = run.bg;
  if (run.bold) style.fontWeight = 600;
  if (run.italic) style.fontStyle = "italic";
  if (run.dim) style.opacity = 0.6;
  if (run.underline || run.strike) {
    style.textDecoration = [run.underline && "underline", run.strike && "line-through"].filter(Boolean).join(" ");
  }
  return (
    <span className={run.cursor ? "block-cursor" : undefined} style={style}>
      {run.text}
    </span>
  );
}

/** A directory, as `host:path` when it is on another machine. */
function Location({ cwd, host }: { cwd: string | undefined; host: string | undefined }) {
  if (!host) return cwd ? <span className="truncate">{displayPath(cwd)}</span> : null;
  return (
    <span className="truncate">
      <span className="block-host">{host}</span>:{cwd ?? "?"}
    </span>
  );
}

/** `~`-relative path for display (this machine's only). */
function displayPath(path: string): string {
  const home = homeDirectory();
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/** Milliseconds since `start` (a `performance.now()` time), updated every second. */
function useElapsed(start: number): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now - start;
}

/** The git branch of `cwd`, looked up again whenever `refresh` changes. */
function useBranch(cwd: string | undefined, refresh: number): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!cwd) setBranch(null);
    else void branchOf(cwd).then((found) => live && setBranch(found));
    return () => {
      live = false;
    };
  }, [cwd, refresh]);
  return branch;
}
