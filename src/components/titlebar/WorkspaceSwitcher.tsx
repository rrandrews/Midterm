import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { newWorkspace, selectWorkspace } from "../../actions";
import { removeWorkspace } from "../../closing";
import { refocusPane } from "../../layout/dock";
import { openSettings } from "../../settings/SettingsDialog";
import { selectActiveWorkspace, useAppStore } from "../../state/store";
import { WorkspaceBadge } from "../../workspaces/WorkspaceBadge";
import { InlineEdit } from "../ui/InlineEdit";
import { Tip } from "../ui/Tooltip";
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

/*
 * The workspace switcher at the left of the title bar: a + that creates a
 * workspace (and lets you name it), and a dropdown of the workspaces with
 * Delete at the bottom. Right-clicking the switcher renames the workspace
 * or opens its settings (name, icon, overrides, environment).
 */

const FRAME = "flex flex-none items-center border-r border-line pr-2 pl-0.5";

const ADD =
  "flex size-5 flex-none items-center justify-center rounded-[5px] text-fg-dim outline-none " +
  "hover:bg-hover hover:text-fg-bright focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]";

export function WorkspaceSwitcher() {
  const workspaces = useAppStore((state) => state.workspaces);
  const active = useAppStore(selectActiveWorkspace);
  const renameWorkspace = useAppStore((state) => state.renameWorkspace);
  const [renaming, setRenaming] = useState(false);

  const add = () => {
    newWorkspace();
    // A new workspace starts with its name selected, ready to type over.
    setRenaming(true);
  };

  if (renaming) {
    return (
      <div className={FRAME}>
        {/* Holds the +'s place, so the badge does not move. */}
        <span className="size-5 flex-none" aria-hidden="true" />
        <div className="ml-0.5 flex h-6 items-center gap-2 pl-1.5 font-medium">
          <WorkspaceBadge workspace={active} />
          <InlineEdit
            label="Workspace name"
            value={active.name}
            onCommit={(name) => renameWorkspace(active.id, name)}
            onDone={() => {
              setRenaming(false);
              refocusPane();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={FRAME}>
      <Tip content="New workspace">
        <button type="button" aria-label="New workspace" className={ADD} onClick={add}>
          <Plus size={13} strokeWidth={2} />
        </button>
      </Tip>
      <ContextMenu>
        <Menu>
          <ContextMenuTrigger asChild>
            <MenuTrigger
              className="ml-0.5 flex h-6 items-center gap-2 rounded-[5px] pr-1.5 pl-1.5 font-medium text-fg outline-none hover:bg-hover/68 data-[state=open]:bg-hover/68"
              aria-label={`Switch workspace: ${active.name}`}
            >
              <WorkspaceBadge workspace={active} />
              <span className="max-w-40 truncate">{active.name}</span>
              <ChevronDown size={12} strokeWidth={2} className="text-fg-dim" aria-hidden="true" />
            </MenuTrigger>
          </ContextMenuTrigger>
          <MenuContent align="start">
            {workspaces.map((workspace) => (
              <MenuItem
                key={workspace.id}
                checked={workspace.id === active.id}
                onSelect={() => selectWorkspace(workspace.id)}
              >
                <span className="flex items-center gap-2">
                  <WorkspaceBadge workspace={workspace} size="md" />
                  <span className="truncate">{workspace.name}</span>
                </span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem danger disabled={workspaces.length <= 1} onSelect={() => void removeWorkspace(active.id)}>
              <span className="flex items-center gap-2">
                <Trash2 size={13} strokeWidth={1.9} aria-hidden="true" />
                Delete workspace
              </span>
            </MenuItem>
          </MenuContent>
        </Menu>
        <ContextMenuContent aria-label="Workspace">
          <MenuItem onSelect={() => setRenaming(true)}>Rename workspace</MenuItem>
          <MenuItem onSelect={() => openSettings("workspace", active.id)}>Settings…</MenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
