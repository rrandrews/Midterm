import { GitBranch, History, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { confirm } from "../../../components/ui/ConfirmDialog";
import { homeDirectory } from "../../../ipc/system";
import { request } from "../../client";
import type { SDKSessionInfo } from "../../protocol";
import { getSession, resumeSession, useSession } from "../../store";
import { formatAgo, tildePath } from "./format";
import { Badge, Empty, ErrorLine, IconButton, Spinner, Toolbar, errorText, useNow } from "./shared";

/*
 * History: past Claude Code sessions of this folder, newest first. Clicking
 * one resumes it in this pane.
 */

const LIMIT = 200;

function sessionTitle(info: SDKSessionInfo): string {
  return (info.customTitle || info.summary || info.firstPrompt || "Untitled session").replace(/\s+/g, " ").trim();
}

export function HistoryPanel({ sessionKey }: { sessionKey: string }) {
  const cwd = useSession(sessionKey, (session) => session?.cwd ?? "");
  const current = useSession(sessionKey, (session) => session?.sessionId);
  const [sessions, setSessions] = useState<SDKSessionInfo[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [resuming, setResuming] = useState<string>();
  const now = useNow(60_000);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setSessions(await request("sessions.list", { cwd, limit: LIMIT }));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, current]);

  const resume = async (info: SDKSessionInfo) => {
    if (info.sessionId === current) return;
    if (getSession(sessionKey)?.status === "running") {
      const ok = await confirm({
        title: "Switch sessions?",
        message: "A turn is running. Switching stops it and resumes the other session in this pane.",
        action: "Stop and switch",
      });
      if (!ok) return;
    }
    setResuming(info.sessionId);
    setError(undefined);
    try {
      await resumeSession(sessionKey, info.sessionId);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setResuming(undefined);
    }
  };

  return (
    <>
      <Toolbar>
        <span className="cp-toolbar-text cp-truncate" title={cwd}>
          {sessions ? `${sessions.length}${sessions.length === LIMIT ? "+" : ""} ${sessions.length === 1 ? "session" : "sessions"} in ` : "Sessions in "}
          <span className="cp-mono">{tildePath(cwd, homeDirectory())}</span>
        </span>
        <span className="cp-grow" />
        <IconButton label="Refresh" busy={loading} onClick={() => void load()}>
          <RotateCw size={12} />
        </IconButton>
      </Toolbar>
      <div className="cp-body cp-body-flush">
        {error && <ErrorLine onRetry={() => void load()}>{error}</ErrorLine>}
        {!sessions ? (
          loading && (
            <div className="cp-loading">
              <Spinner /> Reading sessions…
            </div>
          )
        ) : sessions.length === 0 ? (
          <Empty icon={<History size={18} />} title="No past sessions">
            Sessions you have in this folder show up here to resume.
          </Empty>
        ) : (
          <ul className="cp-history">
            {sessions.map((info) => {
              const isCurrent = info.sessionId === current;
              return (
                <li key={info.sessionId}>
                  <button
                    type="button"
                    className="cp-history-row"
                    aria-current={isCurrent || undefined}
                    disabled={!!resuming}
                    title={isCurrent ? "This session" : `Resume “${sessionTitle(info)}”`}
                    onClick={() => void resume(info)}
                  >
                    <span className="cp-history-title">{sessionTitle(info)}</span>
                    <span className="cp-history-meta">
                      {resuming === info.sessionId ? (
                        <span className="cp-accent">
                          <Spinner size={10} /> Resuming…
                        </span>
                      ) : (
                        <span title={new Date(info.lastModified).toLocaleString()}>{formatAgo(info.lastModified, now)}</span>
                      )}
                      {info.gitBranch && (
                        <span className="cp-branch">
                          <GitBranch size={10} aria-hidden="true" />
                          <span className="cp-truncate">{info.gitBranch}</span>
                        </span>
                      )}
                      {info.tag && <Badge>{info.tag}</Badge>}
                      {isCurrent && <Badge tone="accent">Current</Badge>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
