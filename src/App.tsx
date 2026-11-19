import { useEffect } from "react";
import { focusActivePane } from "./actions";
import { PaneLayout } from "./components/layout/PaneLayout";
import { TitleBar } from "./components/titlebar/TitleBar";
import { installFocusKeeper } from "./layout/dock";
import { installShortcuts } from "./shortcuts";
import { selectActiveTab, useAppStore } from "./state/store";

export default function App() {
  const tab = useAppStore(selectActiveTab);

  useEffect(() => {
    const uninstallShortcuts = installShortcuts();
    const uninstallFocusKeeper = installFocusKeeper();
    focusActivePane();
    return () => {
      uninstallShortcuts();
      uninstallFocusKeeper();
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <main className="flex min-h-0 flex-1">
        {/* Only the active tab's layout is mounted; see PaneLayout for the key. */}
        <PaneLayout key={`${tab.id}:${tab.layoutRev}`} tab={tab} />
      </main>
    </div>
  );
}
