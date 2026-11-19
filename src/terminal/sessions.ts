import { closePaneNow, updatePaneData } from "../actions";
import { homeDirectory } from "../ipc/system";
import { useSettings } from "../settings/settings";
import { findPane, listPanes } from "../state/layout";
import { findTabOfPane, selectAllPanes, useAppStore } from "../state/store";
import { TerminalSession } from "./session";
import { terminalTitle } from "./titles";

/*
 * Registry of live terminal sessions, keyed by pane id.
 *
 * Sessions are created on demand by TerminalPane and are never disposed by
 * it. Instead they are reconciled against the store: a session ends when no
 * terminal pane with its id exists in any tab of any workspace. That one
 * rule covers closing a pane, a tab or a workspace, and changing a pane's
 * type, without each of those having to remember to clean up.
 */

const sessions = new Map<string, TerminalSession>();
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

export function acquireSession(paneId: string): TerminalSession {
  let session = sessions.get(paneId);
  if (!session) {
    const tab = findTabOfPane(useAppStore.getState(), paneId);
    const savedCwd = tab && findPane(tab.layout, paneId)?.data.cwd;
    session = new TerminalSession(paneId, {
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
        scheduleTitles();
      },
      onForegroundChange: (changed) => {
        if (sessions.get(changed.paneId) === changed) scheduleTitles();
      },
    }, savedCwd);
    sessions.set(paneId, session);
    const input = startupInput.get(paneId);
    startupInput.delete(paneId);
    if (input) session.input(input);
  }
  return session;
}

/** Takes a session off screen; it ends only if its pane is gone. */
export function releaseSession(session: TerminalSession): void {
  session.detach();
  scheduleReconcile();
}

function reconcile(): void {
  const live = new Set(
    selectAllPanes(useAppStore.getState())
      .filter((pane) => pane.data.kind === "terminal")
      .map((pane) => pane.id),
  );
  for (const [paneId, session] of sessions) {
    // An on-screen session belongs to a mounted pane, which may be newer
    // than the store (a split mounts before its layout change is recorded).
    if (live.has(paneId) || session.isAttached) continue;
    sessions.delete(paneId);
    session.dispose();
  }
}

let reconcileTimer: ReturnType<typeof setTimeout> | undefined;

// Deferred so that a pane which is only remounting (React StrictMode, a
// layout remount, a move between tabs) is back on screen before we look.
function scheduleReconcile(): void {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(reconcile, 0);
}

/*
 * Automatic tab titles: each tab is named after its active pane's terminal
 * (see `terminalTitle`), unless the user named it. Recomputed when a
 * terminal's program or directory changes, and on any store change (the
 * active pane may have moved); `setAutoTitle` ignores unchanged titles.
 */

function updateTitles(): void {
  const state = useAppStore.getState();
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.titleLocked) continue;
      const pane =
        (tab.activePaneId && findPane(tab.layout, tab.activePaneId)) || listPanes(tab.layout)[0];
      if (!pane || pane.data.kind !== "terminal") continue;
      const session = sessions.get(pane.id);
      const title = terminalTitle(session?.foregroundProgram ?? null, session?.cwd ?? pane.data.cwd, homeDirectory());
      if (title) state.setAutoTitle(tab.id, title);
    }
  }
}

let titlesQueued = false;

function scheduleTitles(): void {
  if (titlesQueued) return;
  titlesQueued = true;
  queueMicrotask(() => {
    titlesQueued = false;
    updateTitles();
  });
}

// Settings apply to every live terminal at once.
useSettings.subscribe((settings, previous) => {
  if (settings === previous) return;
  for (const session of sessions.values()) session.applySettings(settings);
});

useAppStore.subscribe(() => {
  scheduleReconcile();
  scheduleTitles();
});

/** Number of live sessions (for tests and diagnostics). */
export function sessionCount(): number {
  return sessions.size;
}

/** The pane's live session, if it has one (for tests and diagnostics). */
export function peekSession(paneId: string): TerminalSession | undefined {
  return sessions.get(paneId);
}
