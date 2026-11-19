import { closePane } from "../../closing";
import { useState } from "react";
import { TabsetDragHandle, useParentTabsetState } from "react-resizable-panels";
import { movePaneToNewTab, setPaneKind, splitPane, toggleMaximizePane } from "../../actions";
import { notePaneFocused, refocusPane } from "../../layout/dock";
import { useAppStore } from "../../state/store";
import { PANE_LABELS } from "../../state/layout";
import { PANE_KINDS, type PaneNode } from "../../state/types";
import { DotsIcon, GripIcon } from "../ui/icons";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/Menu";

type PaneToolbarProps = {
  pane: PaneNode;
  /** The pane is alone in its tab, so there is nowhere to move it from. */
  alone: boolean;
};

/** A pane's hover controls: the drag handle and the options menu. */
export function PaneToolbar({ pane, alone }: PaneToolbarProps) {
  const [open, setOpen] = useState(false);
  const maximized = useParentTabsetState()?.isMaximized ?? false;

  return (
    <div className="flex gap-0.5">
      <TabsetDragHandle
        aria-label="Move pane"
        title="Drag to move pane"
        className="flex cursor-grab rounded-[4px] p-[3px] text-fg-mid hover:text-fg-bright data-[disabled]:hidden"
      >
        <GripIcon />
      </TabsetDragHandle>
      <Menu
        open={open}
        onOpenChange={(next) => {
          // Opening a pane's menu makes it the active pane.
          if (next) {
            notePaneFocused(pane.id);
            useAppStore.getState().setActivePane(pane.id);
          }
          setOpen(next);
        }}
      >
        <MenuTrigger
          aria-label="Pane options"
          className="flex rounded-[4px] p-[3px] text-fg outline-none data-[state=open]:bg-raised"
        >
          <DotsIcon />
        </MenuTrigger>
        <MenuContent
          aria-label="Pane options"
          onCloseAutoFocus={(event) => {
            // Focus goes to a pane (this one, or the one the command chose),
            // not back to the trigger button.
            event.preventDefault();
            refocusPane();
          }}
        >
          <MenuItem shortcut="⌘D" onSelect={() => splitPane("right", pane.id)}>
            Split right
          </MenuItem>
          <MenuItem shortcut="⇧⌘D" onSelect={() => splitPane("bottom", pane.id)}>
            Split down
          </MenuItem>
          <MenuSub>
            <MenuSubTrigger>Change pane type</MenuSubTrigger>
            <MenuSubContent>
              {PANE_KINDS.map((kind) => (
                <MenuItem
                  key={kind}
                  checked={pane.data.kind === kind}
                  onSelect={() => setPaneKind(pane.id, kind)}
                >
                  {PANE_LABELS[kind]}
                </MenuItem>
              ))}
            </MenuSubContent>
          </MenuSub>
          <MenuItem shortcut="⇧⌘↩" disabled={alone} onSelect={() => toggleMaximizePane(pane.id)}>
            {maximized ? "Restore pane" : "Maximize pane"}
          </MenuItem>
          <MenuItem disabled={alone} onSelect={() => movePaneToNewTab(pane.id)}>
            Move to new tab
          </MenuItem>
          <MenuSeparator />
          <MenuItem shortcut="⌘W" onSelect={() => closePane(pane.id)}>
            Close pane
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
