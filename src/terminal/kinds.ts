/*
 * The two built-in terminal pane kinds. Both show a shell session kept by
 * pane id (src/terminal/sessions.ts), so a pane switched between them keeps
 * its shell and scrollback. No imports: used by low-level modules.
 */

/** The classic terminal (xterm.js as is). */
export const CLASSIC_TERMINAL = "terminal";
/** The block terminal: commands and their output as blocks, with an input editor. */
export const BLOCK_TERMINAL = "block-terminal";

/** Whether panes of `kind` show a built-in shell session. */
export function isSessionKind(kind: string | undefined): boolean {
  return kind === CLASSIC_TERMINAL || kind === BLOCK_TERMINAL;
}
