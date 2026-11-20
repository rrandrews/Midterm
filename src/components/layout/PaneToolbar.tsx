import { TabsetDragHandle } from "react-resizable-panels";
import { notePaneFocused } from "../../layout/dock";
import { useAppStore } from "../../state/store";
import type { PaneNode } from "../../state/types";
import { DotsIcon, GripIcon } from "../ui/icons";
import { Menu, MenuContent, MenuTrigger } from "../ui/Menu";
import { PaneMenuItems } from "./PaneMenuItems";

/** A pane's hover controls: the options menu, then the drag handle in the corner. */
export function PaneToolbar({ pane }: { pane: PaneNode }) {
  return (
    <div className="flex gap-0.5">
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
          <PaneMenuItems paneId={pane.id} />
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
