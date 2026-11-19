import { useEffect } from "react";
import { dropPaneOnTab, focusActivePane } from "./actions";
import { PaneLayout } from "./components/layout/PaneLayout";
import { TitleBar } from "./components/titlebar/TitleBar";
import { ConfirmHost } from "./components/ui/ConfirmDialog";
import { installCloseGuards } from "./ipc/window";
import { mayCloseEverything } from "./closing";
import { flushSavedState } from "./state/persistence";
import { installFocusKeeper } from "./layout/dock";
import { installPaneDropTargets } from "./layout/paneDrag";
import { installShortcuts } from "./shortcuts";
import { selectActiveTab, useAppStore } from "./state/store";

/**
 * The webview's own context menu (Reload, Inspect Element…) means nothing
 * in the app, so it only appears in text fields, where it has Cut, Copy and
 * Paste. Areas with menus of their own have already handled the event. In
 * dev builds ⌥-right-click still opens it, for Inspect Element.
 */
function suppressNativeContextMenu(): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented || (import.meta.env.DEV && event.altKey)) return;
    const target = event.target;
    const textField =
      target instanceof HTMLInputElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    if (!textField) event.preventDefault();
  };
  window.addEventListener("contextmenu", onContextMenu);
  return () => window.removeEventListener("contextmenu", onContextMenu);
}

export default function App() {
  const tab = useAppStore(selectActiveTab);

  useEffect(() => {
    const uninstallShortcuts = installShortcuts();
    const uninstallFocusKeeper = installFocusKeeper();
    const uninstallContextMenuGuard = suppressNativeContextMenu();
    const uninstallDropTargets = installPaneDropTargets(dropPaneOnTab);
    const uninstallCloseGuards = installCloseGuards(async (what) => {
      const ok = await mayCloseEverything(what);
      // Nothing may be lost to the save debounce.
      if (ok) await flushSavedState();
      return ok;
    });
    focusActivePane();
    return () => {
      uninstallDropTargets();
      uninstallCloseGuards();
      uninstallShortcuts();
      uninstallFocusKeeper();
      uninstallContextMenuGuard();
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <main className="flex min-h-0 flex-1">
        {/* Only the active tab's layout is mounted; see PaneLayout for the key. */}
        <PaneLayout key={`${tab.id}:${tab.layoutRev}`} tab={tab} />
      </main>
      <ConfirmHost />
    </div>
  );
}
