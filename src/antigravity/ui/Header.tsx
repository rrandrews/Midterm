import { FileDiff, History, ListChecks, SlidersHorizontal, SquarePen } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { displayPath } from "../../explorer/tree";
import { homeDirectory } from "../../ipc/system";
import { startNewSession } from "../commands";
import { setCwd, setPanel, useSession } from "../store";
import type { SidePanel } from "../types";
import { AntigravityMark } from "./AntigravityMark";
import { contextPercent, formatCost, levelOf } from "./format";

/*
 * Compact 28px pane header (right-padded 52px for Midterm's pane hover
 * controls): mark, session title, folder (editable before the first message),
 * context ring, optional cost, changed-files pill, drawer buttons, and New session.
 */

async function pickFolder(current: string): Promise<string | null> {
  if (!isTauri()) {
    const typed = window.prompt("Folder for Antigravity", current);
    return typed?.trim() || null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, defaultPath: current, title: "Folder for Antigravity" });
  return typeof picked === "string" ? picked : null;
}

export { pickFolder };

function ContextRing({ percent, size = 14 }: { percent: number; size?: number }) {
  const radius = size / 2 - 1.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg className={`ag-ring is-${levelOf(percent)}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="ag-ring-track" cx={size / 2} cy={size / 2} r={radius} />
      <circle
        className="ag-ring-fill"
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

function PanelButton({
  sessionKey,
  panel,
  label,
  open,
  children,
}: {
  sessionKey: string;
  panel: SidePanel;
  label: string;
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`ag-icon-button${open ? " is-on" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={open}
      onClick={() => setPanel(sessionKey, panel)}
    >
      {children}
    </button>
  );
}

export function Header({ sessionKey }: { sessionKey: string }) {
  const status = useSession(sessionKey, (s) => s?.status);
  const title = useSession(sessionKey, (s) => s?.title);
  const cwd = useSession(sessionKey, (s) => s?.cwd ?? "");
  const empty = useSession(sessionKey, (s) => (s?.items.length ?? 0) === 0 && s?.status === "new");
  const panel = useSession(sessionKey, (s) => s?.panel);
  const usage = useSession(sessionKey, (s) => s?.usage);
  const filesCount = useSession(sessionKey, (s) => Object.keys(s?.changedFiles ?? {}).length);
  const planCount = useSession(sessionKey, (s) => s?.plan.length ?? 0);

  const percent = contextPercent(usage?.used, usage?.size);
  const cost = usage?.cost;
  const running = status === "running";
  const folder = <bdi dir="ltr">{displayPath(cwd.replace(/(.)\/+$/, "$1"), homeDirectory())}</bdi>;

  const changeFolder = async () => {
    const picked = await pickFolder(cwd);
    if (picked) setCwd(sessionKey, picked);
  };

  return (
    <header className="ag-header">
      <AntigravityMark running={running} />
      <span className="ag-title" title={title}>
        {title ?? "Antigravity"}
      </span>
      {empty ? (
        <button type="button" className="ag-folder is-editable" title={`${cwd} · Change the folder`} onClick={changeFolder}>
          {folder}
        </button>
      ) : (
        <span className="ag-folder" title={cwd}>
          {folder}
        </span>
      )}
      {status === "starting" && <span className="ag-header-state">Starting…</span>}
      {status === "error" && <span className="ag-header-state text-err">Stopped</span>}
      <span className="ag-header-spacer" />
      {filesCount > 0 && (
        <button
          type="button"
          className={`ag-header-chip${panel === "files" ? " is-on" : ""}`}
          title="Files modified in this session"
          onClick={() => setPanel(sessionKey, "files")}
        >
          <FileDiff size={11} className="text-fg-dim" />
          <span className="ag-num">{filesCount}</span>
        </button>
      )}
      {percent !== undefined && (
        <button
          type="button"
          className={`ag-header-chip${panel === "session" ? " is-on" : ""}`}
          title="Context window: open session details"
          onClick={() => setPanel(sessionKey, "session")}
        >
          <ContextRing percent={percent} />
          <span className={`ag-num${percent > 70 ? ` text-${levelOf(percent)}` : ""}`}>{percent}%</span>
        </button>
      )}
      {cost && cost.amount > 0 && (
        <button
          type="button"
          className={`ag-header-chip${panel === "session" ? " is-on" : ""}`}
          title="Session cost"
          onClick={() => setPanel(sessionKey, "session")}
        >
          <span className="ag-num">{formatCost(cost.amount, cost.currency)}</span>
        </button>
      )}
      <span className="ag-header-buttons">
        {planCount > 0 && (
          <PanelButton sessionKey={sessionKey} panel="plan" label="Plan" open={panel === "plan"}>
            <ListChecks size={13} />
          </PanelButton>
        )}
        <PanelButton sessionKey={sessionKey} panel="files" label="Changed files" open={panel === "files"}>
          <FileDiff size={13} />
        </PanelButton>
        <PanelButton sessionKey={sessionKey} panel="history" label="History" open={panel === "history"}>
          <History size={13} />
        </PanelButton>
        <PanelButton sessionKey={sessionKey} panel="session" label="Session & options" open={panel === "session"}>
          <SlidersHorizontal size={13} />
        </PanelButton>
        <button type="button" className="ag-icon-button" title="New session" aria-label="New session" onClick={() => void startNewSession(sessionKey)}>
          <SquarePen size={13} />
        </button>
      </span>
    </header>
  );
}
