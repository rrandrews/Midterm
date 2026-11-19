import { TerminalPane } from "../../components/panes/TerminalPane";
import { activeTerminal, toggleBlocks } from "../../terminal/blockMode";
import { terminalMenu } from "../../terminal/menu";
import { peekSession, terminalTabTitle } from "../../terminal/sessions";
import { TERMINAL_FIELDS, type TerminalData } from "../../terminal/settings";
import { directoryOf } from "../panes";
import { validateTerminalData } from "./data";
import type { PanePlugin, PaneProps } from "../types";
import { terminalSkills } from "./terminalSkills";

function Terminal({ paneId, data }: PaneProps) {
  return <TerminalPane paneId={paneId} mode={(data as TerminalData).terminalMode} />;
}

/** Terminal panes: a shell in xterm.js, classic or blocks mode. Always enabled. */
export const terminalPlugin: PanePlugin = {
  id: "terminal",
  name: "Terminal",
  description: "Shells in classic or blocks mode, with shell integration.",
  icon: "square-terminal",
  required: true,
  pane: {
    component: Terminal,
    validateData: validateTerminalData,
    // A new terminal opens in the directory of the pane it comes from.
    createData: (from) => {
      const cwd = from && directoryOf(from);
      return cwd ? { cwd } : {};
    },
    closeBlockers: async (paneId) => {
      const foreground = await peekSession(paneId)?.foreground().catch(() => null);
      return foreground && !foreground.isShell ? [{ type: "running", name: foreground.name || "a program" }] : [];
    },
    directory: (pane) => peekSession(pane.id)?.cwd ?? (pane.data as TerminalData).cwd,
    explorerFollows: true,
    tabTitle: terminalTabTitle,
    menu: (ctx) => terminalMenu(ctx.paneId),
    // A program that reads the mouse (vim, htop…) gets the right click; ⌥
    // forces the menu (xterm keeps ⌥-clicks from the program, as
    // `macOptionClickForcesSelection` is on; ⇧ would not).
    ownsContextMenu: (paneId, event) => (peekSession(paneId)?.wantsMouse ?? false) && !event.altKey,
    background: "var(--pane-terminal)",
    activeBackground: "var(--pane-terminal-active)",
  },
  commands: [
    {
      id: "terminal.toggleBlocks",
      title: "Toggle blocks mode",
      category: "Terminal",
      run: () => {
        const id = activeTerminal();
        if (id) toggleBlocks(id);
      },
      enabled: () => activeTerminal() !== undefined,
    },
  ],
  settings: { fields: TERMINAL_FIELDS },
  skills: terminalSkills,
};
