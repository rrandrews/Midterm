import type { SessionInfo } from "@agentclientprotocol/sdk/unstable";
import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { displayPath } from "../../../explorer/tree";
import { homeDirectory } from "../../../ipc/system";
import { confirmSwitchSession } from "../../commands";
import { deletePastSession, listPastSessions, useSession } from "../../store";
import { formatRelativeTime } from "../format";

/*
 * Past Antigravity sessions via ACP `session/list` (with cursor pagination).
 * Filter by folder or view all folders; click confirms if active work is
 * running before loading/resuming in this pane; optional delete when the agent
 * advertises `sessionCapabilities.delete`.
 */

export function HistoryPanel({ sessionKey }: { sessionKey: string }) {
  const cwd = useSession(sessionKey, (s) => s?.cwd ?? "");
  const currentId = useSession(sessionKey, (s) => s?.sessionId);
  const canDelete = useSession(sessionKey, (s) => Boolean(s?.capabilities?.sessionCapabilities?.delete));

  const [allFolders, setAllFolders] = useState(false);
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [supported, setSupported] = useState<boolean | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await listPastSessions(sessionKey, allFolders);
      setSupported(res.supported);
      setSessions(res.sessions);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionKey, allFolders]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const res = await listPastSessions(sessionKey, allFolders, nextCursor);
      setSessions((cur) => {
        const seen = new Set(cur.map((s) => s.sessionId));
        return [...cur, ...res.sessions.filter((s) => !seen.has(s.sessionId))];
      });
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) => (s.title ?? "").toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.sessionId.toLowerCase().includes(q))
    : sessions;

  const remove = async (id: string) => {
    try {
      const ok = await deletePastSession(sessionKey, id);
      if (ok) setSessions((cur) => cur.filter((s) => s.sessionId !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="ag-panel-section">
      <div className="ag-panel-toolbar">
        <input
          type="search"
          className="ag-panel-search"
          value={query}
          placeholder="Filter sessions…"
          aria-label="Filter sessions"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={`ag-chip${allFolders ? " is-on" : ""}`}
          title="Show sessions from all folders"
          onClick={() => setAllFolders((v) => !v)}
        >
          {allFolders ? "All folders" : "This folder"}
        </button>
        <button type="button" className="ag-icon-button" title="Refresh history" aria-label="Refresh history" onClick={() => void load()}>
          <RefreshCw size={12} className={loading ? "ag-spin" : undefined} />
        </button>
      </div>

      {error && <div className="ag-panel-note text-err">{error}</div>}
      {!loading && supported === false && (
        <div className="ag-panel-empty">This version of Antigravity does not advertise ACP session listing.</div>
      )}
      {!loading && supported !== false && filtered.length === 0 && (
        <div className="ag-panel-empty">
          {q ? "No sessions match your filter." : `No past sessions found${allFolders ? "" : ` for ${displayPath(cwd, homeDirectory())}`}.`}
        </div>
      )}

      <div className="ag-history-list">
        {filtered.map((item) => {
          const isCurrent = item.sessionId === currentId;
          return (
            <div key={item.sessionId} className={`ag-history-row${isCurrent ? " is-current" : ""}`}>
              <button
                type="button"
                className="ag-history-pick"
                onClick={() => !isCurrent && void confirmSwitchSession(sessionKey, { sessionId: item.sessionId, cwd: item.cwd })}
              >
                <div className="ag-history-title">{item.title || item.sessionId}</div>
                <div className="ag-history-meta">
                  {allFolders && <span className="ag-mono">{displayPath(item.cwd, homeDirectory())}</span>}
                  {item.updatedAt && <span>{formatRelativeTime(item.updatedAt)}</span>}
                  {isCurrent && <span className="text-accent">current</span>}
                </div>
              </button>
              {canDelete && !isCurrent && (
                <button
                  type="button"
                  className="ag-icon-button ag-history-del"
                  title="Delete session"
                  aria-label="Delete session"
                  onClick={() => void remove(item.sessionId)}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {nextCursor && (
        <button type="button" className="ag-button" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? "Loading…" : "Load more sessions"}
        </button>
      )}
    </div>
  );
}
