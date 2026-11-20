import { Check, ClipboardCopy } from "lucide-react";
import { useEffect, useState } from "react";
import { type AgentStatus, type ProviderInfo, aiCliStatus, providerInfo } from "../../ipc/ai";
import { copyText } from "../../ipc/clipboard";
import type { AiProfile } from "../../settings/schema";
import { AGENT_CLI_PROVIDERS, providerConfigOf } from "../profiles";

/*
 * Settings → AI: whether a CLI profile can run the agent over ACP, from
 * `ai_cli_status().agent` (the adapter found and its version checked,
 * without starting a session). Shown as a second status line in the
 * profile editor, and as the Agent feature row's hint when its profile's
 * adapter is not ready.
 */

/** The command a problem tells the user to run: a `backticked` span, else an `npm install -g …`. */
export function installCommand(problem: string): string | undefined {
  const quoted = /`([^`]+)`/.exec(problem)?.[1];
  if (quoted) return quoted;
  return /\bnpm (?:install|i) -g \S+/.exec(problem)?.[0].replace(/[.,;)]+$/, "");
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="ml-1 inline-flex translate-y-[2px] text-fg-dim outline-none hover:text-fg-bright focus-visible:text-fg-bright"
      title="Copy the command"
      aria-label="Copy the command"
      onClick={() => void copyText(text).then(() => setCopied(true))}
    >
      {copied ? <Check size={11} className="text-ok" /> : <ClipboardCopy size={11} />}
    </button>
  );
}

/** A problem's text, with its install command in mono and copyable. */
export function ProblemText({ problem }: { problem: string }) {
  const command = installCommand(problem);
  if (!command) return <>{problem}</>;
  const quoted = problem.includes(`\`${command}\``) ? `\`${command}\`` : command;
  const at = problem.indexOf(quoted);
  return (
    <>
      {problem.slice(0, at)}
      <span className="font-mono text-fg-soft select-text">{command}</span>
      <CopyButton text={command} />
      {problem.slice(at + quoted.length)}
    </>
  );
}

function adapterName(path: string): string {
  return path.split("/").filter(Boolean).pop() || "claude-agent-acp";
}

/** The profile editor's second status line for a CLI provider; null for APIs. */
export function AgentStatusLine({ provider, agent }: { provider: ProviderInfo; agent: AgentStatus | undefined }) {
  if (provider.type !== "cli") return null;
  if (!AGENT_CLI_PROVIDERS.includes(provider.id)) return <div className="text-fg-dim">Agent: not supported for {provider.name} yet</div>;
  if (!agent) return null;
  const note = agent.note ? <span className="text-fg-dim"> · {agent.note}</span> : null;
  if (agent.ready) {
    const adapter = agent.adapter ? ` · ${adapterName(agent.adapter.path)} ${agent.adapter.version}` : "";
    return (
      <div data-agent-status="ready">
        <span className="text-ok">Agent: ready{adapter}</span>
        {note}
      </div>
    );
  }
  return (
    <div data-agent-status="problem">
      <span className="text-warn">
        Agent: <ProblemText problem={agent.problem ?? "not ready"} />
      </span>
      {note}
    </div>
  );
}

/** Why a supported CLI profile's adapter is not ready (checked once per profile config), or null. */
export function useAgentAdapterProblem(profile: AiProfile | undefined): string | null {
  const config = profile ? providerConfigOf(profile) : null;
  const supported = !!config && providerInfo(config.id)?.type === "cli" && AGENT_CLI_PROVIDERS.includes(config.id);
  const key = supported ? JSON.stringify(config) : null;
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setProblem(null);
    if (!key) return;
    let live = true;
    void aiCliStatus(JSON.parse(key)).then(
      (status) => live && setProblem(status.agent && !status.agent.ready ? (status.agent.problem ?? "The agent is not ready.") : null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [key]);
  return problem;
}
