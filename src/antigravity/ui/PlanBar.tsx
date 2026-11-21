import type { PlanEntry } from "@agentclientprotocol/sdk/unstable";
import { ArrowUpRight, Check, ChevronRight, Circle, CircleDot, ListTodo } from "lucide-react";
import { useState } from "react";
import { setPanel, useSession } from "../store";

/*
 * Pinned execution plan summary above the composer, driven by ACP `plan`
 * updates (`PlanEntry[]`). Hidden once every entry is completed.
 */

const NONE: PlanEntry[] = [];

export function PlanBar({ sessionKey }: { sessionKey: string }) {
  const plan = useSession(sessionKey, (s) => s?.plan ?? NONE);
  const [open, setOpen] = useState(false);
  if (plan.length === 0) return null;
  const done = plan.filter((entry) => entry.status === "completed").length;
  if (done === plan.length) return null;
  const current = plan.find((entry) => entry.status === "in_progress");

  return (
    <div className={`ag-plan${open ? " is-open" : ""}`}>
      <button type="button" className="ag-plan-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ListTodo size={12} className="text-fg-dim" />
        <span className="ag-num text-fg-mid">
          {done}/{plan.length}
        </span>
        <span className="ag-plan-current">{current ? current.content : "Plan"}</span>
        <ChevronRight size={11} className="ag-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="ag-plan-body">
          <ul className="ag-checklist">
            {plan.map((entry, index) => (
              <li key={index} className={`is-${entry.status}`}>
                {entry.status === "completed" ? (
                  <Check size={11} />
                ) : entry.status === "in_progress" ? (
                  <CircleDot size={11} />
                ) : (
                  <Circle size={11} />
                )}
                <span className="ag-checklist-text">{entry.content}</span>
                {entry.priority === "high" && entry.status !== "completed" && <span className="ag-badge is-priority">high</span>}
              </li>
            ))}
          </ul>
          {plan.length > 5 && (
            <button type="button" className="ag-link ag-plan-open" onClick={() => setPanel(sessionKey, "plan")}>
              Open in Plan panel <ArrowUpRight size={10} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
