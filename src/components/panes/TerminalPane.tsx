import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { registerPaneActions } from "../../commands/registry";
import { registerPaneFocuser } from "../../layout/dock";
import type { BlocksSnapshot } from "../../terminal/blocks";
import type { TerminalSession } from "../../terminal/session";
import { acquireSession, releaseSession } from "../../terminal/sessions";
import { type TerminalMode, useTerminalSettings } from "../../terminal/settings";
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

/**
 * Shows a pane's terminal. The terminal itself is owned by the session
 * registry, not this component: mounting only puts the session's element on
 * screen, so the shell and its scrollback survive tab switches and re-docks.
 *
 * In blocks mode the terminal stays in place, sized as usual but invisible,
 * and `BlocksView` is drawn over it, except while a full-screen program
 * has the alternate screen, or when the shell turned out to have no
 * integration (no OSC 133 marks).
 */
export function TerminalPane({ paneId, mode }: { paneId: string; mode?: TerminalMode }) {
  const ref = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [session, setSession] = useState<TerminalSession | null>(null);
  // Set before the focuser is registered, which may call it at once.
  const sessionRef = useRef<TerminalSession | null>(null);
  const defaultMode = useTerminalSettings().terminalMode;
  const snapshot = useSyncExternalStore(
    session?.blocks.subscribe ?? noSubscribe,
    session?.blocks.snapshot ?? (() => NO_BLOCKS),
  );

  // Find (⌘F) searches the terminal's scrollback; blocks mode shows it classic meanwhile.
  const [finding, setFinding] = useState<number | null>(null);
  const findStep = useRef<((backwards: boolean) => void) | null>(null);

  const findInputRef = useRef<HTMLInputElement>(null);

  // Blocks mode applies; while Find is open the view stays mounted (keeping
  // the input editor's draft) but hidden, and the classic terminal shows.
  const blocksMode =
    (mode ?? defaultMode) === "blocks" && snapshot.integration !== "absent" && !snapshot.altScreen;
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
