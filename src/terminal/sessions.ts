import { closePane } from "../actions";
import { findPane } from "../state/layout";
import { findTabOfPane, selectAllPanes, useAppStore } from "../state/store";
import { TerminalSession } from "./session";

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

export function acquireSession(paneId: string): TerminalSession {
  let session = sessions.get(paneId);
  if (!session) {
    session = new TerminalSession(paneId, {
      onExit: (exited) => {
        // Only the pane's current session, and only while it is still a
        // terminal: the pane may have changed kind since this shell started.
        if (sessions.get(exited.paneId) !== exited) return;
        const tab = findTabOfPane(useAppStore.getState(), exited.paneId);
        const pane = tab && findPane(tab.layout, exited.paneId);
        if (pane?.data.kind === "terminal") closePane(exited.paneId);
      },
      onBackgroundOutput: ({ paneId: id }) => {
        const state = useAppStore.getState();
        const tab = findTabOfPane(state, id);
        if (tab) state.markActivity(tab.id);
      },
    });
    sessions.set(paneId, session);
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

useAppStore.subscribe(scheduleReconcile);

/** Number of live sessions (for tests and diagnostics). */
export function sessionCount(): number {
  return sessions.size;
}

/** The pane's live session, if it has one (for tests and diagnostics). */
export function peekSession(paneId: string): TerminalSession | undefined {
  return sessions.get(paneId);
}
