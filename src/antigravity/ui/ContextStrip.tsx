import { setPanel, useSession } from "../store";
import { contextPercent, formatTokens, levelOf } from "./format";

/*
 * 3px full-width context meter under the header, fed by ACP `usage_update`.
 * Click opens the Session panel.
 */

export function ContextStrip({ sessionKey }: { sessionKey: string }) {
  const usage = useSession(sessionKey, (s) => s?.usage);
  const percent = contextPercent(usage?.used, usage?.size);
  const level = percent !== undefined ? levelOf(percent) : "accent";
  const label =
    usage && percent !== undefined
      ? `Context window: ${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens (${percent}%) — click for details`
      : "Context window usage";

  return (
    <button
      type="button"
      className="ag-strip"
      title={label}
      aria-label={label}
      onClick={() => setPanel(sessionKey, "session")}
    >
      <span
        className={`ag-strip-fill is-${level}`}
        style={{ width: `${percent ?? 0}%` }}
      />
    </button>
  );
}
