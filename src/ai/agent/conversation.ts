import { create } from "zustand";
import { livePane } from "../../actions";
import { aiAcpClose, aiAcpPrompt, aiAcpToolResult, aiAgentTurn, aiCancel, providerInfo } from "../../ipc/ai";
import { homeDirectory } from "../../ipc/system";
import { createPaneState } from "../../plugins/paneState";
import { getPlugin } from "../../plugins/registry";
import { allSkills, invokeSkillTool } from "../../plugins/skills";
import { findPane } from "../../state/layout";
import { findTabOfPane, useAppStore } from "../../state/store";
import { branchOf } from "../../terminal/gitBranch";
import { agentProviderProblem, featureProblem, profileFor, targetFor } from "../profiles";
import { type AcpDeps, runAcpTurn } from "./acp";
import { type AgentBackend, type ConfirmAnswer, type Conversation, type ConversationHandle, type LoopDeps, newConversation, runTurn } from "./loop";
import { buildToolset } from "./tools";

/*
 * Agent conversations, in memory only, keyed by conversation id. Two views
 * show them: the agent card docked at the bottom of a pane (one-off
 * requests: `/agent`, "AI: Ask the agent…") and the Agent pane (extended
 * exchanges). A conversation is owned by one of them; it is stopped and
 * dropped when its owner goes away (the card's pane closes, the card is
 * dismissed or replaced, the Agent pane closes), except that "Continue in
 * agent pane" hands it from a card to a new pane, state and all.
 *
 * API profiles run on `runTurn` (one `ai_agent_turn` per model turn); CLI
 * profiles (Claude Code) on `runAcpTurn`, over an ACP session the backend
 * keeps per conversation until the conversation is dropped.
 */

export const AGENT_KIND = "agent";

export const NO_MODEL_MESSAGE = "Choose a model for Agent in Settings → AI.";

export type Owner = { type: "card"; paneId: string } | { type: "pane"; paneId: string };

type AgentState = {
  conversations: Record<string, Conversation>;
  owners: Record<string, Owner>;
  /** Pane id → the conversation its card shows. */
  cards: Record<string, string>;
  /** Agent pane id → its conversation. */
  panes: Record<string, string>;
};

export const useAgent = create<AgentState>()(() => ({ conversations: {}, owners: {}, cards: {}, panes: {} }));

/* ---- Readiness ---- */

/** Why the agent cannot run, or null when it can. */
export function agentProblem(): string | null {
  if (!featureProblem("agent")) return null;
  const profile = profileFor("agent");
  return (profile && agentProviderProblem(profile.provider)) ?? NO_MODEL_MESSAGE;
}

/* ---- Runtime (outside the store) ---- */

type Runtime = { controller: AbortController; asks: Map<string, (answer: ConfirmAnswer) => void> };
const runtimes = new Map<string, Runtime>();
let counter = 0;

function handleOf(id: string): ConversationHandle {
  return {
    get: () => {
      const conversation = useAgent.getState().conversations[id];
      if (!conversation) throw new Error("The conversation is gone");
      return conversation;
    },
    update: (change) =>
      useAgent.setState((state) => {
        const conversation = state.conversations[id];
        return conversation ? { conversations: { ...state.conversations, [id]: change(conversation) } } : state;
      }),
  };
}

function abbreviate(path: string): string {
  const home = homeDirectory();
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

function osName(): string {
  const agent = navigator.userAgent;
  return agent.includes("Mac") ? "macOS" : agent.includes("Windows") ? "Windows" : "Linux";
}

/** The pane a conversation works with, for headers: its kind's name and directory. */
export function describePane(paneId: string): { name: string; directory?: string } | undefined {
  const pane = livePane(paneId);
  if (!pane) return undefined;
  const spec = getPlugin(pane.data.kind);
  let directory: string | undefined;
  try {
    directory = spec?.plugin.pane.directory?.(pane);
  } catch {
    directory = undefined;
  }
  return { name: spec?.plugin.name ?? pane.data.kind, directory: directory ? abbreviate(directory) : undefined };
}

async function contextLine(conversation: Conversation): Promise<string> {
  const pane = livePane(conversation.targetPane);
  const parts = [`OS: ${osName()}`];
  if (pane) {
    const described = describePane(pane.id);
    parts.push(`working with: ${described?.name ?? pane.data.kind} pane ${pane.id}`);
    let directory: string | undefined;
    try {
      directory = getPlugin(pane.data.kind)?.plugin.pane.directory?.(pane);
    } catch {
      directory = undefined;
    }
    if (directory) {
      parts.push(`directory: ${abbreviate(directory)}`);
      const branch = await branchOf(directory).catch(() => null);
      if (branch) parts.push(`git branch: ${branch}`);
    }
  }
  return `[Context — ${parts.join("; ")}]`;
}

const ask: LoopDeps["ask"] = ({ conversationId, callId }, signal) =>
  new Promise<ConfirmAnswer>((resolve) => {
    const runtime = runtimes.get(conversationId);
    if (!runtime || signal.aborted) return resolve("deny");
    const done = (answer: ConfirmAnswer) => {
      runtime.asks.delete(callId);
      signal.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const onAbort = () => done("deny");
    runtime.asks.set(callId, done);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const shared = {
  cancel: (requestId: string) => void aiCancel(requestId).catch(() => {}),
  invoke: invokeSkillTool,
  ask,
  contextLine,
  newRequestId: () => `agent-${Date.now().toString(36)}-${++counter}`,
};

const deps: LoopDeps = { ...shared, turn: aiAgentTurn };
const acpDeps: AcpDeps = { ...shared, prompt: aiAcpPrompt, toolResult: aiAcpToolResult };

/* ---- Lifecycle ---- */

/** A new conversation working with `targetPane`, frozen on today's model and skills; null when the agent is not ready. */
function createConversation(targetPane: string, owner: Owner): string | null {
  if (agentProblem()) return null;
  const target = targetFor("agent");
  if (!target) return null;
  const id = `c${Date.now().toString(36)}${++counter}`;
  const backend: AgentBackend = providerInfo(target.provider.id)?.type === "cli" ? "acp" : "api";
  const conversation = newConversation(id, target, buildToolset(allSkills(), { acp: backend === "acp" }), targetPane, backend);
  // A CLI profile without a model uses the CLI's default: show the CLI's name.
  conversation.model = profileFor("agent")?.model || (backend === "acp" ? providerInfo(target.provider.id)?.name : undefined) || conversation.model;
  useAgent.setState((state) => ({
    conversations: { ...state.conversations, [id]: conversation },
    owners: { ...state.owners, [id]: owner },
  }));
  return id;
}

/** Stops a running conversation: cancels the turn, aborts tools, declines a pending confirmation. */
export function stopConversation(id: string): void {
  runtimes.get(id)?.controller.abort();
}

function dropConversation(id: string): void {
  stopConversation(id);
  runtimes.delete(id);
  // Ends the ACP session and its process (after the cancel above).
  if (useAgent.getState().conversations[id]?.backend === "acp") void aiAcpClose(id).catch(() => {});
  useAgent.setState((state) => {
    const { [id]: _gone, ...conversations } = state.conversations;
    const { [id]: _owner, ...owners } = state.owners;
    return { conversations, owners };
  });
}

export function isRunning(id: string | undefined): boolean {
  return !!id && useAgent.getState().conversations[id]?.status === "running";
}

/** Sends `text` (or continues from the history when null) in a conversation. */
export function sendMessage(id: string, text: string | null): void {
  const conversation = useAgent.getState().conversations[id];
  if (!conversation || conversation.status === "running") return;
  if (text !== null && !text.trim()) return;
  const runtime: Runtime = { controller: new AbortController(), asks: new Map() };
  runtimes.set(id, runtime);
  const signal = runtime.controller.signal;
  const run = conversation.backend === "acp" ? runAcpTurn(handleOf(id), text, acpDeps, signal) : runTurn(handleOf(id), text, deps, signal);
  void run
    .catch((error: unknown) => console.error("The agent failed:", error))
    .finally(() => {
      if (runtimes.get(id) === runtime) runtimes.delete(id);
    });
}

/** The user's answer to a write tool's confirmation. */
export function answerConfirm(id: string, callId: string, answer: ConfirmAnswer): void {
  runtimes.get(id)?.asks.get(callId)?.(answer);
}

/* ---- Cards (one-off requests) ---- */

/** Card conversations go with their pane (whatever its kind). */
const cardState = createPaneState<string>({
  isLive: () => true,
  dispose: (id, paneId) => {
    const owner = useAgent.getState().owners[id];
    if (owner?.type === "card" && owner.paneId === paneId) dropConversation(id);
    useAgent.setState((state) => {
      if (state.cards[paneId] !== id) return state;
      const { [paneId]: _gone, ...cards } = state.cards;
      return { cards };
    });
  },
});

/** The conversation a pane's card shows, if any. */
export function cardOf(paneId: string): string | undefined {
  return useAgent.getState().cards[paneId];
}

/** Closes a pane's card, stopping its conversation. */
export function dismissCard(paneId: string): void {
  cardState.delete(paneId);
}

/** Shows `message` in a pane's card when the agent cannot run (a one-entry conversation would need a target). */
export const useCardProblems = create<Record<string, string>>()(() => ({}));

export function dismissCardProblem(paneId: string): void {
  useCardProblems.setState((state) => {
    const { [paneId]: _gone, ...rest } = state;
    return rest;
  });
}

/**
 * Runs a one-off request against `paneId` in its card. A finished card is
 * replaced; a running one is replaced only if `replaceRunning` says so
 * (the caller asks the user). Returns false when nothing was started.
 */
export async function askAgent(paneId: string, task: string, replaceRunning: () => Promise<boolean>): Promise<boolean> {
  if (!task.trim() || !livePane(paneId)) return false;
  const existing = cardOf(paneId);
  if (existing && isRunning(existing) && !(await replaceRunning())) return false;
  dismissCard(paneId);
  dismissCardProblem(paneId);
  const problem = agentProblem();
  if (problem) {
    useCardProblems.setState({ [paneId]: problem });
    return false;
  }
  const id = createConversation(paneId, { type: "card", paneId });
  if (!id) return false;
  cardState.acquire(paneId, () => id);
  cardState.release(paneId, id);
  useAgent.setState((state) => ({ cards: { ...state.cards, [paneId]: id } }));
  sendMessage(id, task);
  return true;
}

/* ---- Agent panes ---- */

/** A conversation handed to an Agent pane that is about to mount ("Continue in agent pane"). */
const handoffs = new Map<string, string>();

/** Per Agent pane: which conversation it shows (swapped by New conversation). */
type PaneSlot = { id: string };

const paneSlots = createPaneState<PaneSlot>({
  kind: AGENT_KIND,
  dispose: (slot, paneId) => {
    const owner = useAgent.getState().owners[slot.id];
    if (owner?.type === "pane" && owner.paneId === paneId) dropConversation(slot.id);
    useAgent.setState((state) => {
      if (state.panes[paneId] !== slot.id) return state;
      const { [paneId]: _gone, ...panes } = state.panes;
      return { panes };
    });
  },
});

/** The last active pane of each tab that is not an Agent pane: what a new turn in an Agent pane works with. */
const lastWorkPane = new Map<string, string>();
useAppStore.subscribe((state) => {
  for (const workspace of state.workspaces) {
    for (const tab of workspace.tabs) {
      const id = tab.activePaneId;
      if (!id) continue;
      const kind = findPane(tab.layout, id)?.data.kind;
      if (kind && kind !== AGENT_KIND) lastWorkPane.set(tab.id, id);
    }
  }
});

/** The pane an Agent pane's next turn works with: the last active non-agent pane of its tab. */
export function workPaneFor(agentPaneId: string): string | undefined {
  const state = useAppStore.getState();
  const tab = findTabOfPane(state, agentPaneId);
  if (!tab) return undefined;
  const remembered = lastWorkPane.get(tab.id);
  if (remembered && findPane(tab.layout, remembered)) return remembered;
  if (tab.activePaneId && tab.activePaneId !== agentPaneId && findPane(tab.layout, tab.activePaneId)?.data.kind !== AGENT_KIND) {
    return tab.activePaneId;
  }
  return undefined;
}

function showInPane(paneId: string, id: string): void {
  useAgent.setState((state) => ({
    panes: { ...state.panes, [paneId]: id },
    owners: { ...state.owners, [id]: { type: "pane", paneId } },
  }));
}

/**
 * Takes hold of an Agent pane's conversation while its component is
 * mounted: a handed-off one, the one it had, or a new one (none when the
 * agent is not ready: `paneConversationOf` stays empty). Returns the
 * release function.
 */
export function holdPaneConversation(paneId: string): () => void {
  const handed = handoffs.get(paneId);
  handoffs.delete(paneId);
  const slot = paneSlots.acquire(paneId, () => ({ id: handed ?? "" }));
  if (handed && slot.id !== handed) {
    if (slot.id) dropConversation(slot.id);
    slot.id = handed;
  }
  if (!slot.id || !useAgent.getState().conversations[slot.id]) {
    slot.id = createConversation(workPaneFor(paneId) ?? paneId, { type: "pane", paneId }) ?? "";
  }
  if (slot.id) showInPane(paneId, slot.id);
  return () => paneSlots.release(paneId, slot);
}

/** Starts over in an Agent pane: a new conversation on the current model and skills (and "Allow for this conversation" forgotten). */
export function newPaneConversation(paneId: string): void {
  const slot = paneSlots.get(paneId);
  if (!slot) return;
  const id = createConversation(workPaneFor(paneId) ?? paneId, { type: "pane", paneId });
  if (slot.id) dropConversation(slot.id);
  slot.id = id ?? "";
  if (id) showInPane(paneId, id);
  else
    useAgent.setState((state) => {
      const { [paneId]: _gone, ...panes } = state.panes;
      return { panes };
    });
}

/** Before a turn in an Agent pane: work with the tab's last active non-agent pane. */
export function retargetPaneConversation(paneId: string, id: string): void {
  if (isRunning(id)) return;
  // No work pane in this tab (the Agent pane moved on its own): work with nothing rather than a pane in another tab.
  const target = workPaneFor(paneId) ?? paneId;
  handleOf(id).update((c) => (c.targetPane === target ? c : { ...c, targetPane: target }));
}

/** Marks a conversation for the Agent pane `paneId` that is about to mount. */
export function handOff(id: string, fromCardPane: string, toAgentPane: string): void {
  handoffs.set(toAgentPane, id);
  useAgent.setState((state) => {
    const { [fromCardPane]: _gone, ...cards } = state.cards;
    return { cards, owners: { ...state.owners, [id]: { type: "pane", paneId: toAgentPane } } };
  });
  // The card's entry is dropped without disposing the conversation: its owner is now the pane.
  cardState.delete(fromCardPane);
}

/** Gives a conversation back to its card when the Agent pane it was handed to did not open. */
export function undoHandOff(id: string, cardPane: string, agentPane: string): void {
  handoffs.delete(agentPane);
  if (!useAgent.getState().conversations[id]) return;
  useAgent.setState((state) => ({
    cards: { ...state.cards, [cardPane]: id },
    owners: { ...state.owners, [id]: { type: "card", paneId: cardPane } },
  }));
  cardState.acquire(cardPane, () => id);
  cardState.release(cardPane, id);
}

/** The Agent pane's conversation, if mounted. */
export function paneConversationOf(paneId: string): string | undefined {
  return useAgent.getState().panes[paneId];
}
