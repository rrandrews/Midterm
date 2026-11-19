import { create } from "zustand";
import { activePaneId, addPaneBeside, openFile, selectTab, selectWorkspace } from "../actions";
import { registerCommands, runCommand } from "../commands/registry";
import { createPane } from "../state/layout";
import { useAppStore } from "../state/store";
import { queueStartupInput } from "../terminal/sessions";
import type { PaletteAction, PaletteMode } from "./items";
import { activeDirectory } from "./sources";

/*
 * The command palette's open state, its commands, and what choosing an
 * item does. The UI is `Palette.tsx`.
 */

type PaletteState = {
  open: boolean;
  mode: PaletteMode;
  /** Text the input starts with. */
  initialQuery: string;
  /** Bumped on each open, so the input resets even when reopened in the same mode. */
  session: number;
};

export const usePalette = create<PaletteState>()(() => ({
  open: false,
  mode: "all",
  initialQuery: "",
  session: 0,
}));

export function openPalette(mode: PaletteMode = "all", initialQuery = ""): void {
  usePalette.setState((state) => ({ open: true, mode, initialQuery, session: state.session + 1 }));
}

export function closePalette(): void {
  usePalette.setState({ open: false });
}

/** Runs a shell command in a new terminal pane beside the active one, in its directory. */
export function runInNewTerminal(command: string): void {
  const from = activePaneId();
  if (!from) return;
  const pane = createPane("terminal", { cwd: activeDirectory() });
  addPaneBeside(from, pane);
  queueStartupInput(pane.id, `${command}\r`);
}

/** Carries out a palette item's action (after the palette has closed). */
export function performPaletteAction(action: PaletteAction): void {
  switch (action.kind) {
    case "command":
      runCommand(action.id);
      return;
    case "tab":
      if (useAppStore.getState().activeWorkspaceId !== action.workspaceId) selectWorkspace(action.workspaceId);
      selectTab(action.tabId);
      return;
    case "workspace":
      selectWorkspace(action.workspaceId);
      return;
    case "file": {
      const from = activePaneId();
      if (!from) return;
      openFile(action.path, { fromPaneId: from });
      return;
    }
    case "run":
      runInNewTerminal(action.command);
      return;
  }
}

registerCommands([
  {
    id: "palette.open",
    title: "Command palette",
    category: "View",
    keys: ["Cmd+K"],
    run: () => openPalette("all"),
  },
  {
    id: "palette.openFile",
    title: "Open file…",
    category: "View",
    keys: ["Cmd+P"],
    run: () => openPalette("files"),
  },
  {
    id: "palette.commands",
    title: "Show all commands",
    category: "View",
    keys: ["Cmd+Shift+P"],
    run: () => openPalette("all", ">"),
  },
  {
    id: "palette.runCommand",
    title: "Run a shell command in a new pane…",
    category: "Terminal",
    run: () => openPalette("all", "$ "),
  },
]);
