import { Bot, ChartPie, Gauge, History, Puzzle, SlidersHorizontal, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { focusPane } from "../../../layout/dock";
import { getSession, setPanel, updateSession, useSession } from "../../store";
import type { SidePanel as PanelId } from "../../types";
import { AgentsPanel } from "./AgentsPanel";
import { ConfigPanel } from "./ConfigPanel";
import { ContextPanel } from "./ContextPanel";
import { HistoryPanel } from "./HistoryPanel";
import { PluginsPanel } from "./PluginsPanel";
import { UsagePanel } from "./UsagePanel";

/*
 * The side panels of a Claude Code pane: a drawer on the pane's right
 * (`overlay`: over the transcript, for narrow panes) with a tab row for
 * Context, Usage, Agents, Plugins, Config and History, bound to the
 * session's `panel`. Esc closes it. See docs/claude-code.md (Design).
 */

const TABS: { id: PanelId; label: string; icon: ReactNode }[] = [
  { id: "context", label: "Context", icon: <ChartPie size={12} /> },
  { id: "usage", label: "Usage", icon: <Gauge size={12} /> },
  { id: "agents", label: "Agents", icon: <Bot size={12} /> },
  { id: "plugins", label: "Plugins", icon: <Puzzle size={12} /> },
  { id: "config", label: "Config", icon: <SlidersHorizontal size={12} /> },
  { id: "history", label: "History", icon: <History size={12} /> },
];

export function SidePanel({ sessionKey, overlay }: { sessionKey: string; overlay: boolean }) {
  const panel = useSession(sessionKey, (session) => session?.panel);
  const running = useSession(sessionKey, (session) => Object.values(session?.tasks ?? {}).filter((task) => task.status === "running").length);
  const tabs = useRef<HTMLDivElement>(null);

  // Focus the drawer when it opens, so Esc and the arrow keys work at once.
  const opened = panel !== undefined;
  useEffect(() => {
    if (!opened) return;
    tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
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
    // Not for keys from portaled content (menus, popovers): they close themselves.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const onTabKey = (event: KeyboardEvent) => {
    const index = TABS.findIndex((tab) => tab.id === panel);
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    show(TABS[next].id);
    requestAnimationFrame(() => tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };

  return (
    <aside className={`cp-drawer${overlay ? " cp-overlay" : ""}`} aria-label="Session panels" onKeyDown={onKeyDown}>
      <div className="cp-tabbar">
        <div ref={tabs} role="tablist" aria-label="Panels" className="cp-tabs" onKeyDown={onTabKey}>
          {TABS.map((tab) => {
            const selected = tab.id === panel;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`cp-tab-${sessionKey}-${tab.id}`}
                aria-selected={selected}
                aria-controls={`cp-panel-${sessionKey}`}
                aria-label={tab.label}
                title={tab.label}
                tabIndex={selected ? 0 : -1}
                className="cp-tab"
                onClick={() => show(tab.id)}
              >
                {tab.icon}
                <span className="cp-tab-label">{tab.label}</span>
                {tab.id === "agents" && running > 0 && <span className="cp-tab-count">{running}</span>}
              </button>
            );
          })}
        </div>
        <button type="button" className="cp-icon-button cp-close" aria-label="Close panel (Esc)" title="Close (Esc)" onClick={close}>
          <X size={13} />
        </button>
      </div>
      <div role="tabpanel" id={`cp-panel-${sessionKey}`} aria-labelledby={`cp-tab-${sessionKey}-${panel}`} className="cp-panel">
        {panel === "context" && <ContextPanel sessionKey={sessionKey} />}
        {panel === "usage" && <UsagePanel sessionKey={sessionKey} />}
        {panel === "agents" && <AgentsPanel sessionKey={sessionKey} />}
        {panel === "plugins" && <PluginsPanel sessionKey={sessionKey} />}
        {panel === "config" && <ConfigPanel sessionKey={sessionKey} />}
        {panel === "history" && <HistoryPanel sessionKey={sessionKey} />}
      </div>
    </aside>
  );
}
