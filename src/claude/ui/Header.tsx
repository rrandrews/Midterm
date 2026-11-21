import { History, Puzzle, Settings2, SquarePen } from "lucide-react";
import { homeDirectory } from "../../ipc/system";
import { displayPath } from "../../explorer/tree";
import { formatCost } from "./panels/format";
import { newSession, setCwd, setPanel, useSession } from "../store";
import type { SidePanel } from "../types";
import { contextPercent, levelOf } from "./format";
import { ClaudeMark } from "./ClaudeMark";
import { pickFolder } from "./pickFolder";

/*
 * The pane's header (28px): the mark (pulsing while a turn runs), the
 * session title, the folder; then the context ring, the cost, running
 * agents, the panel buttons and New session. Right-padded for the pane's
 * hover controls.
 */

export function ContextRing({ percent, size = 14 }: { percent: number; size?: number }) {
  const radius = size / 2 - 1.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg className={`cc-ring is-${levelOf(percent)}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="cc-ring-track" cx={size / 2} cy={size / 2} r={radius} />
      <circle
        className="cc-ring-fill"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={circumference * (1 - Math.min(100, Math.max(0, percent)) / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function PanelButton({ sessionKey, panel, label, open, children }: { sessionKey: string; panel: SidePanel; label: string; open: boolean; children: React.ReactNode }) {
  return (
    <button type="button" className={`cc-icon-button${open ? " is-on" : ""}`} title={label} aria-label={label} aria-pressed={open} onClick={() => setPanel(sessionKey, panel)}>
      {children}
    </button>
  );
}

export function Header({ sessionKey }: { sessionKey: string }) {
  const status = useSession(sessionKey, (session) => session?.status);
  const title = useSession(sessionKey, (session) => session?.title);
  const cwd = useSession(sessionKey, (session) => session?.cwd ?? "");
  const empty = useSession(sessionKey, (session) => (session?.items.length ?? 0) === 0 && session?.status === "new");
  const panel = useSession(sessionKey, (session) => session?.panel);
  const cost = useSession(sessionKey, (session) => session?.totals.costUsd ?? 0);
  const percent = useSession(sessionKey, (session) => contextPercent(session?.contextTokens, session?.context?.maxTokens || session?.contextWindow));
  const agents = useSession(sessionKey, (session) => Object.values(session?.tasks ?? {}).filter((task) => task.status === "running").length);
  const running = status === "running";
  const folder = displayPath(cwd, homeDirectory());

  const changeFolder = async () => {
    const picked = await pickFolder(cwd);
    if (picked) setCwd(sessionKey, picked);
  };

  return (
    <header className="cc-header">
      <ClaudeMark running={running} />
      <span className="cc-title" title={title}>
        {title ?? "Claude Code"}
      </span>
      {empty ? (
        <button type="button" className="cc-folder is-editable" title={`${cwd} · Change the folder`} onClick={changeFolder}>
          {folder}
        </button>
      ) : (
        <span className="cc-folder" title={cwd}>
          {folder}
        </span>
      )}
      {status === "starting" && <span className="cc-header-state">Starting…</span>}
      {status === "error" && <span className="cc-header-state text-err">Stopped</span>}
      <span className="cc-header-spacer" />
      {percent !== undefined && (
        <button
          type="button"
          className={`cc-header-chip${panel === "context" ? " is-on" : ""}`}
          title="Context window: open the breakdown"
          onClick={() => setPanel(sessionKey, "context")}
        >
          <ContextRing percent={percent} />
          <span className={`cc-num${percent > 70 ? ` text-${levelOf(percent)}` : ""}`}>{percent}%</span>
        </button>
      )}
      {cost > 0 && (
        <button type="button" className={`cc-header-chip${panel === "usage" ? " is-on" : ""}`} title="Session cost: open usage" onClick={() => setPanel(sessionKey, "usage")}>
          <span className="cc-num">{formatCost(cost)}</span>
        </button>
      )}
      {agents > 0 && (
        <button
          type="button"
          className={`cc-header-chip${panel === "agents" ? " is-on" : ""}`}
          title={`${agents} running agent${agents === 1 ? "" : "s"}: open agents`}
          onClick={() => setPanel(sessionKey, "agents")}
        >
          <span className="cc-live-dot" />
          <span className="cc-num">{agents}</span>
        </button>
      )}
      <span className="cc-header-buttons">
        <PanelButton sessionKey={sessionKey} panel="history" label="History" open={panel === "history"}>
          <History size={13} />
        </PanelButton>
        <PanelButton sessionKey={sessionKey} panel="plugins" label="Plugins and MCP servers" open={panel === "plugins"}>
          <Puzzle size={13} />
        </PanelButton>
        <PanelButton sessionKey={sessionKey} panel="config" label="Settings" open={panel === "config"}>
          <Settings2 size={13} />
        </PanelButton>
        <button type="button" className="cc-icon-button" title="New session" aria-label="New session" onClick={() => void newSession(sessionKey)}>
          <SquarePen size={13} />
        </button>
      </span>
    </header>
  );
}
