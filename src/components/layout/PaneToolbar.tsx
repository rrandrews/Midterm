import { useMemo } from "react";
import { TabsetDragHandle } from "react-resizable-panels";
import { notePaneFocused } from "../../layout/dock";
import { createPaneContext, PluginMenuItems } from "../../plugins/PaneHost";
import { activePlugin } from "../../plugins/registry";
import { useAppStore } from "../../state/store";
import type { PaneNode } from "../../state/types";
import { DotsIcon, GripIcon } from "../ui/icons";
import { Menu, MenuContent, MenuTrigger } from "../ui/Menu";
import { PaneMenuItems } from "./PaneMenuItems";

/**
 * A pane's hover controls: the options menu, then the drag handle in the
 * corner. In a subtab strip (`strip`), the empty space before them drags
 * the frame too: the library only starts a frame drag from a drag handle.
 */
export function PaneToolbar({ pane, strip = false }: { pane: PaneNode; strip?: boolean }) {
  const { kind } = pane.data;
  const ctx = useMemo(() => createPaneContext(pane.id, kind), [pane.id, kind]);
  return (
    <div className={strip ? "flex flex-1 items-center gap-0.5 self-stretch" : "flex gap-0.5"}>
      {strip && <TabsetDragHandle aria-hidden="true" tabIndex={-1} title="" className="subtab-gap" />}
      <Menu
        onOpenChange={(open) => {
          // Opening a pane's menu makes it the active pane.
          if (!open) return;
          notePaneFocused(pane.id);
          useAppStore.getState().setActivePane(pane.id);
        }}
      >
        <MenuTrigger
          aria-label="Pane options"
          className="flex rounded-[4px] p-[3px] text-fg outline-none data-[state=open]:bg-raised"
        >
          <DotsIcon />
        </MenuTrigger>
        <MenuContent aria-label="Pane options">
          <PluginOptions kind={kind} ctx={ctx} />
          <PaneMenuItems paneId={pane.id} ctx={ctx} />
        </MenuContent>
      </Menu>
      <TabsetDragHandle
        aria-label="Move pane"
        title="Drag to move pane"
        className="flex cursor-grab rounded-[4px] p-[3px] text-fg-mid hover:text-fg-bright data-[disabled]:hidden"
      >
        <GripIcon />
      </TabsetDragHandle>
    </div>
  );
}

/** The plugin's own … menu items (looked up when the menu opens: content only mounts then). */
function PluginOptions({ kind, ctx }: { kind: string; ctx: ReturnType<typeof createPaneContext> }) {
  const plugin = activePlugin(kind);
  return plugin ? <PluginMenuItems plugin={plugin} ctx={ctx} menu="optionsMenu" /> : null;
}
