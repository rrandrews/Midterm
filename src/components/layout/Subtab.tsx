import { memo, useMemo, useState, useSyncExternalStore } from "react";
import type { TabRenderProps } from "react-resizable-panels";
import { renameSubtab } from "../../actions";
import { focusPane, notePaneFocused, refocusPane } from "../../layout/dock";
import { createPaneContext } from "../../plugins/PaneHost";
import { PluginIcon } from "../../plugins/PluginIcon";
import { getPlugin, kindLabel, usePluginsVersion } from "../../plugins/registry";
import { paneTitle, subscribeTitles } from "../../plugins/tabTitles";
import { paneName } from "../../state/layout";
import { useAppStore } from "../../state/store";
import type { PaneNode } from "../../state/types";
import { InlineEdit } from "../ui/InlineEdit";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, MenuItem, MenuSeparator } from "../ui/Menu";
import { PaneMenuItems } from "./PaneMenuItems";

/*
 * One subtab in a frame's strip: the plugin's icon, then the name the user
 * gave it, else (unless the plugin asks for icon-only subtabs) the pane's
 * own title or the plugin's name. Right-click to rename it; the rest of the
 * menu is the pane's. The library owns selection, keyboard and dragging
 * through `props`, which go on the outermost element.
 */

/** What an unnamed subtab is called: the pane's `tabTitle`, else its plugin's name. */
function autoLabel(pane: PaneNode): string {
  return paneTitle(pane) ?? kindLabel(pane.data.kind);
}

export const Subtab = memo(function Subtab({ pane, props }: { pane: PaneNode; props: TabRenderProps }) {
  usePluginsVersion();
  const { kind } = pane.data;
  const registered = getPlugin(kind);
  const plugin = registered?.plugin;
  // Recomputed with tab titles (a terminal's program or directory changes).
  const auto = useSyncExternalStore(subscribeTitles, () => autoLabel(pane));
  const name = paneName(pane);
  const label = name ?? auto;
  const iconOnly = !name && plugin?.pane.subtabIconOnly === true;
  const [renaming, setRenaming] = useState(false);
  const ctx = useMemo(() => createPaneContext(pane.id, kind), [pane.id, kind]);
  const selected = props["aria-selected"] === true;

  const show = () => {
    notePaneFocused(pane.id);
    useAppStore.getState().setActivePane(pane.id);
    focusPane(pane.id);
  };

  return (
    // The menu acts on this pane by id; opening it changes neither the selection nor the active pane.
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          {...props}
          className={`subtab${iconOnly ? " is-icon-only" : ""} ${props.className ?? ""}`}
          title={iconOnly || label.length > 24 ? label : undefined}
          aria-label={iconOnly ? label : undefined}
          onClick={(event) => {
            props.onClick?.(event);
            // A click selects it (the library); the pane then takes the keyboard.
            if (!renaming) queueMicrotask(show);
          }}
          onDoubleClick={() => setRenaming(true)}
        >
          <PluginIcon icon={plugin?.icon} size={13} className={selected ? "" : "opacity-80"} />
          {renaming ? (
            <InlineEdit
              label="Subtab name (empty to name it automatically)"
              allowEmpty
              value={label}
              className="max-w-40 text-meta"
              onCommit={(next) => renameSubtab(pane.id, next)}
              onDone={() => {
                setRenaming(false);
                refocusPane();
              }}
            />
          ) : (
            !iconOnly && <span className="subtab-label">{label}</span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Subtab">
        <MenuItem onSelect={() => setRenaming(true)}>Rename subtab…</MenuItem>
        {name && <MenuItem onSelect={() => renameSubtab(pane.id, "")}>Clear subtab name</MenuItem>}
        <MenuSeparator />
        <PaneMenuItems paneId={pane.id} ctx={ctx} />
      </ContextMenuContent>
    </ContextMenu>
  );
});
