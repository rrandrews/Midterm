import { Search } from "lucide-react";
import { closeTab, newTab, newWorkspace, splitPane } from "../../actions";
import { refocusPane } from "../../layout/dock";
import { DotsIcon } from "../ui/icons";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../ui/Menu";
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
      <MenuContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          refocusPane();
        }}
      >
        <MenuItem shortcut="⌘T" onSelect={newTab}>
          New tab
        </MenuItem>
        <MenuItem onSelect={newWorkspace}>New workspace</MenuItem>
        <MenuSeparator />
        <MenuItem shortcut="⌘D" onSelect={() => splitPane("right")}>
          Split right
        </MenuItem>
        <MenuItem shortcut="⇧⌘D" onSelect={() => splitPane("bottom")}>
          Split down
        </MenuItem>
        <MenuSeparator />
        <MenuItem shortcut="⇧⌘W" onSelect={() => closeTab()}>
          Close tab
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/**
 * The window's title bar, which is also the tab bar. Empty areas drag the
 * window; the native traffic lights sit over the gutter on the left.
 */
export function TitleBar() {
  return (
    <header
      data-tauri-drag-region
      className="flex h-(--titlebar-height) flex-none items-stretch border-b border-line"
    >
      <div data-tauri-drag-region className="w-[68px] flex-none" aria-hidden="true" />
      <WorkspaceSwitcher />
      <TabStrip />
      <div data-tauri-drag-region className="min-w-4 flex-1" aria-hidden="true" />
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-1 pr-2.5">
        {/* Opens the command palette once that exists (see docs/roadmap.md). */}
        <button
          type="button"
          disabled
          title="Command palette — not available yet"
          className="flex h-6 w-[260px] min-w-24 shrink cursor-default items-center gap-2 rounded-md bg-field px-2 text-fg-dim shadow-[inset_0_0_0_1px_var(--color-line)]"
        >
          <Search size={13} strokeWidth={2} aria-hidden="true" />
          <span className="flex-1 truncate text-left">Run a command or open a file</span>
          <span className="font-mono text-micro text-fg-muted">⌘K</span>
        </button>
        <AppMenu />
      </div>
    </header>
  );
}
