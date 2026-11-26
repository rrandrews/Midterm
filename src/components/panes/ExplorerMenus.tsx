import { openTerminalAt, renameOpenFiles } from "../../actions";
import { fileClipboard, setFileClipboard } from "../../explorer/clipboard";
import type { ExplorerModel } from "../../explorer/model";
import { linkablePanes, refollow } from "../../explorer/explorers";
import { baseName, parentPath, relativePath } from "../../explorer/tree";
import { isRemotePath, isRootLocation, posixPathOf, remoteIdOf } from "../../files/location";
import { copyText } from "../../ipc/clipboard";
import type { FsEntry } from "../../ipc/fs";
import { revealInFileManager } from "../../ipc/shell";
import { homeDirectory } from "../../ipc/system";
import { highlightPane, unhighlightPane } from "../../layout/paneHighlight";
import {
  displayLocation,
  getConnection,
  hostLabelForLocation,
  reconnectConnection,
} from "../../ssh/connections";
import { confirm } from "../ui/ConfirmDialog";
import type { MenuItemSpec } from "../../plugins/types";
import { MenuItem, MenuSeparator } from "../ui/Menu";

/** Asks, then moves local entries to Trash or permanently deletes remote SSH entries. */
export async function confirmTrash(model: ExplorerModel, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const what = paths.length === 1 ? `“${baseName(paths[0])}”` : `${paths.length} items`;
  if (paths.some(isRemotePath)) {
    const host = hostLabelForLocation(paths[0]) ?? "the remote host";
    const ok = await confirm({
      title: `Permanently delete ${what} on ${host}?`,
      message: "Remote SSH files cannot be moved to Trash. This cannot be undone.",
      action: "Delete",
    });
    if (ok) await model.deletePermanent(paths);
    return;
  }
  const ok = await confirm({
    title: `Move ${what} to the Trash?`,
    message: paths.length === 1 ? "You can put it back from the Trash in Finder." : "You can put them back from the Trash in Finder.",
    action: "Move to Trash",
  });
  if (ok) await model.trash(paths);
}

/** ⌘C / ⌘X: puts entries on the explorers' clipboard. */
export function copyEntries(paths: string[], cut: boolean): void {
  setFileClipboard({ paths, cut });
}

/** ⌘V: copies (or moves, after ⌘X) the clipboard's entries into `dir`. */
export async function pasteInto(model: ExplorerModel, dir: string): Promise<void> {
  const clipboard = fileClipboard();
  if (!clipboard) return;
  if (!clipboard.cut) {
    await transferEntries(model, clipboard.paths, dir, "copy");
    return;
  }
  // Cut entries move once, as in Finder; those that could not move stay on the clipboard to retry.
  setFileClipboard(null);
  const failed = await transferEntries(model, clipboard.paths, dir, "move");
  if (failed.length && !fileClipboard()) setFileClipboard({ paths: failed, cut: true });
}

/** Moves or copies entries into `dir`; files open in panes follow a move. Resolves to the paths that failed. */
export async function transferEntries(model: ExplorerModel, paths: string[], dir: string, mode: "move" | "copy"): Promise<string[]> {
  const { moves, failed } = await model.transfer(paths, dir, mode);
  for (const { from, to } of moves) renameOpenFiles(from, to);
  return failed;
}

/** ⌥⌘C: the POSIX paths as text, one per line (relative to `root` if asked and inside it). */
export function copyPaths(paths: string[], root?: string): void {
  void copyText(
    paths
      .map((path) => {
        const rel = root ? relativePath(path, root) : "";
        return rel || posixPathOf(path);
      })
      .join("\n"),
  );
}

type EntryMenuProps = {
  paneId: string;
  model: ExplorerModel;
  entry: FsEntry;
  /** What the commands apply to: the selection if the entry is in it, else the entry. */
  paths: string[];
  root: string;
  onOpen: (newPane: boolean) => void;
};

/** Right-click menu of a file or directory in the tree (or of several selected ones). */
export function EntryMenuItems({ paneId, model, entry, paths, root, onOpen }: EntryMenuProps) {
  const dir = entry.kind === "dir";
  const remote = isRemotePath(entry.path);
  const several = paths.length > 1;
  const relative = relativePath(entry.path, root);
  const pasteTarget = dir ? entry.path : parentPath(entry.path);
  return (
    <>
      {several ? null : dir ? (
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
          <MenuItem shortcut="⌘O" onSelect={() => onOpen(false)}>
            Open
          </MenuItem>
          <MenuItem onSelect={() => onOpen(true)}>Open in new pane</MenuItem>
          <MenuItem onSelect={() => openTerminalAt(parentPath(entry.path), paneId)}>
            Open folder in new terminal
          </MenuItem>
        </>
      )}
      {!remote && <MenuItem onSelect={() => revealInFileManager(entry.path)}>Reveal in Finder</MenuItem>}
      <MenuSeparator />
      <MenuItem shortcut="⌘X" onSelect={() => copyEntries(paths, true)}>
        Cut
      </MenuItem>
      <MenuItem shortcut="⌘C" onSelect={() => copyEntries(paths, false)}>
        Copy
      </MenuItem>
      <MenuItem shortcut="⌘V" disabled={!fileClipboard()} onSelect={() => void pasteInto(model, pasteTarget)}>
        {dir && !several ? "Paste into folder" : "Paste"}
      </MenuItem>
      <MenuItem onSelect={() => void model.duplicate(paths)}>Duplicate</MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="⌥⌘C" onSelect={() => copyPaths(paths)}>
        {several ? "Copy paths" : "Copy path"}
      </MenuItem>
      {(several || (relative && relative !== posixPathOf(entry.path))) && (
        <MenuItem onSelect={() => copyPaths(paths, root)}>{several ? "Copy relative paths" : "Copy relative path"}</MenuItem>
      )}
      <MenuSeparator />
      {!several && (
        <MenuItem shortcut="↩" onSelect={() => model.startRename(entry.path)}>
          Rename…
        </MenuItem>
      )}
      <MenuItem shortcut="⌘⌫" onSelect={() => void confirmTrash(model, paths)}>
        {remote
          ? several
            ? `Delete ${paths.length} items…`
            : "Delete…"
          : several
            ? `Move ${paths.length} items to Trash`
            : "Move to Trash"}
      </MenuItem>
    </>
  );
}

/**
 * "Link to terminal": follow the last focused terminal (the default), one
 * terminal in the tab (listed by directory; pointing at one outlines it), or
 * none (stay in this folder).
 */
function linkMenu(model: ExplorerModel): MenuItemSpec {
  const snap = model.snapshot();
  const home = homeDirectory();
  const terminals = linkablePanes(model.paneId);
  const labels = terminals.map(({ directory }) =>
    directory ? displayLocation(directory, home, { includeHost: true }) : "Terminal",
  );
  const follow = (link: string | null) => {
    model.setLink(link);
    refollow(model.paneId);
  };
  return {
    type: "submenu",
    label: "Link to terminal",
    items: [
      { label: "Last focused terminal", checked: !snap.pinned && !snap.link, run: () => follow(null) },
      { type: "separator" },
      ...terminals.map(({ pane }, index): MenuItemSpec => {
        const label = labels[index];
        // Two terminals in one directory: number them in layout order.
        const same = labels.filter((other) => other === label).length > 1;
        const nth = labels.slice(0, index + 1).filter((other) => other === label).length;
        return {
          label: same ? `${label} (${nth})` : label,
          checked: snap.link === pane.id,
          run: () => {
            unhighlightPane(pane.id);
            follow(pane.id);
          },
          onHighlight: (on) => (on ? highlightPane(pane.id) : unhighlightPane(pane.id)),
        };
      }),
      { type: "separator" },
      { label: "None (stay in this folder)", checked: snap.pinned, run: () => model.setPinned(true) },
    ],
  };
}

function showHiddenItem(model: ExplorerModel): MenuItemSpec {
  const { showHidden } = model.snapshot();
  return {
    label: "Show hidden files",
    checked: showHidden,
    checkSide: "right",
    keepOpen: true,
    run: () => model.setShowHidden(!model.snapshot().showHidden),
  };
}

/** The plugin's part of the pane's … menu. */
export function explorerOptionsMenu(model: ExplorerModel): MenuItemSpec[] {
  return [linkMenu(model), showHiddenItem(model)];
}

/**
 * Commands for the explorer as a whole: the right-click menu of its empty
 * area and of its top folder, and the plugin's part of the pane's
 * right-click menu.
 */
export function explorerMenu(model: ExplorerModel): MenuItemSpec[] {
  const root = model.snapshot().root;
  const rid = remoteIdOf(root);
  const remote = rid !== null;
  const conn = rid ? getConnection(rid) : undefined;
  const items: MenuItemSpec[] = [
    { label: "New file…", run: () => model.startCreate(root, "file") },
    { label: "New folder…", run: () => model.startCreate(root, "dir") },
    { label: "Paste", shortcut: "⌘V", disabled: !fileClipboard(), run: () => pasteInto(model, root) },
    { type: "separator" },
    linkMenu(model),
    {
      label: "Go to parent folder",
      disabled: isRootLocation(root),
      run: () => {
        model.setPinned(true);
        model.setRoot(parentPath(root));
      },
    },
    showHiddenItem(model),
    { label: "Collapse all", run: () => model.collapseAll() },
    { label: "Refresh", run: () => model.refresh() },
  ];
  if (rid && (!conn || conn.status === "disconnected")) {
    items.push({
      label: "Reconnect SSH",
      run: () =>
        void reconnectConnection(rid).catch((error) =>
          model.showError(`Could not reconnect: ${error instanceof Error ? error.message : String(error)}`),
        ),
    });
  }
  items.push({ type: "separator" });
  if (!remote) items.push({ label: "Reveal in Finder", run: () => revealInFileManager(root) });
  items.push(
    { label: "Open in new terminal", run: () => openTerminalAt(root, model.paneId) },
    { label: "Copy path", run: () => copyText(posixPathOf(root)) },
  );
  return items;
}
