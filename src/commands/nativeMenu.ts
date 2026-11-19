import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { chordToAccelerator, parseChord } from "./keys";
import { useAppStore } from "../state/store";
import { bindingsOf, getCommand, isEnabled, runCommand, subscribeCommands } from "./registry";

/*
 * The native menu bar, generated from the command registry: titles come
 * from the commands and accelerators from their effective bindings, so
 * rebinding a shortcut updates the menu. The backend (`src-tauri/src/menu.rs`)
 * builds it and emits `menu-command` when an item is chosen.
 *
 * A key press can reach both the page's shortcut handler and the menu's key
 * equivalent (WebKit offers keys to the page first and to the menu only if
 * the page did not handle them, but that is not guaranteed), so a command
 * the keyboard handler just ran is not run again from the menu.
 */

type Entry =
  | { type: "command"; id: string; title: string; accelerator: string | null; enabled: boolean }
  | { type: "separator" }
  | { type: "predefined"; item: string };

type Spec = { title: string; items: Entry[] };

/** Command ids (or "-" for a separator, "native:<item>" for a predefined item) per submenu. */
const LAYOUT: { title: string; items: string[] }[] = [
  { title: "app", items: ["settings.open", "settings.keyboard"] },
  {
    title: "File",
    items: ["tab.new", "workspace.new", "-", "palette.openFile", "pane.save", "editor.revert", "-", "pane.close", "tab.close"],
  },
  {
    title: "Edit",
    items: [
      "native:undo",
      "native:redo",
      "-",
      "native:cut",
      "native:copy",
      "native:paste",
      "native:selectAll",
      "-",
      "pane.find",
      "pane.findNext",
      "pane.findPrevious",
      "-",
      "pane.goToLine",
    ],
  },
  { title: "View", items: ["palette.open", "palette.commands", "-", "pane.toggleMaximize", "-", "native:fullscreen"] },
  {
    title: "Pane",
    items: [
      "pane.splitRight",
      "pane.splitDown",
      "-",
      "pane.focusLeft",
      "pane.focusRight",
      "pane.focusUp",
      "pane.focusDown",
      "-",
      "pane.moveToNewTab",
    ],
  },
  { title: "Window", items: ["native:minimize", "native:maximize", "-", "tab.previous", "tab.next"] },
];

/**
 * The first binding that the menu can carry. Only ⌘ chords: a menu key
 * equivalent takes its keys from the page even when the command does not
 * apply, and a ⌃ chord (⌃G) must still reach a terminal then.
 */
function accelerator(id: string): string | null {
  for (const spec of bindingsOf(id)) {
    const chord = parseChord(spec);
    if (!chord?.cmd) continue;
    const result = chordToAccelerator(chord);
    if (result) return result;
  }
  return null;
}

export function menuSpecs(): Spec[] {
  return LAYOUT.map(({ title, items }) => {
    const entries: Entry[] = [];
    for (const item of items) {
      if (item === "-") {
        if (entries.length && entries[entries.length - 1].type !== "separator") entries.push({ type: "separator" });
      } else if (item.startsWith("native:")) {
        entries.push({ type: "predefined", item: item.slice("native:".length) });
      } else {
        const command = getCommand(item);
        if (command) {
          entries.push({
            type: "command",
            id: command.id,
            title: command.title,
            accelerator: accelerator(command.id),
            // A disabled item does not take its key equivalent from the page.
            enabled: isEnabled(command),
          });
        }
      }
    }
    while (entries.length && entries[entries.length - 1].type === "separator") entries.pop();
    return { title, items: entries };
  });
}

const DEDUPE_MS = 300;
let lastRun: { id: string; at: number } | null = null;

/** Records that a command ran from the keyboard, so the menu does not run it again. */
export function noteShortcutRun(id: string): void {
  lastRun = { id, at: performance.now() };
}

function ranJustNow(id: string): boolean {
  return lastRun !== null && lastRun.id === id && performance.now() - lastRun.at < DEDUPE_MS;
}

/**
 * Keeps the native menu in sync with the registry (titles, accelerators,
 * and which items apply to the active pane) and runs the commands
 * chosen from it. `suspended` says when the keyboard belongs to something
 * else (a rename field, a dialog). Returns a function that stops.
 */
export function installNativeMenu(suspended: () => boolean): () => void {
  if (!isTauri()) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastJson = "";
  const sync = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const menus = menuSpecs();
      const json = JSON.stringify(menus);
      if (json === lastJson) return;
      lastJson = json;
      invoke("menu_set", { menus }).catch((error: unknown) => console.error("menu_set failed:", error));
    }, 50);
  };
  sync();
  const unsubscribe = subscribeCommands(sync);
  // Which commands apply depends on the active pane.
  const unsubscribeStore = useAppStore.subscribe(sync);
  const unlisten = listen<string>("menu-command", ({ payload: id }) => {
    if (ranJustNow(id) || suspended()) return;
    runCommand(id);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
    unsubscribeStore();
    void unlisten.then((stop) => stop());
  };
}
