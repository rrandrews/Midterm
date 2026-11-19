import { closePaneNow, updatePaneData } from "../actions";
import { homeDirectory } from "../ipc/system";
import { createPaneState } from "../plugins/paneState";
import { refreshTabTitles } from "../plugins/tabTitles";
import { useSettings } from "../settings/settings";
import { findPane } from "../state/layout";
import { findTabOfPane, useAppStore } from "../state/store";
import type { PaneNode } from "../state/types";
import { TerminalSession } from "./session";
import { type TerminalData, terminalConfig } from "./settings";
import { terminalTitle } from "./titles";

/*
 * Live terminal sessions, keyed by pane id (a shared pane state, see
 * src/plugins/paneState.ts): created on demand by TerminalPane, never
 * disposed by it, and ended once no terminal pane with their id is left in
 * any tab of any workspace and nothing shows them.
 */

const sessions = createPaneState<TerminalSession>({ kind: "terminal", dispose: (session) => session.dispose() });
/** Input to type into a pane's shell as soon as its session exists (e.g. a command to run). */
const startupInput = new Map<string, string>();

/**
 * Types `data` into the pane's shell once it starts (queued like early
 * keystrokes). For a pane that is about to be created.
 */
export function queueStartupInput(paneId: string, data: string): void {
  const session = sessions.get(paneId);
  if (session) session.input(data);
  else startupInput.set(paneId, (startupInput.get(paneId) ?? "") + data);
}

function createSession(paneId: string): TerminalSession {
  const tab = findTabOfPane(useAppStore.getState(), paneId);
  const savedCwd = tab && (findPane(tab.layout, paneId)?.data as TerminalData | undefined)?.cwd;
  const session = new TerminalSession(paneId, {
    onExit: (exited) => {
      // Only the pane's current session, and only while it is still a
      // terminal: the pane may have changed kind since this shell started.
      if (sessions.get(exited.paneId) !== exited) return;
      const tab = findTabOfPane(useAppStore.getState(), exited.paneId);
      const pane = tab && findPane(tab.layout, exited.paneId);
      if (pane?.data.kind === "terminal") closePaneNow(exited.paneId);
    },
    onBackgroundOutput: ({ paneId: id }) => {
      const state = useAppStore.getState();
      const tab = findTabOfPane(state, id);
      if (tab) state.markActivity(tab.id);
    },
    onCwdChange: (changed, cwd) => {
      if (sessions.get(changed.paneId) !== changed) return;
      updatePaneData(changed.paneId, { cwd });
      refreshTabTitles();
    },
    onForegroundChange: (changed) => {
      if (sessions.get(changed.paneId) === changed) refreshTabTitles();
    },
  }, typeof savedCwd === "string" ? savedCwd : undefined);
  const input = startupInput.get(paneId);
  startupInput.delete(paneId);
  if (input) session.input(input);
  return session;
}

/** The pane's session, created if needed, for a mounted component (which calls `releaseSession` when done). */
export function acquireSession(paneId: string): TerminalSession {
  return sessions.acquire(paneId, () => createSession(paneId));
}

/** Takes a session off screen; it ends only if its pane is gone. */
export function releaseSession(session: TerminalSession): void {
  session.detach();
  sessions.release(session.paneId, session);
}

/** The title of a tab whose active pane is this terminal: its program, or its directory. */
export function terminalTabTitle(pane: PaneNode): string | undefined {
  const session = sessions.get(pane.id);
  const cwd = session?.cwd ?? (pane.data as TerminalData).cwd;
  return terminalTitle(session?.foregroundProgram ?? null, cwd, homeDirectory()) || undefined;
}

// Settings apply to every live terminal at once.
let lastConfig = terminalConfig();
useSettings.subscribe(() => {
  const config = terminalConfig();
  if (JSON.stringify(config) === JSON.stringify(lastConfig)) return;
  lastConfig = config;
  for (const [, session] of sessions.entries()) session.applySettings(config);
});

/** Number of live sessions (for tests and diagnostics). */
export function sessionCount(): number {
  return sessions.entries().length;
}

/** The pane's live session, if it has one. */
export function peekSession(paneId: string): TerminalSession | undefined {
  return sessions.get(paneId);
}
