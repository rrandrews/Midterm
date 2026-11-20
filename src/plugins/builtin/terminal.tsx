import { TerminalPane } from "../../components/panes/TerminalPane";
import { activeTerminal, otherTerminalKind, toggleBlocks } from "../../terminal/blockMode";
import { BLOCK_TERMINAL, CLASSIC_TERMINAL, isSessionKind } from "../../terminal/kinds";
import { terminalMenu } from "../../terminal/menu";
import { peekSession, terminalTabTitle } from "../../terminal/sessions";
import { SharedTerminalSettings } from "../../terminal/SharedTerminalSettings";
import { TERMINAL_FIELDS, type TerminalData } from "../../terminal/settings";
import { directoryOf } from "../panes";
import { validateTerminalData } from "./data";
import type { PanePlugin, PaneProps, PaneSpec } from "../types";
import { terminalSkills } from "./terminalSkills";

/*
 * The two built-in terminals: classic (xterm.js as is) and block (commands
 * and their output as blocks, with an input editor). Both show the shell
 * session kept for their pane id, so a pane switched between them keeps its
 * shell and scrollback.
 */

function ClassicTerminal({ paneId }: PaneProps) {
  return <TerminalPane paneId={paneId} blocks={false} />;
}

function BlockTerminal({ paneId }: PaneProps) {
  return <TerminalPane paneId={paneId} blocks />;
}

/** Everything the two terminals' panes share. */
const terminalPaneSpec: Omit<PaneSpec, "component"> = {
  validateData: validateTerminalData,
  // A new terminal opens in the directory of the pane it comes from.
  createData: (from) => {
    const cwd = from && directoryOf(from);
    return cwd ? { cwd } : {};
  },
  // Switching between the terminals keeps everything; from another kind, start fresh.
  convertData: (previous) => (isSessionKind(previous.kind) ? validateTerminalData(previous) : undefined),
  keepsStateOnChangeTo: isSessionKind,
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
};

/** The classic terminal. Always enabled; it also holds the settings both terminals share. */
export const terminalPlugin: PanePlugin = {
  id: CLASSIC_TERMINAL,
  name: "Classic terminal",
  description: "Shells in xterm.js, with shell integration.",
  icon: "square-terminal",
  required: true,
  terminal: true,
  pane: {
    ...terminalPaneSpec,
    component: ClassicTerminal,
    background: "var(--pane-terminal)",
    activeBackground: "var(--pane-terminal-active)",
  },
  commands: [
    {
      id: "terminal.toggleBlocks",
      title: "Switch between classic and block terminal",
      category: "Terminal",
      run: () => {
        const id = activeTerminal();
        if (id) toggleBlocks(id);
      },
      enabled: () => {
        const id = activeTerminal();
        return id !== undefined && otherTerminalKind(id) !== undefined;
      },
    },
  ],
  settings: { fields: TERMINAL_FIELDS },
  skills: terminalSkills,
};

/** The block terminal: needs shell integration (OSC 133); without it, it shows the classic terminal. */
export const blockTerminalPlugin: PanePlugin = {
  id: BLOCK_TERMINAL,
  name: "Block terminal",
  description: "Shells with each command and its output as a block, an input editor and AI suggestions.",
  icon: "square-terminal",
  terminal: true,
  pane: {
    ...terminalPaneSpec,
    component: BlockTerminal,
    background: "var(--pane-block-terminal, var(--pane-terminal))",
    activeBackground: "var(--pane-block-terminal-active, var(--pane-block-terminal, var(--pane-terminal-active)))",
  },
  settings: { section: SharedTerminalSettings },
};
