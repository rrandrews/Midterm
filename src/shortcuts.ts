import {
  closePane,
  closeTab,
  cycleTab,
  focusNeighbourPane,
  newTab,
  selectTabAt,
  splitPane,
} from "./actions";

/*
 * App keyboard shortcuts (macOS: all use ⌘).
 *
 * Matched on `event.code`, the physical key, because ⌥ and ⇧ change
 * `event.key` on macOS.
 */

type Modifiers = { shift?: boolean; alt?: boolean };
type Shortcut = Modifiers & { code: string; run: () => void };

const SHORTCUTS: Shortcut[] = [
  { code: "KeyT", run: newTab },
  { code: "KeyW", run: () => closePane() },
  { code: "KeyW", shift: true, run: () => closeTab() },
  { code: "KeyD", run: () => splitPane("right") },
  { code: "KeyD", shift: true, run: () => splitPane("bottom") },
  { code: "BracketLeft", shift: true, run: () => cycleTab(-1) },
  { code: "BracketRight", shift: true, run: () => cycleTab(1) },
  { code: "ArrowLeft", alt: true, run: () => focusNeighbourPane("left") },
  { code: "ArrowRight", alt: true, run: () => focusNeighbourPane("right") },
  { code: "ArrowUp", alt: true, run: () => focusNeighbourPane("up") },
  { code: "ArrowDown", alt: true, run: () => focusNeighbourPane("down") },
  ...Array.from({ length: 9 }, (_, index) => ({
    code: `Digit${index + 1}`,
    run: () => selectTabAt(index),
  })),
];

function match(event: KeyboardEvent): Shortcut | undefined {
  if (!event.metaKey || event.ctrlKey) return undefined;
  return SHORTCUTS.find(
    (shortcut) =>
      shortcut.code === event.code &&
      Boolean(shortcut.shift) === event.shiftKey &&
      Boolean(shortcut.alt) === event.altKey,
  );
}

/** Whether a key event is an app shortcut (so terminals leave it alone). */
export function isAppShortcut(event: KeyboardEvent): boolean {
  return match(event) !== undefined;
}

/** Starts handling shortcuts; returns a function that stops. */
export function installShortcuts(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const shortcut = match(event);
    if (!shortcut) return;
    event.preventDefault();
    event.stopPropagation();
    // Holding the keys down shouldn't open a tab or split per repeat.
    if (!event.repeat) shortcut.run();
  };
  // Capture phase: runs before the focused terminal or any menu sees the key.
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
