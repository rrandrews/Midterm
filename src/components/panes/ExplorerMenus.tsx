import { openTerminalAt } from "../../actions";
import type { ExplorerModel } from "../../explorer/model";
import { refollow } from "../../explorer/explorers";
import { baseName, parentPath, relativePath } from "../../explorer/tree";
import { copyText } from "../../ipc/clipboard";
import type { FsEntry } from "../../ipc/fs";
import { revealInFileManager } from "../../ipc/shell";
import { confirm } from "../ui/ConfirmDialog";
import type { MenuItemSpec } from "../../plugins/types";
import { MenuItem, MenuSeparator } from "../ui/Menu";

/** Asks, then moves entries to the Trash. */
export async function confirmTrash(model: ExplorerModel, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const what = paths.length === 1 ? `“${baseName(paths[0])}”` : `${paths.length} items`;
  const ok = await confirm({
    title: `Move ${what} to the Trash?`,
    message: "You can put it back from the Trash in Finder.",
    action: "Move to Trash",
  });
  if (ok) await model.trash(paths);
}

type EntryMenuProps = {
  paneId: string;
  model: ExplorerModel;
  entry: FsEntry;
  root: string;
  onOpen: (newPane: boolean) => void;
};

/** Right-click menu of a file or directory in the tree. */
export function EntryMenuItems({ paneId, model, entry, root, onOpen }: EntryMenuProps) {
  const dir = entry.kind === "dir";
  const relative = relativePath(entry.path, root);
  return (
    <>
      {dir ? (
        <>
          <MenuItem onSelect={() => model.startCreate(entry.path, "file")}>New file…</MenuItem>
          <MenuItem onSelect={() => model.startCreate(entry.path, "dir")}>New folder…</MenuItem>
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              model.setPinned(true);
              model.setRoot(entry.path);
            }}
          >
            Show only this folder
          </MenuItem>
          <MenuItem onSelect={() => openTerminalAt(entry.path, paneId)}>Open in new terminal</MenuItem>
        </>
      ) : (
        <>
          <MenuItem shortcut="↩" onSelect={() => onOpen(false)}>
            Open
          </MenuItem>
          <MenuItem onSelect={() => onOpen(true)}>Open in new pane</MenuItem>
          <MenuItem onSelect={() => openTerminalAt(parentPath(entry.path), paneId)}>
            Open folder in new terminal
          </MenuItem>
        </>
      )}
      <MenuItem onSelect={() => revealInFileManager(entry.path)}>Reveal in Finder</MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => void copyText(entry.path)}>Copy path</MenuItem>
      {relative && relative !== entry.path && (
        <MenuItem onSelect={() => void copyText(relative)}>Copy relative path</MenuItem>
      )}
      <MenuSeparator />
      <MenuItem shortcut="F2" onSelect={() => model.startRename(entry.path)}>
        Rename…
      </MenuItem>
      <MenuItem shortcut="⌘⌫" onSelect={() => void confirmTrash(model, [entry.path])}>
        Move to Trash
      </MenuItem>
    </>
  );
}

/**
 * Commands for the explorer as a whole: its empty area's right-click menu,
 * and the plugin's part of the pane's menu.
 */
export function explorerMenu(model: ExplorerModel): MenuItemSpec[] {
  const snap = model.snapshot();
  const root = snap.root;
  return [
    { label: "New file…", run: () => model.startCreate(root, "file") },
    { label: "New folder…", run: () => model.startCreate(root, "dir") },
    { type: "separator" },
    {
      label: "Pin folder",
      checked: snap.pinned,
      run: () => {
        model.setPinned(!snap.pinned);
        // Unpinned: jump to the focused terminal's directory now.
        if (snap.pinned) refollow(model.paneId);
      },
    },
    {
      label: "Go to parent folder",
      disabled: root === "/",
      run: () => {
        model.setPinned(true);
        model.setRoot(parentPath(root));
      },
    },
    { label: "Show hidden and ignored files", checked: snap.showHidden, run: () => model.setShowHidden(!snap.showHidden) },
    { label: "Collapse all", run: () => model.collapseAll() },
    { label: "Refresh", run: () => model.refresh() },
    { type: "separator" },
    { label: "Reveal in Finder", run: () => revealInFileManager(root) },
    { label: "Copy path", run: () => copyText(root) },
  ];
}
