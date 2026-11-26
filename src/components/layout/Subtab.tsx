import { Popover } from "radix-ui";
import { memo, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { Tip } from "../ui/Tooltip";
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
  const subtabIconOnly = plugin?.pane.subtabIconOnly;
  const iconOnly =
    !name && (typeof subtabIconOnly === "function" ? subtabIconOnly(pane) : subtabIconOnly === true);
  const [renaming, setRenaming] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const ctx = useMemo(() => createPaneContext(pane.id, kind), [pane.id, kind]);
  const selected = props["aria-selected"] === true;

  const show = () => {
    notePaneFocused(pane.id);
    useAppStore.getState().setActivePane(pane.id);
    focusPane(pane.id);
  };

  // Always keep `content` truthy so `Tip` never remounts the subtab node when the title length changes.
  const tipDisabled = renaming || (!iconOnly && label.length <= 24);
  const finishPopover = () => {
    const input = popoverRef.current?.querySelector<HTMLInputElement>("input");
    if (input) input.blur();
    else setRenaming(false);
  };

  return (
    <Popover.Root open={renaming}>
      {/* The menu acts on this pane by id; opening it changes neither the selection nor the active pane. */}
      <ContextMenu>
        <Tip content={label} disabled={tipDisabled} side="bottom">
          <ContextMenuTrigger asChild>
            <Popover.Anchor asChild>
              <div
                {...props}
                className={`subtab${iconOnly ? " is-icon-only" : ""}${renaming ? " is-renaming" : ""} ${props.className ?? ""}`}
                aria-label={iconOnly ? label : undefined}
                onClick={(event) => {
                  props.onClick?.(event);
                  // A click selects it (the library); the pane then takes the keyboard.
                  if (!renaming) queueMicrotask(show);
                }}
                onDoubleClick={() => setRenaming(true)}
              >
                <PluginIcon icon={plugin?.icon} size={13} className={selected ? "" : "opacity-80"} />
                {!iconOnly && <span className="subtab-label">{label}</span>}
              </div>
            </Popover.Anchor>
          </ContextMenuTrigger>
        </Tip>
        <ContextMenuContent aria-label="Subtab">
          {/* Open after the menu finishes closing and releases its focus trap. */}
          <MenuItem onSelect={() => setTimeout(() => setRenaming(true), 0)}>Rename subtab…</MenuItem>
          {name && <MenuItem onSelect={() => renameSubtab(pane.id, "")}>Clear subtab name</MenuItem>}
          <MenuSeparator />
          <PaneMenuItems paneId={pane.id} ctx={ctx} />
        </ContextMenuContent>
      </ContextMenu>
      {renaming && (
        <Popover.Portal>
          <Popover.Content
            ref={popoverRef}
            aria-label="Rename subtab"
            side="bottom"
            align="start"
            sideOffset={2}
            collisionPadding={8}
            hideWhenDetached
            className="subtab-rename-popover"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => event.preventDefault()}
            onPointerDownOutside={finishPopover}
            onPointerDown={(event) => {
              // Clicking the icon or padding keeps focus in the text field instead of blurring it.
              if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
            }}
          >
            <PluginIcon icon={plugin?.icon} size={13} className="text-fg-soft" />
            <InlineEdit
              label="Subtab name (empty to name it automatically)"
              allowEmpty
              value={label}
              className="subtab-rename-input"
              onCommit={(next) => renameSubtab(pane.id, next)}
              onDone={() => {
                setRenaming(false);
                refocusPane();
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );
});
