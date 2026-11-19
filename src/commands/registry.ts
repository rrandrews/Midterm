import { getSettings, useSettings } from "../settings/settings";
import { type Chord, chordFromEvent, formatBinding, parseChord, sameChord } from "./keys";

/*
 * The command registry: every user-level command, its title, category and
 * default key bindings. Keyboard shortcuts, the command palette, menus' key
 * hints and the native menu bar are all generated from it.
 *
 * Commands are registered by the module that owns them (`core.ts` for the
 * app's own, pane kinds for theirs). The functions they run live in
 * `src/actions.ts` and friends; a command is just a named, bindable handle.
 *
 * Effective bindings are each command's defaults unless the settings
 * override them (`settings.keybindings[id]`).
 */

export type CommandCategory =
  | "App"
  | "Tab"
  | "Pane"
  | "Workspace"
  | "Terminal"
  | "Editor"
  | "View";

export type Command = {
  /** Stable id, used in settings and the native menu, e.g. `pane.splitRight`. */
  id: string;
  title: string;
  category: CommandCategory;
  /** Default bindings, e.g. `["Cmd+Shift+D"]`. */
  keys?: string[];
  run: () => unknown;
  /** Hidden from the command palette (e.g. "go to tab 3"). */
  hidden?: boolean;
  /**
   * Whether the command applies right now. A disabled command's keys are
   * not taken from the focused element (⌘F reaches the page when nothing
   * can search), and the palette leaves it out.
   */
  enabled?: () => boolean;
};

const commands = new Map<string, Command>();
const listeners = new Set<() => void>();
let version = 0;

/** Adds commands (replacing any with the same id). Returns a function that removes them. */
export function registerCommands(list: Command[]): () => void {
  for (const command of list) commands.set(command.id, command);
  changed();
  return () => {
    for (const command of list) if (commands.get(command.id) === command) commands.delete(command.id);
    changed();
  };
}

function changed(): void {
  version += 1;
  bindingCache = null;
  for (const listener of listeners) listener();
}

/** Calls `listener` when commands or their bindings change. Returns a function that stops. */
export function subscribeCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes whenever commands or bindings change (for `useSyncExternalStore`). */
export function commandsVersion(): number {
  return version;
}

let lastKeybindings = useSettings.getState().keybindings;
useSettings.subscribe((state) => {
  if (state.keybindings === lastKeybindings) return;
  lastKeybindings = state.keybindings;
  changed();
});

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

/** All registered commands, in registration order. */
export function allCommands(): Command[] {
  return [...commands.values()];
}

export function isEnabled(command: Command): boolean {
  try {
    return command.enabled?.() ?? true;
  } catch {
    return false;
  }
}

/** A command's effective bindings: the user's override, else its defaults. */
export function bindingsOf(id: string): string[] {
  const override = getSettings().keybindings[id];
  return override ?? commands.get(id)?.keys ?? [];
}

/** The first effective binding, formatted for display (`⇧⌘D`), or `undefined`. */
export function shortcutLabel(id: string): string | undefined {
  const [first] = bindingsOf(id);
  return first ? formatBinding(first) : undefined;
}

type Binding = { chord: Chord; id: string };
let bindingCache: Binding[] | null = null;

/** Every effective binding, in command order. A chord bound twice goes to the first command. */
function bindings(): Binding[] {
  if (bindingCache) return bindingCache;
  const list: Binding[] = [];
  for (const command of commands.values()) {
    for (const spec of bindingsOf(command.id)) {
      const chord = parseChord(spec);
      if (chord) list.push({ chord, id: command.id });
    }
  }
  bindingCache = list;
  return list;
}

/** Commands other than `id` that are bound to `chord`. */
export function conflictsWith(chord: Chord, id: string): Command[] {
  return bindings()
    .filter((binding) => binding.id !== id && sameChord(binding.chord, chord))
    .map((binding) => commands.get(binding.id))
    .filter((command): command is Command => command !== undefined);
}

/** The enabled command a key event triggers, if any. */
export function commandForEvent(event: KeyboardEvent): Command | undefined {
  const chord = chordFromEvent(event);
  if (!chord) return undefined;
  for (const binding of bindings()) {
    if (!sameChord(binding.chord, chord)) continue;
    const command = commands.get(binding.id);
    if (command && isEnabled(command)) return command;
  }
  return undefined;
}

/** Runs a command by id, if it exists and is enabled. Returns whether it ran. */
export function runCommand(id: string): boolean {
  const command = commands.get(id);
  if (!command || !isEnabled(command)) return false;
  noteRun(id);
  try {
    const result = command.run();
    if (result instanceof Promise) result.catch((error) => console.error(`Command ${id} failed:`, error));
  } catch (error) {
    console.error(`Command ${id} failed:`, error);
  }
  return true;
}

/*
 * Recently run commands, most recent first, for the palette. Kept in
 * memory for the session.
 */

const RECENT_LIMIT = 20;
const recent: string[] = [];
const runListeners = new Set<(id: string) => void>();

function noteRun(id: string): void {
  const index = recent.indexOf(id);
  if (index !== -1) recent.splice(index, 1);
  recent.unshift(id);
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
  for (const listener of runListeners) listener(id);
}

/** Command ids, most recently run first. */
export function recentCommandIds(): readonly string[] {
  return recent;
}

/** Restores the recent list (e.g. from disk), most recent first. */
export function seedRecentCommands(ids: readonly string[]): void {
  recent.splice(0, recent.length, ...ids.slice(0, RECENT_LIMIT));
}

/** Calls `listener` after each command runs. Returns a function that stops. */
export function onCommandRun(listener: (id: string) => void): () => void {
  runListeners.add(listener);
  return () => runListeners.delete(listener);
}

/*
 * Pane actions: commands such as Find or Save act on the active pane, and
 * what they do depends on its kind. A pane's content registers the actions
 * it supports while mounted; the command is enabled only when the active
 * pane has that action.
 */

export type PaneActions = {
  find?: () => void;
  findNext?: () => void;
  findPrevious?: () => void;
  save?: () => unknown;
  goToLine?: () => void;
};

const paneActions = new Map<string, PaneActions>();

export function registerPaneActions(paneId: string, actions: PaneActions): () => void {
  paneActions.set(paneId, actions);
  return () => {
    if (paneActions.get(paneId) === actions) paneActions.delete(paneId);
  };
}

export function paneActionsOf(paneId: string | undefined): PaneActions | undefined {
  return paneId ? paneActions.get(paneId) : undefined;
}
