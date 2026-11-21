import { FileDiff, History, ListChecks, SlidersHorizontal, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { focusPane } from "../../../layout/dock";
import { getSession, setPanel, updateSession, useSession } from "../../store";
import type { SidePanel as PanelId } from "../../types";
import { FilesPanel } from "./FilesPanel";
import { HistoryPanel } from "./HistoryPanel";
import { PlanPanel } from "./PlanPanel";
import { SessionPanel } from "./SessionPanel";

/*
 * 4-tab right drawer for the Antigravity pane: History, Files, Session, Plan.
 * Renders side-by-side when pane width >= 720px, else overlays the transcript.
 */

const TABS: { id: PanelId; label: string; icon: ReactNode }[] = [
  { id: "history", label: "History", icon: <History size={12} /> },
  { id: "files", label: "Files", icon: <FileDiff size={12} /> },
  { id: "session", label: "Session", icon: <SlidersHorizontal size={12} /> },
  { id: "plan", label: "Plan", icon: <ListChecks size={12} /> },
];

export function SidePanel({ sessionKey, overlay }: { sessionKey: string; overlay: boolean }) {
  const panel = useSession(sessionKey, (s) => s?.panel);
  const filesCount = useSession(sessionKey, (s) => Object.keys(s?.changedFiles ?? {}).length);
  const tabsRef = useRef<HTMLDivElement>(null);

  const opened = panel !== undefined;
  useEffect(() => {
    if (!opened) return;
    tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
  }, [opened]);

  if (!panel) return null;

  const close = () => {
    setPanel(sessionKey, undefined);
    focusPane(getSession(sessionKey)?.paneId);
  };
  const show = (id: PanelId) => {
    if (id !== panel) updateSession(sessionKey, { panel: id });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const onTabKey = (event: KeyboardEvent) => {
    const idx = TABS.findIndex((t) => t.id === panel);
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (idx + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (idx + TABS.length - 1) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    show(TABS[next].id);
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };

  return (
    <aside className={`ag-drawer${overlay ? " is-overlay" : ""}`} aria-label="Antigravity panels" onKeyDown={onKeyDown}>
      <div className="ag-drawer-tabbar">
        <div ref={tabsRef} role="tablist" aria-label="Panels" className="ag-drawer-tabs" onKeyDown={onTabKey}>
          {TABS.map((tab) => {
            const selected = tab.id === panel;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`ag-tab-${sessionKey}-${tab.id}`}
                aria-selected={selected}
                aria-controls={`ag-panel-${sessionKey}`}
                title={tab.label}
                tabIndex={selected ? 0 : -1}
                className="ag-drawer-tab"
                onClick={() => show(tab.id)}
              >
                {tab.icon}
                <span className="ag-drawer-tab-label">{tab.label}</span>
                {tab.id === "files" && filesCount > 0 && <span className="ag-drawer-count">{filesCount}</span>}
              </button>
            );
          })}
        </div>
        <button type="button" className="ag-icon-button" aria-label="Close panel (Esc)" title="Close (Esc)" onClick={close}>
          <X size={13} />
        </button>
      </div>
      <div role="tabpanel" id={`ag-panel-${sessionKey}`} aria-labelledby={`ag-tab-${sessionKey}-${panel}`} className="ag-drawer-body">
        {panel === "history" && <HistoryPanel sessionKey={sessionKey} />}
        {panel === "files" && <FilesPanel sessionKey={sessionKey} />}
        {panel === "session" && <SessionPanel sessionKey={sessionKey} />}
        {panel === "plan" && <PlanPanel sessionKey={sessionKey} />}
      </div>
    </aside>
  );
}
