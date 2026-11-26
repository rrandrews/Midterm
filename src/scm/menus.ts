import { openTerminalAt } from "../actions";
import { parentPath } from "../explorer/tree";
import { isRemotePath, isRootLocation, posixPathOf, remoteIdOf } from "../files/location";
import { copyText } from "../ipc/clipboard";
import { revealInFileManager } from "../ipc/shell";
import { homeDirectory } from "../ipc/system";
import { highlightPane, unhighlightPane } from "../layout/paneHighlight";
import type { MenuItemSpec } from "../plugins/types";
import { displayLocation, getConnection, reconnectConnection } from "../ssh/connections";
import type { ScmModel } from "./model";
import { linkableScmPanes, refollowScm } from "./registry";

/*
 * Context and options menu definitions for Source Control sidebar panes.
 */

function linkMenu(model: ScmModel): MenuItemSpec {
  const snap = model.snapshot();
  const home = homeDirectory();
  const terminals = linkableScmPanes(model.paneId);
  const labels = terminals.map(({ directory }) =>
    directory ? displayLocation(directory, home, { includeHost: true }) : "Terminal",
  );
  const follow = (link: string | null) => {
    model.setLink(link);
    refollowScm(model.paneId);
  };
  return {
    type: "submenu",
    label: "Link to terminal",
    items: [
      { label: "Last focused terminal", checked: !snap.pinned && !snap.link, run: () => follow(null) },
      { type: "separator" },
      ...terminals.map(({ pane }, index): MenuItemSpec => {
        const label = labels[index];
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

function viewModeItem(model: ScmModel): MenuItemSpec {
  const tree = model.snapshot().viewMode === "tree";
  return {
    label: "View as tree",
    checked: tree,
    checkSide: "right",
    keepOpen: true,
    run: () => model.setViewMode(model.snapshot().viewMode === "tree" ? "list" : "tree"),
  };
}

export function scmOptionsMenu(model: ScmModel): MenuItemSpec[] {
  return [linkMenu(model), viewModeItem(model)];
}

export function scmPaneMenu(model: ScmModel): MenuItemSpec[] {
  const snap = model.snapshot();
  const root = snap.status?.root ?? snap.root;
  const rid = remoteIdOf(root);
  const remote = isRemotePath(root);
  const conn = rid ? getConnection(rid) : undefined;
  const hasRepo = snap.status !== null;

  const items: MenuItemSpec[] = [
    { label: "Refresh", run: () => void model.refresh({ includeMeta: true }) },
    linkMenu(model),
    viewModeItem(model),
  ];

  if (hasRepo) {
    items.push(
      { type: "separator" },
      { label: "Fetch", run: () => void model.fetch(false) },
      { label: "Fetch (Prune)", run: () => void model.fetch(true) },
      { label: "Pull", run: () => void model.pull(false) },
      { label: "Pull (Rebase)", run: () => void model.pull(true) },
      { label: "Push", run: () => void model.push() },
      { label: "Push (Force with Lease)", run: () => void model.push({ forceWithLease: true }) },
      { type: "separator" },
      { label: "Stage all changes", run: () => void model.stageAll() },
      { label: "Unstage all changes", run: () => void model.unstageAll() },
      { label: "Undo last commit", disabled: snap.commits.length === 0, run: () => void model.undoLastCommit() },
    );
  } else {
    items.push({
      label: "Go to parent folder",
      disabled: isRootLocation(root),
      run: () => {
        model.setPinned(true);
        model.setRoot(parentPath(root));
      },
    });
  }

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
    { label: "Copy repository path", run: () => copyText(posixPathOf(root)) },
  );
  return items;
}
