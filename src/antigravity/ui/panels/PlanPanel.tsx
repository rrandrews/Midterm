import type { PlanEntry } from "@agentclientprotocol/sdk/unstable";
import { Check, Circle, CircleDot } from "lucide-react";
import { useSession } from "../../store";

/*
 * Full view of the agent's current ACP execution plan (`PlanEntry[]`).
 */

const NONE: PlanEntry[] = [];

export function PlanPanel({ sessionKey }: { sessionKey: string }) {
  const plan = useSession(sessionKey, (s) => s?.plan ?? NONE);
  if (plan.length === 0) {
    return <div className="ag-panel-empty">No active plan for this session yet.</div>;
  }
  const done = plan.filter((e) => e.status === "completed").length;
  return (
    <div className="ag-panel-section">
      <div className="ag-panel-summary">
        <span>Execution plan</span>
        <span className="ag-num text-fg-mid">
          {done}/{plan.length} completed
        </span>
      </div>
      <ul className="ag-checklist is-drawer">
        {plan.map((entry, idx) => (
          <li key={idx} className={`is-${entry.status}`}>
            {entry.status === "completed" ? (
              <Check size={12} />
            ) : entry.status === "in_progress" ? (
              <CircleDot size={12} />
            ) : (
              <Circle size={12} />
            )}
            <span className="ag-checklist-text">{entry.content}</span>
            {entry.priority === "high" && entry.status !== "completed" && <span className="ag-badge is-priority">high</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
