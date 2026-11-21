import { confirm } from "../../components/ui/ConfirmDialog";
import { getSession, newSession, runningTasks } from "../store";

/*
 * Session actions shared by the header, the pane menu and the commands.
 */

/** New session, asking first when a turn or background agents would be stopped. */
export async function startNewSession(key: string): Promise<void> {
  const session = getSession(key);
  if (!session) return;
  const agents = runningTasks(session);
  const turn = session.status === "running" || (session.status === "starting" && session.items.some((item) => item.kind === "user"));
  if (turn || agents > 0) {
    const what = [turn ? "a turn is running" : undefined, agents > 0 ? `${agents} agent${agents === 1 ? " is" : "s are"} working in the background` : undefined].filter(Boolean).join(" and ");
    const ok = await confirm({
      title: "Start a new session?",
      message: `In this session ${what}. A new session stops ${turn && agents > 0 ? "them" : "it"}; you can resume this one from History.`,
      action: "Stop and start new",
    });
    if (!ok) return;
  }
  await newSession(key);
}
