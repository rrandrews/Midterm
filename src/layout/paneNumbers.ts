import { create } from "zustand";
import { activePaneNumbers } from "../actions";
import { shortcutsSuspended } from "../shortcuts";

/*
 * Pane numbers: while ⌥ is held on its own for a moment, every pane of the
 * active tab shows the digit that ⌥-selects it (`pane.select1…10`, in
 * `listPanes` order). The numbers are a snapshot taken when they appear and
 * are drawn by `PaneNumberBadge` inside each `PaneHost`.
 */

/** How long ⌥ must be held alone before the numbers appear, so quick ⌥-chords don't flash them. */
export const SHOW_DELAY_MS = 250;

type PaneNumbersState = {
  /** Label by pane id; empty while hidden. */
  numbers: Record<string, string>;
};

const NONE: Record<string, string> = {};

export const usePaneNumbers = create<PaneNumbersState>(() => ({ numbers: NONE }));

function hide(): void {
  if (usePaneNumbers.getState().numbers !== NONE) usePaneNumbers.setState({ numbers: NONE });
}

/** Whether a key event is ⌥ plus a digit, with no other modifier (a pane selection). */
function isAltDigit(event: KeyboardEvent): boolean {
  return /^Digit[0-9]$/.test(event.code) && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
}

/** Starts watching for ⌥ held alone; returns a function that stops. */
export function installPaneNumbers(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    hide();
  };

  const show = () => {
    timer = undefined;
    if (shortcutsSuspended()) return;
    const numbers = activePaneNumbers();
    // A lone pane has nothing to choose between.
    if (Object.keys(numbers).length > 1) usePaneNumbers.setState({ numbers });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Alt") {
      const alone = !event.metaKey && !event.ctrlKey && !event.shiftKey;
      if (!alone) cancel();
      else if (timer === undefined && usePaneNumbers.getState().numbers === NONE) {
        timer = setTimeout(show, SHOW_DELAY_MS);
      }
      return;
    }
    // ⌥ plus a digit switches panes; the numbers stay up while ⌥ does.
    if (isAltDigit(event)) {
      if (usePaneNumbers.getState().numbers !== NONE) usePaneNumbers.setState({ numbers: activePaneNumbers() });
      return;
    }
    // Any other key or modifier means ⌥ is part of something else.
    cancel();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Alt" || !event.altKey) cancel();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") cancel();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", cancel);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    cancel();
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", cancel);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
