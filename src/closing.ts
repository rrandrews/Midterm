import { activePaneId, closePaneNow, focusActivePane, closeTabNow, removeWorkspaceNow, setPaneKind } from "./actions";
import type { PaneKind } from "./state/types";
import { confirm } from "./components/ui/ConfirmDialog";
import { findPane, listPanes } from "./state/layout";
import { findTab, findTabOfPane, selectActiveTab, selectActiveWorkspace, useAppStore } from "./state/store";
import { peekSession } from "./terminal/sessions";

/*
 * Closing things that may have programs running in them. Each command looks
 * up what is in the foreground of the terminals it would end and, if any of
 * them is running something other than the shell, asks first.
 */

const store = () => useAppStore.getState();

/** Names of the programs running in these panes' terminals (not idle shells). */
async function runningPrograms(paneIds: string[]): Promise<string[]> {
  const found = await Promise.all(
    paneIds.map(async (paneId) => {
      const foreground = await peekSession(paneId)?.foreground().catch(() => null);
      return foreground && !foreground.isShell ? foreground.name || "a program" : null;
    }),
  );
  return [...new Set(found.filter((name): name is string => name !== null))];
}

function describe(programs: string[]): string {
  const quoted = programs.map((name) => `“${name}”`);
  if (quoted.length === 1) return `${quoted[0]} is still running`;
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]} are still running`;
}

/** Whether it is fine to end these panes' terminals: nothing runs, or the user agreed. */
async function mayClose(paneIds: string[], what: string, action: string): Promise<boolean> {
  const programs = await runningPrograms(paneIds);
  if (programs.length === 0) return true;
  return confirm({
    title: `Close ${what}?`,
    message: `${describe(programs)}. Closing ends ${programs.length === 1 ? "it" : "them"}.`,
    action,
  });
}

function terminalPanesOf(paneIds: string[]): string[] {
  return paneIds.filter((paneId) => {
    const tab = findTabOfPane(store(), paneId);
    return tab && findPane(tab.layout, paneId)?.data.kind === "terminal";
  });
}

export async function closePane(paneId = activePaneId()): Promise<void> {
  if (!paneId) return;
  if (await mayClose(terminalPanesOf([paneId]), "this pane", "Close pane")) closePaneNow(paneId);
}

/** Changing a terminal pane to another kind ends its shell, so it asks like closing. */
export async function changePaneKind(paneId: string, kind: PaneKind): Promise<void> {
  if (kind !== "terminal" && !(await mayClose(terminalPanesOf([paneId]), "the terminal", "Change type"))) {
    return;
  }
  setPaneKind(paneId, kind);
}

export async function closeTab(tabId: string = selectActiveTab(store()).id): Promise<void> {
  const tab = findTab(store(), tabId);
  if (!tab) return;
  const panes = terminalPanesOf(listPanes(tab.layout).map((pane) => pane.id));
  if (await mayClose(panes, "this tab", "Close tab")) closeTabNow(tabId);
}

/** Closes several tabs of the active workspace, asking once for all of them. */
async function closeTabs(tabIds: string[], what: string, show?: string): Promise<void> {
  const tabs = tabIds.map((tabId) => findTab(store(), tabId)).filter((tab) => tab !== undefined);
  if (tabs.length === 0) return;
  const panes = terminalPanesOf(tabs.flatMap((tab) => listPanes(tab.layout).map((pane) => pane.id)));
  if (!(await mayClose(panes, what, "Close tabs"))) return;
  if (show) store().setActiveTab(show);
  for (const tab of tabs) store().closeTab(tab.id);
  focusActivePane();
}

/** Closes every other tab in the workspace and shows the one kept. */
export async function closeOtherTabs(tabId: string): Promise<void> {
  const others = selectActiveWorkspace(store()).tabs.filter((tab) => tab.id !== tabId);
  await closeTabs(others.map((tab) => tab.id), "the other tabs", tabId);
}

export async function closeTabsToTheRight(tabId: string): Promise<void> {
  const { tabs } = selectActiveWorkspace(store());
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;
  await closeTabs(tabs.slice(index + 1).map((tab) => tab.id), "the tabs to the right");
}

export async function removeWorkspace(workspaceId: string): Promise<void> {
  const workspace = store().workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return;
  const panes = terminalPanesOf(
    workspace.tabs.flatMap((tab) => listPanes(tab.layout).map((pane) => pane.id)),
  );
  if (await mayClose(panes, `“${workspace.name}”`, "Close workspace")) {
    removeWorkspaceNow(workspaceId);
  }
}

/** For closing the window or quitting: whether everything may be ended. */
export async function mayCloseEverything(what: "window" | "app"): Promise<boolean> {
  const panes = terminalPanesOf(
    store().workspaces.flatMap((workspace) =>
      workspace.tabs.flatMap((tab) => listPanes(tab.layout).map((pane) => pane.id)),
    ),
  );
  return what === "app"
    ? mayClose(panes, "midterm", "Quit")
    : mayClose(panes, "this window", "Close window");
}
