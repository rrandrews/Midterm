import { ArrowUpRight, Terminal } from "lucide-react";
import { homeDirectory } from "../../../ipc/system";
import { openSessionFile, runLoginInTerminal, setConfigValue, useSession } from "../../store";
import {
  contextPercent,
  flattenSelectOptions,
  formatCost,
  formatElapsed,
  formatTokens,
  levelOf,
} from "../format";

/*
 * Session panel: context window breakdown (`usage_update`), turn & token
 * totals, interactive controls for every ACP `configOption` (select + boolean),
 * agent metadata/capabilities, and quick access to `~/.gemini/antigravity-cli/settings.json`.
 */

export function SessionPanel({ sessionKey }: { sessionKey: string }) {
  const session = useSession(sessionKey, (s) => s);
  if (!session) return null;

  const usage = session.usage;
  const percent = contextPercent(usage?.used, usage?.size);
  const level = percent !== undefined ? levelOf(percent) : "accent";
  const home = homeDirectory();
  const cliSettingsPath = home ? `${home}/.gemini/antigravity-cli/settings.json` : undefined;

  return (
    <div className="ag-panel-section">
      <div className="ag-section-block">
        <div className="ag-section-title">Context window</div>
        {usage && percent !== undefined ? (
          <>
            <div className="ag-meter">
              <div className={`ag-meter-fill is-${level}`} style={{ width: `${percent}%` }} />
            </div>
            <div className="ag-kv-row">
              <span className="ag-dim">Used</span>
              <span className="ag-num">
                {formatTokens(usage.used)} / {formatTokens(usage.size)} ({percent}%)
              </span>
            </div>
            {usage.cost && (
              <div className="ag-kv-row">
                <span className="ag-dim">Session cost</span>
                <span className="ag-num">{formatCost(usage.cost.amount, usage.cost.currency)}</span>
              </div>
            )}
          </>
        ) : (
          <div className="ag-dim">Waiting for context metrics from Antigravity…</div>
        )}
      </div>

      {session.totals.turns > 0 && (
        <div className="ag-section-block">
          <div className="ag-section-title">Activity</div>
          <div className="ag-kv-row">
            <span className="ag-dim">Turns</span>
            <span className="ag-num">{session.totals.turns}</span>
          </div>
          {session.totals.durationMs > 0 && (
            <div className="ag-kv-row">
              <span className="ag-dim">Total time</span>
              <span className="ag-num">{formatElapsed(session.totals.durationMs)}</span>
            </div>
          )}
          {session.totals.inputTokens > 0 && (
            <div className="ag-kv-row">
              <span className="ag-dim">Input tokens</span>
              <span className="ag-num">{formatTokens(session.totals.inputTokens)}</span>
            </div>
          )}
          {session.totals.outputTokens > 0 && (
            <div className="ag-kv-row">
              <span className="ag-dim">Output tokens</span>
              <span className="ag-num">{formatTokens(session.totals.outputTokens)}</span>
            </div>
          )}
          {session.totals.thoughtTokens > 0 && (
            <div className="ag-kv-row">
              <span className="ag-dim">Thinking tokens</span>
              <span className="ag-num">{formatTokens(session.totals.thoughtTokens)}</span>
            </div>
          )}
        </div>
      )}

      {session.configOptions.length > 0 && (
        <div className="ag-section-block">
          <div className="ag-section-title">ACP session options</div>
          <div className="ag-config-list">
            {session.configOptions.map((opt) => (
              <div key={opt.id} className="ag-config-row">
                <div className="ag-config-label">
                  <span>{opt.name}</span>
                  {opt.description && <span className="ag-config-desc">{opt.description}</span>}
                </div>
                {opt.type === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={opt.currentValue}
                    aria-label={opt.name}
                    onChange={(e) => void setConfigValue(sessionKey, opt.id, e.target.checked)}
                  />
                ) : (
                  <select
                    className="ag-select"
                    value={opt.currentValue}
                    aria-label={opt.name}
                    onChange={(e) => void setConfigValue(sessionKey, opt.id, e.target.value)}
                  >
                    {flattenSelectOptions(opt).map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ag-section-block">
        <div className="ag-section-title">Agent</div>
        <div className="ag-kv-row">
          <span className="ag-dim">Server</span>
          <span className="ag-mono">{session.agentInfo?.title ?? session.agentInfo?.name ?? "agy acp"}</span>
        </div>
        {(session.agentInfo?.version || session.agyVersion) && (
          <div className="ag-kv-row">
            <span className="ag-dim">Version</span>
            <span className="ag-mono">{session.agentInfo?.version ?? session.agyVersion}</span>
          </div>
        )}
        {session.sessionId && (
          <div className="ag-kv-row">
            <span className="ag-dim">Session ID</span>
            <span className="ag-mono ag-truncate" title={session.sessionId}>
              {session.sessionId}
            </span>
          </div>
        )}
        <div className="ag-section-actions">
          {cliSettingsPath && (
            <button type="button" className="ag-button" onClick={() => openSessionFile(sessionKey, cliSettingsPath)}>
              Open settings.json <ArrowUpRight size={10} />
            </button>
          )}
          <button type="button" className="ag-button" onClick={() => runLoginInTerminal(sessionKey)}>
            <Terminal size={10} /> Sign in
          </button>
        </div>
      </div>
    </div>
  );
}
