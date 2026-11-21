/**
 * Shell line-editing keys for the block input editor: ⌃U, ⌃W, ⌃K kill text
 * into a one-slot kill buffer and ⌃Y yanks it back. `lineEdit` is pure and
 * computes a replacement; `applyEdit` performs it on a textarea through the
 * native undo stack.
 *
 * With a selection all three kills take the selection itself (like a cut);
 * without one they work on the line the caret is on.
 */

export type KillKey = "u" | "w" | "k";
export type LineKey = KillKey | "y";

/** `chained` is true while the previous key was also a kill, so kills accumulate. */
export interface KillBuffer {
  text: string;
  chained: boolean;
}

export interface LineEdit {
  replaceFrom: number;
  replaceTo: number;
  insert: string;
  /** Caret position after the edit. */
  caret: number;
}

export interface LineEditResult {
  edit: LineEdit;
  kill: KillBuffer;
}

export const emptyKill: KillBuffer = { text: "", chained: false };

export const isKillKey = (key: string): key is KillKey => key === "u" || key === "w" || key === "k";

const isSpace = (char: string) => /\s/.test(char);

/** Start of the word before `at` (readline unix-word-rubout): skip whitespace back, then non-whitespace. */
const wordStart = (value: string, at: number): number => {
  let i = at;
  while (i > 0 && isSpace(value[i - 1]) && value[i - 1] !== "\n") i--;
  while (i > 0 && !isSpace(value[i - 1])) i--;
  return i;
};

/** The edit for `key` with the selection `start..end`, or null when it would change nothing. */
export function lineEdit(key: LineKey, value: string, start: number, end: number, kill: KillBuffer): LineEditResult | null {
  if (key === "y") {
    if (!kill.text) return null;
    return {
      edit: { replaceFrom: start, replaceTo: end, insert: kill.text, caret: start + kill.text.length },
      kill: { text: kill.text, chained: false },
    };
  }

  let from: number;
  let to: number;
  if (start !== end) {
    from = start;
    to = end;
  } else if (key === "u") {
    from = value.lastIndexOf("\n", start - 1) + 1;
    to = start;
  } else if (key === "w") {
    from = wordStart(value, start);
    to = start;
    // At the start of a line, ⌃W joins it to the previous one.
    if (from === to && start > 0 && value[start - 1] === "\n") from = start - 1;
  } else {
    const newline = value.indexOf("\n", start);
    to = newline === -1 ? value.length : newline;
    from = start;
    // At the end of a line ⌃K joins the next line, as in readline/emacs.
    if (from === to && newline !== -1) to = newline + 1;
  }
  if (from === to) return null;

  const killed = value.slice(from, to);
  const forward = key === "k" && start === end;
  const text = kill.chained ? (forward ? kill.text + killed : killed + kill.text) : killed;
  return { edit: { replaceFrom: from, replaceTo: to, insert: "", caret: from }, kill: { text, chained: true } };
}

/** Performs `edit` on the textarea so ⌘Z undoes it; the input event reaches React's onChange. */
export function applyEdit(input: HTMLTextAreaElement, edit: LineEdit): void {
  const before = input.value;
  input.focus();
  input.setSelectionRange(edit.replaceFrom, edit.replaceTo);
  const done =
    typeof document.execCommand === "function" &&
    (edit.insert ? document.execCommand("insertText", false, edit.insert) : document.execCommand("delete"));
  if (done && input.value !== before) return;
  // No execCommand (tests): set the value through the native setter so React sees an input event.
  const next = before.slice(0, edit.replaceFrom) + edit.insert + before.slice(edit.replaceTo);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, next);
  input.setSelectionRange(edit.caret, edit.caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
