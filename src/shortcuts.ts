import "./commands/core";
import { installNativeMenu, noteShortcutRun } from "./commands/nativeMenu";
import { commandForEvent, runCommand } from "./commands/registry";
import { isConfirming } from "./components/ui/ConfirmDialog";
import { editingElsewhere } from "./layout/dock";

/*
 * App keyboard shortcuts and the native menu bar. The bindings come from
 * the command registry (`src/commands/`), with the user's overrides from
 * the settings.
 */

/** Whether a key event is an app shortcut (so terminals leave it alone). */
export function isAppShortcut(event: KeyboardEvent): boolean {
  return commandForEvent(event) !== undefined;
}

/** Whether app shortcuts are suspended because something else owns the keyboard. */
export function shortcutsSuspended(): boolean {
  // A rename field or a confirmation owns the keyboard while it is open.
  return editingElsewhere() || isConfirming() || document.querySelector("[data-owns-keyboard]") !== null;
}

/** Starts handling shortcuts; returns a function that stops. */
export function installShortcuts(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (shortcutsSuspended()) return;
    const command = commandForEvent(event);
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    // Holding the keys down shouldn't open a tab or split per repeat.
    if (!event.repeat) {
      noteShortcutRun(command.id);
      runCommand(command.id);
    }
  };
  // Capture phase: runs before the focused terminal or any menu sees the key.
  window.addEventListener("keydown", onKeyDown, true);
  const uninstallMenu = installNativeMenu(shortcutsSuspended);
  return () => {
    uninstallMenu();
    window.removeEventListener("keydown", onKeyDown, true);
  };
}
