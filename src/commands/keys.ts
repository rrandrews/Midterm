/*
 * Key chords: parsing the strings used for bindings ("Cmd+Shift+D"),
 * matching them against key events, and showing them ("⇧⌘D").
 *
 * Chords are matched on `event.code`, the physical key, because ⌥ and ⇧
 * change `event.key` on macOS (⌥D types "∂").
 */

export type Chord = {
  /** `KeyboardEvent.code`, e.g. `KeyD`, `Digit1`, `Enter`, `BracketLeft`. */
  code: string;
  cmd: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
};

/** Key names accepted in binding strings, besides letters, digits and F1–F12, mapped to codes. */
const NAMED: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: "Space",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  "[": "BracketLeft",
  "]": "BracketRight",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
};

/** How each code is written in a binding string (the inverse of `NAMED`, preferring short names). */
const CODE_NAMES: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Space: "Space",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

/** Symbols for display, macOS style. */
const CODE_SYMBOLS: Record<string, string> = {
  Enter: "↩",
  Tab: "⇥",
  Space: "Space",
  Escape: "⎋",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
};

const MODIFIERS: Record<string, keyof Omit<Chord, "code">> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  mod: "cmd",
  cmdorctrl: "cmd",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  ctrl: "ctrl",
  control: "ctrl",
};

function keyCode(name: string): string | null {
  const lower = name.toLowerCase();
  if (/^[a-z]$/.test(lower)) return `Key${lower.toUpperCase()}`;
  if (/^[0-9]$/.test(lower)) return `Digit${lower}`;
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();
  return NAMED[lower] ?? null;
}

/**
 * Parses a binding such as `Cmd+Shift+D`, `cmd+[` or `Alt+Cmd+Left`.
 * Modifier names are case-insensitive and may come in any order. Returns
 * `null` if it is not a valid chord.
 */
export function parseChord(spec: string): Chord | null {
  // "+" as the key itself ("Cmd++") is not supported; "=" names that key anyway.
  const parts = spec.split("+").map((part) => part.trim());
  if (parts.some((part) => part === "")) return null;
  const chord: Chord = { code: "", cmd: false, shift: false, alt: false, ctrl: false };
  for (const [index, part] of parts.entries()) {
    const modifier = MODIFIERS[part.toLowerCase()];
    const last = index === parts.length - 1;
    if (modifier && !last) {
      if (chord[modifier]) return null;
      chord[modifier] = true;
      continue;
    }
    if (!last) return null;
    const code = keyCode(part);
    if (!code) return null;
    chord.code = code;
  }
  return chord.code ? chord : null;
}

/** The canonical binding string for a chord, e.g. `Cmd+Shift+D`. */
export function chordToString(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.cmd) parts.push("Cmd");
  if (chord.shift) parts.push("Shift");
  parts.push(codeName(chord.code));
  return parts.join("+");
}

function codeName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return CODE_NAMES[code] ?? code;
}

/** A chord for display, e.g. `⇧⌘D` (modifiers in the macOS order ⌃⌥⇧⌘). */
export function formatChord(chord: Chord): string {
  const key = CODE_SYMBOLS[chord.code] ?? codeName(chord.code);
  return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.cmd ? "⌘" : ""}${key}`;
}

/** Formats a binding string for display; the string itself if it does not parse. */
export function formatBinding(spec: string): string {
  const chord = parseChord(spec);
  return chord ? formatChord(chord) : spec;
}

/** The chord a key event represents, or `null` for a bare modifier press. */
export function chordFromEvent(event: KeyboardEvent): Chord | null {
  if (/^(Meta|Shift|Alt|Control|OS)(Left|Right)?$/.test(event.code) || !event.code) return null;
  return {
    code: event.code,
    cmd: event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
  };
}

/** Whether two chords are the same keys. */
export function sameChord(a: Chord, b: Chord): boolean {
  return (
    a.code === b.code && a.cmd === b.cmd && a.shift === b.shift && a.alt === b.alt && a.ctrl === b.ctrl
  );
}

/**
 * The binding as a Tauri menu accelerator (`CmdOrCtrl+Shift+D`), or `null`
 * if it cannot be expressed as one.
 */
export function chordToAccelerator(chord: Chord): string | null {
  const key = chord.code.startsWith("Key")
    ? chord.code.slice(3)
    : chord.code.startsWith("Digit")
      ? chord.code.slice(5)
      : /^F\d+$/.test(chord.code)
        ? chord.code
        : ACCELERATOR_KEYS[chord.code];
  if (!key) return null;
  const parts: string[] = [];
  if (chord.cmd) parts.push("CmdOrCtrl");
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Key names Tauri's accelerator parser (the `global-hotkey` crate) understands. */
const ACCELERATOR_KEYS: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Space: "Space",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};
