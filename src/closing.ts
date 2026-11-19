import { activePaneId, closePaneNow, focusActivePane, closeTabNow, removeWorkspaceNow, setPaneKind } from "./actions";
import type { PaneKind, Tab } from "./state/types";
import { closePromptMessage } from "./closePrompt";
import { confirm } from "./components/ui/ConfirmDialog";
import { unsavedFiles } from "./editor/registry";
import { baseName } from "./explorer/tree";
import { findPane, listPanes } from "./state/layout";
import { findTab, findTabOfPane, selectActiveTab, selectActiveWorkspace, useAppStore } from "./state/store";
import { peekSession } from "./terminal/sessions";

/*
 * Closing things that may have programs running in them or unsaved
 * changes. Each command looks up what is in the foreground of the
 * terminals it would end and which editors it would close with unsaved
 * changes and, if there are any, asks first (one question for all).
 */

const store = () => useAppStore.getState();

/** Names of the programs running in these panes' terminals (not idle shells). */
async function runningPrograms(paneIds: string[]): Promise<string[]> {
  const found = await Promise.all(
    terminalPanesOf(paneIds).map(async (paneId) => {
      const foreground = await peekSession(paneId)?.foreground().catch(() => null);
      return foreground && !foreground.isShell ? foreground.name || "a program" : null;
    }),
  );
  return [...new Set(found.filter((name): name is string => name !== null))];
}

/**
 * Whether it is fine to close these panes: no terminal among them runs a
 * program and no editor has unsaved changes, or the user agreed.
 */
async function mayClose(paneIds: string[], title: string, action: string): Promise<boolean> {
  const programs = await runningPrograms(paneIds);
  const files = unsavedFiles(paneIds).map(baseName);
  const message = closePromptMessage(programs, [...new Set(files)]);
  if (message === null) return true;
  return confirm({ title, message, action });
}

function terminalPanesOf(paneIds: string[]): string[] {
  return paneIds.filter((paneId) => {
    const tab = findTabOfPane(store(), paneId);
    return tab && findPane(tab.layout, paneId)?.data.kind === "terminal";
  });
}

function paneIdsOf(tabs: Tab[]): string[] {
  return tabs.flatMap((tab) => listPanes(tab.layout).map((pane) => pane.id));
}

export async function closePane(paneId = activePaneId()): Promise<void> {
  if (!paneId) return;
  if (await mayClose([paneId], "Close this pane?", "Close pane")) closePaneNow(paneId);
}

/**
 * Changing a terminal pane to another kind ends its shell, and changing an
 * editor's kind drops its unsaved changes, so it asks like closing.
 */
export async function changePaneKind(paneId: string, kind: PaneKind): Promise<void> {
  const tab = findTabOfPane(store(), paneId);
  const current = tab && findPane(tab.layout, paneId)?.data.kind;
  if (current === kind) return;
  const title = current === "terminal" ? "Close the terminal?" : "Change the pane’s type?";
  if (!(await mayClose([paneId], title, "Change type"))) return;
  setPaneKind(paneId, kind);
}

export async function closeTab(tabId: string = selectActiveTab(store()).id): Promise<void> {
  const tab = findTab(store(), tabId);
  if (!tab) return;
  if (await mayClose(paneIdsOf([tab]), "Close this tab?", "Close tab")) closeTabNow(tabId);
}

/** Closes several tabs of the active workspace, asking once for all of them. */
async function closeTabs(tabIds: string[], what: string, show?: string): Promise<void> {
  const tabs = tabIds.map((tabId) => findTab(store(), tabId)).filter((tab) => tab !== undefined);
  if (tabs.length === 0) return;
  if (!(await mayClose(paneIdsOf(tabs), `Close ${what}?`, "Close tabs"))) return;
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
  if (await mayClose(paneIdsOf(workspace.tabs), `Close “${workspace.name}”?`, "Close workspace")) {
    removeWorkspaceNow(workspaceId);
  }
}

/** For closing the window or quitting: whether everything may be ended. */
export async function mayCloseEverything(what: "window" | "app"): Promise<boolean> {
  const panes = paneIdsOf(store().workspaces.flatMap((workspace) => workspace.tabs));
  return what === "app"
    ? mayClose(panes, "Close midterm?", "Quit")
    : mayClose(panes, "Close this window?", "Close window");
}
