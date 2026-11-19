import { removeWorkspace } from "../../closing";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { newWorkspace, selectWorkspace } from "../../actions";
import { refocusPane } from "../../layout/dock";
import { selectActiveWorkspace, useAppStore } from "../../state/store";
import { InlineEdit } from "../ui/InlineEdit";
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

function Badge({ name }: { name: string }) {
  return (
    <span className="flex size-3.5 flex-none items-center justify-center rounded-[4px] bg-accent text-badge font-bold text-app">
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** New, rename and delete: in the switcher's menu and its right-click menu. */
function WorkspaceCommands({ onRename }: { onRename: () => void }) {
  const workspaces = useAppStore((state) => state.workspaces);
  const active = useAppStore(selectActiveWorkspace);
  return (
    <>
      <MenuItem onSelect={newWorkspace}>New workspace</MenuItem>
      <MenuItem onSelect={onRename}>Rename workspace</MenuItem>
      <MenuItem disabled={workspaces.length <= 1} onSelect={() => void removeWorkspace(active.id)}>
        Delete workspace
      </MenuItem>
    </>
  );
}

const FRAME = "flex flex-none items-center gap-2 border-r border-line pr-3 pl-1.5 font-medium";

export function WorkspaceSwitcher() {
  const workspaces = useAppStore((state) => state.workspaces);
  const active = useAppStore(selectActiveWorkspace);
  const renameWorkspace = useAppStore((state) => state.renameWorkspace);
  const [renaming, setRenaming] = useState(false);

  if (renaming) {
    return (
      <div className={FRAME}>
        <Badge name={active.name} />
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
    );
  }

  const startRenaming = () => setRenaming(true);

  return (
    <ContextMenu>
      <Menu>
        <ContextMenuTrigger asChild>
          <MenuTrigger
            className={`${FRAME} text-fg outline-none data-[state=open]:bg-white/[0.04]`}
            aria-label={`Switch workspace: ${active.name}`}
          >
            <Badge name={active.name} />
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
              {workspace.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <WorkspaceCommands onRename={startRenaming} />
        </MenuContent>
      </Menu>
      <ContextMenuContent aria-label="Workspace">
        <WorkspaceCommands onRename={startRenaming} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
