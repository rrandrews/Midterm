import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { registerPaneActions } from "../../commands/registry";
import { registerPaneFocuser } from "../../layout/dock";
import type { BlocksSnapshot } from "../../terminal/blocks";
import { runsFullPane } from "../../terminal/fullPane";
import {
  type PathTarget,
  canChangeDirectory,
  currentTip,
  displayPath,
  hideTip,
  pathMenuItems,
  pathUnderPointer,
  subscribeTip,
} from "../../terminal/pathTargets";
import { MenuItems } from "../../plugins/MenuItems";
import { Menu, MenuContent, MenuTrigger } from "../ui/Menu";
import { AnchoredTip } from "../ui/Tooltip";
import type { TerminalSession } from "../../terminal/session";
import { acquireSession, releaseSession } from "../../terminal/sessions";
import { useBlockTerminalSettings } from "../../terminal/settings";
import { BlocksView } from "./BlocksView";
import { TerminalFindBar } from "./TerminalFindBar";

const NO_BLOCKS: BlocksSnapshot = {
  integration: "pending",
  phase: "running",
  altScreen: false,
  blocks: [],
  nested: false,
  location: {},
};
const noSubscribe = () => () => {};
const noForeground = () => undefined;

/**
 * Shows a pane's terminal. The terminal itself is owned by the session
 * registry, not this component: mounting only puts the session's element on
 * screen, so the shell and its scrollback survive tab switches and re-docks.
 *
 * With `blocks` (the block terminal) the terminal stays in place, sized as usual but invisible,
 * and `BlocksView` is drawn over it, except while a full-screen program
 * has the alternate screen or a program listed in "Run full-pane" runs, or
 * when the shell turned out to have no integration (no OSC 133 marks).
 */
export function TerminalPane({ paneId, blocks }: { paneId: string; blocks: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [session, setSession] = useState<TerminalSession | null>(null);
  // Set before the focuser is registered, which may call it at once.
  const sessionRef = useRef<TerminalSession | null>(null);
  const snapshot = useSyncExternalStore(
    session?.blocks.subscribe ?? noSubscribe,
    session?.blocks.snapshot ?? (() => NO_BLOCKS),
  );

  // A program listed to run full-pane: known from the command line at once,
  // or from the foreground process once it is looked up.
  const { fullPanePrograms } = useBlockTerminalSettings();
  const foregroundName = useSyncExternalStore(
    session?.subscribeForeground ?? noSubscribe,
    session ? () => session.effectiveForeground?.name : noForeground,
  );
  const running = snapshot.phase === "running" ? snapshot.blocks[snapshot.blocks.length - 1] : undefined;
  const fullPane =
    blocks &&
    runsFullPane({
      programs: fullPanePrograms,
      command: running && running.end === undefined ? running.command : undefined,
      foregroundName,
    });

  // Find (⌘F) searches the terminal's scrollback; blocks mode shows it classic meanwhile.
  const [finding, setFinding] = useState<number | null>(null);
  const findStep = useRef<((backwards: boolean) => void) | null>(null);

  const findInputRef = useRef<HTMLInputElement>(null);

  // Blocks mode applies; while Find is open the view stays mounted (keeping
  // the input editor's draft) but hidden, and the classic terminal shows.
  const blocksMode = blocks && snapshot.integration !== "absent" && !snapshot.altScreen && !fullPane;
  const showBlocks = blocksMode && finding === null;
  const editorActive = showBlocks && snapshot.integration === "present" && snapshot.phase === "prompt";

  // The keyboard goes to the find field while it is open, else to the input
  // editor at a prompt in blocks mode, else to the terminal.
  const focusTarget = useRef(() => {});
  focusTarget.current = () => {
    if (findInputRef.current) findInputRef.current.focus();
    else if (editorActive && inputRef.current) inputRef.current.focus();
    else sessionRef.current?.focus();
  };
  /** Whether the keyboard is in this pane (kept while the focused element is hidden). */
  const hasFocus = useRef(false);
  /** The right-clicked file or folder in the output, and where its menu opens. */
  const [pathMenu, setPathMenu] = useState<{ target: PathTarget; x: number; y: number } | null>(null);
  /**
   * The link under a right button press, taken before xterm sees the press:
   * it moves its text field under the pointer, which ends the link's hover
   * before the `contextmenu` event arrives.
   */
  const pressedPath = useRef<PathTarget | undefined>(undefined);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const acquired = acquireSession(paneId);
    acquired.attach(container);
    sessionRef.current = acquired;
    setSession(acquired);
    const unregister = registerPaneFocuser(paneId, () => focusTarget.current());
    const unregisterActions = registerPaneActions(paneId, {
      find: () => setFinding((token) => (token ?? 0) + 1),
      findNext: () => (findStep.current ? findStep.current(false) : setFinding(1)),
      findPrevious: () => (findStep.current ? findStep.current(true) : setFinding(1)),
    });
    return () => {
      unregister();
      unregisterActions();
      releaseSession(acquired);
    };
  }, [paneId]);

  // Hand the keyboard over when the target changes (a command starts or
  // ends, the mode changes) while this pane has it.
  useEffect(() => {
    if (hasFocus.current) focusTarget.current();
  }, [editorActive, showBlocks]);

  return (
    <div
      ref={wrapRef}
      className="terminal-wrap"
      onFocusCapture={() => {
        hasFocus.current = true;
      }}
      // A right click on a file or folder in the output opens its own menu
      // instead of the pane's (preventing the default keeps the pane's
      // closed), unless a program reading the mouse gets the click.
      onContextMenu={(event) => {
        hideTip();
        const target = pressedPath.current ?? pathUnderPointer(paneId, event.target);
        pressedPath.current = undefined;
        if (!target || (session?.wantsMouse && !event.altKey)) return;
        event.preventDefault();
        setPathMenu({ target, x: event.clientX, y: event.clientY });
      }}
      onPointerDownCapture={(event) => {
        hideTip();
        // A right button press, or ⌃-click (the right click of macOS).
        const secondary = event.button === 2 || (event.button === 0 && event.ctrlKey);
        pressedPath.current = secondary ? pathUnderPointer(paneId, event.target) : undefined;
      }}
      onWheelCapture={hideTip}
      onKeyDownCapture={hideTip}
      onBlurCapture={(event) => {
        const next = event.relatedTarget as Node | null;
        // Focus moving to nothing is an element being hidden (or the window losing focus).
        if (next && !wrapRef.current?.contains(next)) hasFocus.current = false;
      }}
    >
      <div ref={ref} className={`terminal-pane${showBlocks ? " is-covered" : ""}`} />
      {session && finding !== null && (
        <TerminalFindBar
          session={session}
          focusToken={finding}
          stepRef={findStep}
          inputRef={findInputRef}
          onClose={() => {
            findStep.current = null;
            setFinding(null);
            requestAnimationFrame(() => focusTarget.current());
          }}
        />
      )}
      {pathMenu && (
        <Menu open onOpenChange={(open) => !open && setPathMenu(null)}>
          {createPortal(
            <MenuTrigger asChild>
              <span aria-hidden style={{ position: "fixed", left: pathMenu.x, top: pathMenu.y, width: 0, height: 0 }} />
            </MenuTrigger>,
            document.body,
          )}
          <MenuContent align="start" side="bottom" sideOffset={2} aria-label="File">
            <MenuItems items={pathMenuItems(paneId, pathMenu.target)} />
          </MenuContent>
        </Menu>
      )}
      {!pathMenu && <PathTip paneId={paneId} session={session} />}
      {session && blocksMode && (
        <BlocksView
          hidden={!showBlocks}
          session={session}
          snapshot={snapshot}
          inputRef={inputRef}
          onFocusRequest={() => focusTarget.current()}
        />
      )}
    </div>
  );
}

/** The tooltip of the hovered file or folder in this pane's output. */
function PathTip({ paneId, session }: { paneId: string; session: TerminalSession | null }) {
  const tip = useSyncExternalStore(subscribeTip, currentTip);
  if (!tip || tip.paneId !== paneId) return null;
  const dir = tip.target.kind === "dir";
  // Only what a click will do now: a program reading the mouse (classic view) gets plain clicks.
  const plain = !(session?.wantsMouse && tip.view === "terminal");
  const click = !plain ? null : dir ? (canChangeDirectory(paneId, tip.target.path) ? "Click to cd here" : null) : "Click to open";
  const hint = [click, dir ? "⌘-click: new explorer pane" : "⌘-click: new pane"].filter(Boolean).join(" · ");
  return (
    <AnchoredTip
      rect={tip.rect}
      content={
        <>
          <div className="break-all font-mono text-fg-bright">{displayPath(tip.target.path)}</div>
          <div className="mt-0.5 text-fg-dim">{hint}</div>
        </>
      }
    />
  );
}
