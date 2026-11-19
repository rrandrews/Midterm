import { closeTab } from "../../closing";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { newTab, newWorkspace, splitPane } from "../../actions";
import { shortcutLabel } from "../../commands/registry";
import { watchFullscreen } from "../../ipc/window";
import { openPalette } from "../../palette/state";
import { openSettings } from "../../settings/SettingsDialog";
import { DotsIcon } from "../ui/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/Menu";
import { TabStrip } from "./TabStrip";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

function AppMenu() {
  return (
    <Menu>
      <MenuTrigger
        aria-label="App menu"
        className="flex rounded-[5px] p-1.5 text-fg-muted outline-none hover:text-fg-bright data-[state=open]:bg-raised data-[state=open]:text-fg"
      >
        <DotsIcon size={15} radius={1.6} />
      </MenuTrigger>
      <MenuContent>
        <MenuItem shortcut={shortcutLabel("tab.new")} onSelect={newTab}>
          New tab
        </MenuItem>
        <MenuItem onSelect={newWorkspace}>New workspace</MenuItem>
        <MenuSeparator />
        <MenuItem shortcut={shortcutLabel("pane.splitRight")} onSelect={() => splitPane("right")}>
          Split right
        </MenuItem>
        <MenuItem shortcut={shortcutLabel("pane.splitDown")} onSelect={() => splitPane("bottom")}>
          Split down
        </MenuItem>
        <MenuSeparator />
        <MenuItem shortcut={shortcutLabel("tab.close")} onSelect={() => closeTab()}>
          Close tab
        </MenuItem>
        <MenuSeparator />
        <MenuItem shortcut={shortcutLabel("palette.open")} onSelect={() => openPalette("all")}>
          Command palette
        </MenuItem>
        <MenuItem shortcut={shortcutLabel("settings.open")} onSelect={() => openSettings()}>
          Settings…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/**
 * The window's title bar, which is also the tab bar. Empty areas drag the
 * window; the native traffic lights sit over the gutter on the left, which
 * collapses in fullscreen, where macOS hides them. Right-clicking an empty
 * part offers to open a tab or workspace (tabs and the workspace switcher
 * have menus of their own).
 */
export function TitleBar() {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => watchFullscreen(setFullscreen), []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <header
          data-tauri-drag-region
          className="box-content flex h-(--titlebar-height) flex-none items-stretch border-b border-line"
        >
          <div
            data-tauri-drag-region
            className={fullscreen ? "w-1.5 flex-none" : "w-[82px] flex-none"}
            aria-hidden="true"
          />
          <WorkspaceSwitcher />
          <TabStrip />
          <div data-tauri-drag-region className="min-w-4 flex-1" aria-hidden="true" />
          <div data-tauri-drag-region className="flex min-w-0 items-center gap-1 pr-2.5">
            <button
              type="button"
              onClick={() => openPalette("all")}
              title="Command palette"
              className="flex h-6 w-[260px] min-w-24 shrink items-center gap-2 rounded-md bg-field px-2 text-fg-dim shadow-[inset_0_0_0_1px_var(--color-line)] outline-none hover:text-fg-mid"
            >
              <Search size={13} strokeWidth={2} aria-hidden="true" />
              <span className="flex-1 truncate text-left">Run a command or open a file</span>
              <span className="font-mono text-micro text-fg-muted">{shortcutLabel("palette.open")}</span>
            </button>
            <AppMenu />
          </div>
        </header>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Title bar">
        <MenuItem shortcut={shortcutLabel("tab.new")} onSelect={newTab}>
          New tab
        </MenuItem>
        <MenuItem onSelect={newWorkspace}>New workspace</MenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
