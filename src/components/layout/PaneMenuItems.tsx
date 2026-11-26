import { openAgent, promptForAgent } from "../../ai/agent/actions";
import { addSubtab, movePaneToNewTab, movePaneToTab, splitPane, toggleMaximizePane } from "../../actions";
import { changePaneKind, closePane } from "../../closing";
import { shortcutLabel } from "../../commands/registry";
import { getDock } from "../../layout/dock";
import { hiddenMenuItems } from "../../plugins/paneMenu";
import { enabledPlugins } from "../../plugins/registry";
import { HIDEABLE_PANE_MENU_ITEMS, type HideablePaneMenuItem, type PaneContext } from "../../plugins/types";
import { openSettings } from "../../settings/dialogState";
import { countFrames, countPanes, findPane, frameIdOf } from "../../state/layout";
import { findTabOfPane, selectActiveWorkspace, useAppStore } from "../../state/store";
import { PluginIcon } from "../../plugins/PluginIcon";
import { MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger } from "../ui/Menu";

/**
 * The commands that apply to any pane, for its toolbar menu and its
 * right-click menu. They go below the plugin's own items, starting with
 * the plugin's "Settings…" and a divider. Menu content only mounts while the menu is open, so this
 * reads the store directly instead of subscribing.
 */
export function PaneMenuItems({ paneId, ctx }: { paneId: string; ctx?: PaneContext }) {
  const state = useAppStore.getState();
  const tab = findTabOfPane(state, paneId);
  if (!tab) return null;
  const layout = getDock(tab)?.getModel() ?? tab.layout;
  const kind = findPane(layout, paneId)?.data.kind;
  // Alone in its tab: nowhere to move from. The only frame: nothing to maximize over.
  const alone = countPanes(layout) <= 1;
  const onlyFrame = countFrames(layout) <= 1;
  const maximized = layout.maximizedTabsetId === frameIdOf(layout, paneId);
  const otherTabs = selectActiveWorkspace(state).tabs.filter((other) => other.id !== tab.id);
  const hidden = hiddenMenuItems(kind, ctx);
  const shown = (item: HideablePaneMenuItem) => !hidden.has(item);
  const anyShown = HIDEABLE_PANE_MENU_ITEMS.some(shown);

  return (
    <>
      {kind && (
        // After the menu has closed and handed focus back, so the dialog keeps it.
        <MenuItem onSelect={() => setTimeout(() => openSettings(`plugin:${kind}`), 0)}>Settings…</MenuItem>
      )}
      {kind && <MenuSeparator />}
      {shown("splitRight") && (
        <MenuItem shortcut={shortcutLabel("pane.splitRight")} onSelect={() => splitPane("right", paneId)}>
          Split right
        </MenuItem>
      )}
      {shown("splitDown") && (
        <MenuItem shortcut={shortcutLabel("pane.splitDown")} onSelect={() => splitPane("bottom", paneId)}>
          Split down
        </MenuItem>
      )}
      {shown("newSubtab") && (
        <MenuSub>
          <MenuSubTrigger>New subtab</MenuSubTrigger>
          <MenuSubContent>
            {enabledPlugins().map((option) => (
              <MenuItem
                key={option.id}
                shortcut={shortcutLabel(`pane.newSubtab.${option.id}`)}
                onSelect={() => addSubtab(option.id, paneId)}
              >
                <span className="flex items-center gap-2">
                  <PluginIcon icon={option.icon} size={13} className="text-fg-dim" />
                  {option.name}
                </span>
              </MenuItem>
            ))}
          </MenuSubContent>
        </MenuSub>
      )}
      {shown("changeType") && (
        <MenuSub>
          <MenuSubTrigger>Change pane type</MenuSubTrigger>
          <MenuSubContent>
            {enabledPlugins().map((option) => (
              <MenuItem
                key={option.id}
                checked={kind === option.id}
                onSelect={() => void changePaneKind(paneId, option.id)}
              >
                {option.name}
              </MenuItem>
            ))}
          </MenuSubContent>
        </MenuSub>
      )}
      {shown("agent") && (
        <MenuSub>
          <MenuSubTrigger>Agent</MenuSubTrigger>
          <MenuSubContent>
            <MenuItem shortcut={shortcutLabel("ai.askAgent")} onSelect={() => promptForAgent(paneId)}>
              Ask the agent about this pane…
            </MenuItem>
            <MenuItem shortcut={shortcutLabel("ai.openAgent")} onSelect={() => openAgent(paneId)}>
              Open the agent pane
            </MenuItem>
          </MenuSubContent>
        </MenuSub>
      )}
      {shown("maximize") && (
        <MenuItem shortcut={shortcutLabel("pane.toggleMaximize")} disabled={onlyFrame} onSelect={() => toggleMaximizePane(paneId)}>
          {maximized ? "Restore pane" : "Maximize pane"}
        </MenuItem>
      )}
      {shown("moveToTab") && (
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
      )}
      {anyShown && <MenuSeparator />}
      <MenuItem shortcut={shortcutLabel("pane.close")} onSelect={() => void closePane(paneId)}>
        Close pane
      </MenuItem>
    </>
  );
}
