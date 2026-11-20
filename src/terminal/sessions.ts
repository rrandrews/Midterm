import { closePaneNow, updatePaneData } from "../actions";
import { homeDirectory } from "../ipc/system";
import { createPaneState } from "../plugins/paneState";
import { refreshTabTitles } from "../plugins/tabTitles";
import { useSettings } from "../settings/settings";
import { subscribeThemeApplied } from "../theme/state";
import { findPane } from "../state/layout";
import { findTabOfPane, useAppStore } from "../state/store";
import type { PaneNode } from "../state/types";
import { TerminalSession } from "./session";
import { type TerminalData, terminalConfig } from "./settings";
import { terminalTitle } from "./titles";
import { CLASSIC_TERMINAL, isSessionKind } from "./kinds";
import { getSettings } from "../settings/settings";
import { activePlugin } from "../plugins/registry";

/*
 * Live terminal sessions, keyed by pane id (a shared pane state, see
 * src/plugins/paneState.ts): created on demand by TerminalPane, never
 * disposed by it, and ended once no terminal pane with their id is left in
 * any tab of any workspace and nothing shows them.
 */

// Kept while the pane is either terminal kind, so switching between the
// classic and block terminal keeps the shell.
const sessions = createPaneState<TerminalSession>({
  isLive: (pane) => isSessionKind(pane.data.kind),
  dispose: (session) => session.dispose(),
});
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
      if (isSessionKind(pane?.data.kind)) closePaneNow(exited.paneId);
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

// Settings and the theme apply to every live terminal at once.
let lastConfig = JSON.stringify(terminalConfig());
function applyConfig(): void {
  const config = terminalConfig();
  const json = JSON.stringify(config);
  if (json === lastConfig) return;
  lastConfig = json;
  for (const [, session] of sessions.entries()) session.applySettings(config);
}
useSettings.subscribe(applyConfig);
subscribeThemeApplied(applyConfig);

/**
 * The kind of a new pane that is sent a command (`queueStartupInput`): the
 * default terminal if it is a built-in one (only those have a session to
 * queue into), else the classic terminal.
 */
export function commandTerminalKind(): string {
  const kind = getSettings().defaultTerminal;
  return isSessionKind(kind) && activePlugin(kind) ? kind : CLASSIC_TERMINAL;
}

/** Number of live sessions (for tests and diagnostics). */
export function sessionCount(): number {
  return sessions.entries().length;
}

/** The pane's live session, if it has one. */
export function peekSession(paneId: string): TerminalSession | undefined {
  return sessions.get(paneId);
}
