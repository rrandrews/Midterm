import { movePaneToNewTab, movePaneToTab, splitPane, toggleMaximizePane } from "../../actions";
import { changePaneKind, closePane } from "../../closing";
import { getDock } from "../../layout/dock";
import { PANE_LABELS, countPanes, findPane, frameIdOf } from "../../state/layout";
import { findTabOfPane, selectActiveWorkspace, useAppStore } from "../../state/store";
import { PANE_KINDS } from "../../state/types";
import { MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger } from "../ui/Menu";

/**
 * The commands that apply to any pane, for its toolbar menu and its
 * right-click menu. Menu content only mounts while the menu is open, so this
 * reads the store directly instead of subscribing.
 */
export function PaneMenuItems({ paneId }: { paneId: string }) {
  const state = useAppStore.getState();
  const tab = findTabOfPane(state, paneId);
  if (!tab) return null;
  const layout = getDock(tab)?.getModel() ?? tab.layout;
  const kind = findPane(layout, paneId)?.data.kind;
  // Alone in its tab: nothing to maximize over and nowhere to move from.
  const alone = countPanes(layout) <= 1;
  const maximized = layout.maximizedTabsetId === frameIdOf(layout, paneId);
  const otherTabs = selectActiveWorkspace(state).tabs.filter((other) => other.id !== tab.id);

  return (
    <>
      <MenuItem shortcut="⌘D" onSelect={() => splitPane("right", paneId)}>
        Split right
      </MenuItem>
      <MenuItem shortcut="⇧⌘D" onSelect={() => splitPane("bottom", paneId)}>
        Split down
      </MenuItem>
      <MenuSub>
        <MenuSubTrigger>Change pane type</MenuSubTrigger>
        <MenuSubContent>
          {PANE_KINDS.map((option) => (
            <MenuItem
              key={option}
              checked={kind === option}
              onSelect={() => void changePaneKind(paneId, option)}
            >
              {PANE_LABELS[option]}
            </MenuItem>
          ))}
        </MenuSubContent>
      </MenuSub>
      <MenuItem shortcut="⇧⌘↩" disabled={alone} onSelect={() => toggleMaximizePane(paneId)}>
        {maximized ? "Restore pane" : "Maximize pane"}
      </MenuItem>
      <MenuSub>
        <MenuSubTrigger>Move to tab</MenuSubTrigger>
        <MenuSubContent>
          {otherTabs.map((other) => (
            <MenuItem key={other.id} onSelect={() => movePaneToTab(paneId, other.id)}>
              {other.title}
            </MenuItem>
          ))}
          {otherTabs.length > 0 && <MenuSeparator />}
          <MenuItem disabled={alone} onSelect={() => movePaneToNewTab(paneId)}>
            New tab
          </MenuItem>
        </MenuSubContent>
      </MenuSub>
      <MenuSeparator />
      <MenuItem shortcut="⌘W" onSelect={() => void closePane(paneId)}>
        Close pane
      </MenuItem>
    </>
  );
}
