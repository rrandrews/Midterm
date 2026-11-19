import { useEffect, useRef } from "react";
import { registerPaneFocuser } from "../../layout/dock";
import { acquireSession, releaseSession } from "../../terminal/sessions";

/**
 * Shows a pane's terminal. The terminal itself is owned by the session
 * registry, not this component: mounting only puts the session's element on
 * screen, so the shell and its scrollback survive tab switches and re-docks.
 */
export function TerminalPane({ paneId }: { paneId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const session = acquireSession(paneId);
    session.attach(container);
    const unregister = registerPaneFocuser(paneId, () => session.focus());
    return () => {
      unregister();
      releaseSession(session);
    };
  }, [paneId]);

  return <div ref={ref} className="terminal-pane" />;
}
