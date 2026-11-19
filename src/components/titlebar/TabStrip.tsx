import { closeTab } from "../../closing";
import {
  DndContext,
  type DragEndEvent,
  type Modifier,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { newTab, selectTab } from "../../actions";
import { refocusPane } from "../../layout/dock";
import { countPanes } from "../../state/layout";
import { selectActiveWorkspace, useAppStore } from "../../state/store";
import type { Tab } from "../../state/types";
import { InlineEdit } from "../ui/InlineEdit";

/** Tabs only slide along the strip. */
const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 });
const MODIFIERS = [horizontalOnly];

function TabItem({ tab, active }: { tab: Tab; active: boolean }) {
  const renameTab = useAppStore((state) => state.renameTab);
  const [renaming, setRenaming] = useState(false);
  const panes = countPanes(tab.layout);
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: tab.id,
    disabled: renaming,
  });

  return (
    <div
      ref={setNodeRef}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-tab-id={tab.id}
      data-pane-drop={tab.id}
      title={tab.titleLocked ? undefined : `${tab.title} — double-click to rename`}
      style={{
        transform: DndCSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
      }}
      className={
        active
          ? "tab group flex flex-none items-center gap-2 bg-(image:--tab-active) pr-2.5 pl-3.5 text-fg-bright shadow-[inset_1px_0_0_var(--color-line),inset_-1px_0_0_var(--color-line)] outline-none"
          : "tab group flex flex-none items-center gap-2 px-3.5 text-fg-muted outline-none hover:text-fg-soft"
      }
      {...listeners}
      onClick={() => selectTab(tab.id)}
      onDoubleClick={() => setRenaming(true)}
      onAuxClick={(event) => {
        // Middle click closes, like browser tabs.
        if (event.button === 1) closeTab(tab.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") selectTab(tab.id);
      }}
    >
      {renaming ? (
        <InlineEdit
          label="Tab name (empty to name it automatically)"
          allowEmpty
          value={tab.title}
          onCommit={(title) => renameTab(tab.id, title)}
          onDone={() => {
            setRenaming(false);
            refocusPane();
          }}
        />
      ) : (
        <span className="max-w-48 truncate">{tab.title}</span>
      )}
      {active && panes > 1 && (
        <span className="text-micro text-fg-dim" title={`${panes} panes`}>
          {panes}
        </span>
      )}
      {!active && tab.activity && (
        <span className="size-[5px] flex-none rounded-full bg-warn" role="img" aria-label="New output" />
      )}
      {active && (
        <button
          type="button"
          aria-label={`Close tab ${tab.title}`}
          className="ml-1 flex text-fg-dim hover:text-fg-bright"
          // Not a drag handle.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            closeTab(tab.id);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function TabStrip() {
  const workspace = useAppStore(selectActiveWorkspace);
  const moveTab = useAppStore((state) => state.moveTab);
  const listRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    // A click (or double-click to rename) is not a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Keep the active tab in view when the strip overflows.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-tab-id="${CSS.escape(workspace.activeTabId)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspace.activeTabId, workspace.tabs.length]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const index = workspace.tabs.findIndex((tab) => tab.id === over.id);
    if (index !== -1) moveTab(String(active.id), index);
    refocusPane();
  };

  return (
    <nav className="flex min-w-0 items-stretch" aria-label="Tabs">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={MODIFIERS}
        onDragEnd={onDragEnd}
        onDragCancel={refocusPane}
      >
        <SortableContext items={workspace.tabs.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
          <div
            ref={listRef}
            role="tablist"
            className="tab-scroller flex min-w-0 items-stretch overflow-x-auto overflow-y-hidden"
            onWheel={(event) => {
              // A mouse wheel scrolls the strip sideways.
              if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                event.currentTarget.scrollLeft += event.deltaY;
              }
            }}
          >
            {workspace.tabs.map((tab) => (
              <TabItem key={tab.id} tab={tab} active={tab.id === workspace.activeTabId} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <button
        type="button"
        aria-label="New tab"
        title="New tab (⌘T) — drop a pane here to move it to a new tab"
        data-pane-drop="new"
        className="tab flex flex-none items-center px-2.5 text-fg-dim hover:text-fg-bright"
        onClick={newTab}
      >
        <Plus size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </nav>
  );
}
