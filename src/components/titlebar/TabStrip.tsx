import { Plus, X } from "lucide-react";
import { useState } from "react";
import { closeTab, focusActivePane, newTab, selectTab } from "../../actions";
import { countPanes } from "../../state/layout";
import { selectActiveWorkspace, useAppStore } from "../../state/store";
import type { Tab } from "../../state/types";
import { InlineEdit } from "../ui/InlineEdit";

function TabItem({ tab, active }: { tab: Tab; active: boolean }) {
  const renameTab = useAppStore((state) => state.renameTab);
  const [renaming, setRenaming] = useState(false);
  const panes = countPanes(tab.layout);

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={
        active
          ? "group flex flex-none items-center gap-2 bg-(image:--tab-active) pr-2.5 pl-3.5 text-fg-bright shadow-[inset_1px_0_0_var(--color-line),inset_-1px_0_0_var(--color-line)] outline-none"
          : "group flex flex-none items-center gap-2 px-3.5 text-fg-muted outline-none hover:text-fg-soft"
      }
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
          label="Tab name"
          value={tab.title}
          onCommit={(title) => renameTab(tab.id, title)}
          onDone={() => {
            setRenaming(false);
            focusActivePane();
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

  return (
    <nav className="flex min-w-0 items-stretch" aria-label="Tabs">
      <div role="tablist" className="flex min-w-0 items-stretch overflow-hidden">
        {workspace.tabs.map((tab) => (
          <TabItem key={tab.id} tab={tab} active={tab.id === workspace.activeTabId} />
        ))}
      </div>
      <button
        type="button"
        aria-label="New tab"
        title="New tab (⌘T)"
        className="flex flex-none items-center px-2.5 text-fg-dim hover:text-fg-bright"
        onClick={newTab}
      >
        <Plus size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </nav>
  );
}
