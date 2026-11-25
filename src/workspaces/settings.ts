import { setSecretNames } from "../ai/context";
import { deleteSecret, secretAccount, warmSecrets } from "../ipc/secrets";
import type { EnvVar, PythonEnv } from "../settings/schema";
import { DEFAULT_SCOPE, settingsFor, useSettings, workspaceSettings } from "../settings/settings";
import { findPane } from "../state/layout";
import { useAppStore } from "../state/store";

/*
 * Ties workspaces to their settings (docs/workspaces.md): the settings in
 * effect follow the active workspace, a deleted workspace's settings and
 * secrets go with it, and a new terminal gets its workspace's environment.
 */

let installed = false;

/** Keeps the effective settings on the active workspace. Call once the saved state is restored. */
export function installWorkspaceSettings(): void {
  if (installed) return;
  installed = true;
  const sync = () => useSettings.getState().setActiveWorkspace(useAppStore.getState().activeWorkspaceId);
  sync();
  useAppStore.subscribe((state, previous) => {
    if (state.activeWorkspaceId !== previous.activeWorkspaceId) sync();
  });
  // AI requests never carry a value assigned to one of the secrets' names.
  const names = () => {
    const { base } = useSettings.getState();
    return [...base.secrets, ...Object.values(base.workspaces).flatMap((workspace) => workspace.secrets)];
  };
  let last = "";
  const update = () => {
    const list = names();
    const key = list.join("\n");
    if (key === last) return;
    last = key;
    setSecretNames(list);
  };
  update();
  useSettings.subscribe(update);
}

/** Drops a deleted workspace's settings and its secrets in the keystore. */
export function forgetWorkspace(workspaceId: string): void {
  const { secrets } = workspaceSettings(workspaceId);
  for (const name of secrets) {
    void deleteSecret(secretAccount(workspaceId, name)).catch((error) => console.warn("Could not delete a secret:", error));
  }
  useSettings.getState().removeWorkspaceSettings(workspaceId);
}

/** The workspace holding a pane; the active one if the pane is in none. */
export function workspaceOfPane(paneId: string): string {
  const state = useAppStore.getState();
  const workspace = state.workspaces.find((w) => w.tabs.some((tab) => findPane(tab.layout, paneId)));
  return workspace?.id ?? state.activeWorkspaceId;
}

export type TerminalEnvironment = {
  env: EnvVar[];
  /** Secret variables: their name and the keystore account holding the value. */
  secrets: { name: string; account: string }[];
  python: (PythonEnv & { kind: "venv" | "conda" }) | null;
};

/**
 * What a new terminal in a workspace starts with: the defaults' variables
 * and secrets with the workspace's on top (same name: the workspace's),
 * and the workspace's Python environment (its own or the defaults').
 */
export function terminalEnvironment(workspaceId: string): TerminalEnvironment {
  const base = useSettings.getState().base;
  const workspace = workspaceSettings(workspaceId, base);
  const env = new Map<string, EnvVar>();
  for (const variable of [...base.env, ...workspace.env]) env.set(variable.name, variable);
  const secrets = new Map<string, { name: string; account: string }>();
  for (const name of base.secrets) secrets.set(name, { name, account: secretAccount(DEFAULT_SCOPE, name) });
  for (const name of workspace.secrets) secrets.set(name, { name, account: secretAccount(workspaceId, name) });
  // A secret wins over a plain variable of the same name.
  for (const name of secrets.keys()) env.delete(name);
  const python = settingsFor(workspaceId, base).python;
  return {
    env: [...env.values()],
    secrets: [...secrets.values()],
    python: python.kind !== "none" && python.target ? { kind: python.kind, target: python.target } : null,
  };
}

/** `terminalEnvironment` for a pane, with its secrets read ahead so the spawn does not wait on the keystore. */
export async function terminalEnvironmentForPane(paneId: string): Promise<TerminalEnvironment> {
  const environment = terminalEnvironment(workspaceOfPane(paneId));
  if (environment.secrets.length) await warmSecrets(environment.secrets.map((secret) => secret.account));
  return environment;
}
