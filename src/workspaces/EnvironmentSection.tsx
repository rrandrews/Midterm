import { isTauri } from "@tauri-apps/api/core";
import { Check, FolderOpen, KeyRound, Plus, Trash2, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Tip } from "../components/ui/Tooltip";
import { stat } from "../ipc/fs";
import { homeDirectory } from "../ipc/system";
import { deleteSecret, secretAccount, secretStatus, setSecret } from "../ipc/secrets";
import { BUTTON, BUTTON_PRIMARY, Block, CommitField, FIELD, Group, ICON_BUTTON, Row, Segmented } from "../settings/controls";
import { type EnvVar, type PythonEnv, ENV_LIMIT, reservedEnvName, validEnvName } from "../settings/schema";
import { useEditedWorkspace, useScopedActions, useScopedSettings, useSettingsScope } from "../settings/scope";
import { DEFAULT_SCOPE, type SettingsScope, useSettings, workspaceSettings } from "../settings/settings";

/*
 * Settings → Environment: variables, secrets and the Python environment
 * new terminals start with. The defaults apply to every workspace; a
 * workspace adds its own on top (same name: the workspace's wins) and may
 * pick another Python environment. Secret values go to the OS keystore and
 * are never shown again. Nothing here touches terminals already running.
 */

const MONO = "font-mono text-meta!";

/** The edited scope's own variables and secret names, and the defaults' when a workspace is edited. */
function useEnvironment() {
  const scope = useSettingsScope() ?? DEFAULT_SCOPE;
  const workspace = useEditedWorkspace();
  const own = useSettings((state) => (workspace ? workspaceSettings(workspace, state.base) : state.base));
  const inherited = useSettings((state) => (workspace ? state.base : null));
  return { scope, workspace, own, inherited };
}

function nameProblem(name: string, taken: string[]): string | null {
  if (!name) return "A name is needed.";
  if (reservedEnvName(name)) return "Names starting with MIDTERM_ or _midterm are Midterm’s own.";
  if (!validEnvName(name)) return "Letters, digits and _ only, not starting with a digit.";
  if (taken.includes(name)) return "Already defined here.";
  return null;
}

/** A small label after a name: where it comes from or what happened to it. */
function Tag({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "accent" | "ok" | "warn" }) {
  const tones = {
    dim: "bg-fg-bright/[0.05] text-fg-dim",
    accent: "bg-accent/15 text-accent-fg",
    ok: "bg-ok/12 text-ok",
    warn: "bg-warn/12 text-warn",
  };
  return <span className={`inline-flex h-4 flex-none items-center gap-1 rounded-[4px] px-1.5 text-micro font-medium ${tones[tone]}`}>{children}</span>;
}

// --- Variables ---------------------------------------------------------------

function VariableRow({
  variable,
  others,
  onChange,
  onRemove,
  autoFocus,
}: {
  variable: EnvVar;
  /** Names of the scope's other variables. */
  others: string[];
  onChange: (next: EnvVar) => void;
  onRemove: () => void;
  autoFocus?: boolean;
}) {
  const [name, setName] = useState(variable.name);
  const [value, setValue] = useState(variable.value);
  useEffect(() => setName(variable.name), [variable.name]);
  useEffect(() => setValue(variable.value), [variable.value]);
  const problem = name !== variable.name ? nameProblem(name.trim(), others) : null;
  const commitName = () => {
    const next = name.trim();
    if (next === variable.name) return;
    if (nameProblem(next, others)) return;
    onChange({ name: next, value });
  };
  return (
    <div className="settings-row group/var flex min-h-10 items-center gap-2 px-3 py-1.5">
      <div className="flex w-[42%] flex-none flex-col">
        <input
          aria-label="Variable name"
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          placeholder="NAME"
          className={`${FIELD} ${MONO} w-full ${problem ? "shadow-[inset_0_0_0_1px_var(--color-warn)]!" : ""}`}
          value={name}
          data-escape-local={name !== variable.name ? "" : undefined}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitName();
            if (event.key === "Escape" && name !== variable.name) {
              event.stopPropagation();
              setName(variable.name);
            }
          }}
        />
        {problem && <span className="px-0.5 pt-0.5 text-micro text-warn">{problem}</span>}
      </div>
      <span className="flex-none font-mono text-meta text-fg-faint" aria-hidden="true">
        =
      </span>
      <input
        aria-label={`Value of ${variable.name || "the new variable"}`}
        spellCheck={false}
        autoComplete="off"
        placeholder="value"
        className={`${FIELD} ${MONO} min-w-0 flex-1 ${problem ? "self-start" : ""}`}
        value={value}
        data-escape-local={value !== variable.value ? "" : undefined}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => value !== variable.value && variable.name && onChange({ name: variable.name, value })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && variable.name) onChange({ name: variable.name, value });
          if (event.key === "Escape" && value !== variable.value) {
            event.stopPropagation();
            setValue(variable.value);
          }
        }}
      />
      <Tip content="Remove">
        <button type="button" aria-label={`Remove ${variable.name || "variable"}`} className={`${ICON_BUTTON} ${problem ? "self-start" : ""}`} onClick={onRemove}>
          <Trash2 size={12} />
        </button>
      </Tip>
    </div>
  );
}

/** A defaults' entry shown read-only while a workspace is edited. */
function InheritedRow({ name, detail, overridden, onOverride }: { name: string; detail: ReactNode; overridden: boolean; onOverride?: () => void }) {
  return (
    <div className="settings-row flex min-h-9 items-center gap-2 px-3 py-1">
      <span className={`min-w-0 truncate font-mono text-meta ${overridden ? "text-fg-faint line-through" : "text-fg-mid"}`}>{name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-meta text-fg-faint">{detail}</span>
      {overridden ? (
        <Tag tone="accent">Overridden</Tag>
      ) : (
        onOverride && (
          <button type="button" className={`${BUTTON} h-5! px-2! text-micro!`} onClick={onOverride}>
            Override
          </button>
        )
      )}
    </div>
  );
}

function Variables() {
  const { scope, workspace, own, inherited } = useEnvironment();
  const [adding, setAdding] = useState(false);
  const save = (env: EnvVar[]) => useSettings.getState().updateEnvironment(scope, { env });
  const names = own.env.map((variable) => variable.name);
  const ownNames = new Set(names);
  return (
    <Group
      title="Variables"
      help={
        workspace
          ? "Added to the defaults’ variables for this workspace’s new terminals. A name defined in both takes this workspace’s value. Values are used as written ($HOME is not expanded)."
          : "Set in every new terminal, before your shell’s startup files run (which may change them). Values are used as written ($HOME is not expanded)."
      }
      actions={
        <button type="button" className={BUTTON} disabled={adding || own.env.length >= ENV_LIMIT} onClick={() => setAdding(true)}>
          <Plus size={12} /> Add variable
        </button>
      }
    >
      {own.env.map((variable, index) => (
        <VariableRow
          key={variable.name}
          variable={variable}
          others={names.filter((name) => name !== variable.name)}
          onChange={(next) => save(own.env.map((current, i) => (i === index ? next : current)))}
          onRemove={() => save(own.env.filter((_, i) => i !== index))}
        />
      ))}
      {adding && (
        <VariableRow
          variable={{ name: "", value: "" }}
          others={names}
          autoFocus
          onChange={(next) => {
            save([...own.env, next]);
            setAdding(false);
          }}
          onRemove={() => setAdding(false)}
        />
      )}
      {!own.env.length && !adding && (
        <Block className="text-meta text-fg-dim">{workspace ? "No variables of its own." : "No variables."}</Block>
      )}
      {inherited && inherited.env.length > 0 && (
        <>
          <SubHeading>From the defaults</SubHeading>
          {inherited.env.map((variable) => (
            <InheritedRow
              key={variable.name}
              name={variable.name}
              detail={`= ${variable.value}`}
              overridden={ownNames.has(variable.name)}
              onOverride={() => save([...own.env, { ...variable }])}
            />
          ))}
        </>
      )}
    </Group>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <div className="settings-row bg-fg-bright/[0.02] px-3 pt-2 pb-1 text-micro font-medium text-fg-dim">{children}</div>;
}

// --- Secrets -----------------------------------------------------------------

/** Whether each of a scope's secrets has a value in the keystore (refreshed when the list changes). */
function useSecretStatus(scope: SettingsScope, names: string[], version: number): Record<string, boolean | undefined> {
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const key = names.join("\n");
  useEffect(() => {
    let live = true;
    if (!names.length) return;
    secretStatus(names.map((name) => secretAccount(scope, name)))
      .then((set) => live && setStatus(Object.fromEntries(names.map((name, i) => [name, set[i]]))))
      .catch((error) => console.warn("Could not read the secrets’ status:", error));
    return () => {
      live = false;
    };
    // `key` stands for `names`.
  }, [scope, key, version]);
  return status;
}

/** A password field with Save, for a new secret's value or a replacement. */
function SecretValueForm({
  onSave,
  onCancel,
  label,
  autoFocus,
}: {
  onSave: (value: string) => Promise<void>;
  onCancel: () => void;
  label: string;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(value);
    } catch (problem) {
      setError(String(problem));
      setBusy(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <input
          type="password"
          aria-label={label}
          placeholder="Value"
          autoComplete="off"
          autoFocus={autoFocus}
          className={`${FIELD} ${MONO} min-w-0 flex-1`}
          value={value}
          data-escape-local=""
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
            if (event.key === "Escape") {
              event.stopPropagation();
              onCancel();
            }
          }}
        />
        <button type="button" className={BUTTON_PRIMARY} disabled={!value.trim() || busy} onClick={() => void submit()}>
          Save
        </button>
        <button type="button" className={BUTTON} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <span className="text-micro text-err">{error}</span>}
    </div>
  );
}

function SecretRow({ name, scope, set, onChanged, onRemove }: { name: string; scope: SettingsScope; set: boolean | undefined; onChanged: () => void; onRemove: () => void }) {
  const [replacing, setReplacing] = useState(false);
  return (
    <div className="settings-row flex min-h-10 items-center gap-2 px-3 py-1.5">
      <KeyRound size={12} className="flex-none text-fg-dim" aria-hidden="true" />
      <span className="w-[34%] min-w-0 flex-none truncate font-mono text-meta text-fg-soft">{name}</span>
      {replacing ? (
        <SecretValueForm
          label={`New value of ${name}`}
          autoFocus
          onCancel={() => setReplacing(false)}
          onSave={async (value) => {
            await setSecret(secretAccount(scope, name), value);
            setReplacing(false);
            onChanged();
          }}
        />
      ) : (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="font-mono text-meta tracking-[0.2em] text-fg-faint" aria-hidden="true">
              ••••••••
            </span>
            {set === true && (
              <Tag tone="ok">
                <Check size={9} strokeWidth={2.5} /> Stored
              </Tag>
            )}
            {set === false && (
              <Tag tone="warn">
                <TriangleAlert size={9} strokeWidth={2.5} /> No value
              </Tag>
            )}
          </span>
          <button type="button" className={BUTTON} onClick={() => setReplacing(true)}>
            {set === false ? "Set…" : "Replace…"}
          </button>
          <Tip content="Delete">
            <button type="button" aria-label={`Delete ${name}`} className={ICON_BUTTON} onClick={onRemove}>
              <Trash2 size={12} />
            </button>
          </Tip>
        </>
      )}
    </div>
  );
}

function NewSecret({ taken, onSave, onCancel }: { taken: string[]; onSave: (name: string, value: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const problem = trimmed ? nameProblem(trimmed, taken) : null;
  return (
    <div className="settings-row flex items-start gap-2 px-3 py-2">
      <KeyRound size={12} className="mt-1.5 flex-none text-accent" aria-hidden="true" />
      <div className="flex w-[34%] flex-none flex-col">
        <input
          aria-label="Secret name"
          placeholder="NAME"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          className={`${FIELD} ${MONO} w-full ${problem ? "shadow-[inset_0_0_0_1px_var(--color-warn)]!" : ""}`}
          value={name}
          data-escape-local=""
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onCancel();
            }
          }}
        />
        {problem && <span className="px-0.5 pt-0.5 text-micro text-warn">{problem}</span>}
      </div>
      <SecretValueForm
        label="Secret value"
        onCancel={onCancel}
        onSave={async (value) => {
          const error = nameProblem(trimmed, taken);
          if (error) throw error;
          await onSave(trimmed, value);
        }}
      />
    </div>
  );
}

function Secrets() {
  const { scope, workspace, own, inherited } = useEnvironment();
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);
  const status = useSecretStatus(scope, own.secrets, version);
  const save = (secrets: string[]) => useSettings.getState().updateEnvironment(scope, { secrets });
  const ownNames = new Set(own.secrets);
  const [problem, setProblem] = useState<string | null>(null);
  // The value goes first: if the keystore refuses, the name stays listed so it can be tried again.
  const remove = async (name: string) => {
    setProblem(null);
    try {
      await deleteSecret(secretAccount(scope, name));
    } catch (error) {
      setProblem(`Could not delete ${name}: ${String(error)}`);
      return;
    }
    save(currentSecrets(scope).filter((candidate) => candidate !== name));
  };
  return (
    <Group
      title="Secrets"
      help={`Environment variables whose values are kept in ${isTauri() ? "the macOS Keychain" : "memory (browser build)"}, never in Midterm’s settings files, and never shown again once saved. ${workspace ? "Added to the defaults’ secrets for this workspace; a name defined in both uses this workspace’s value." : "Set in every new terminal."}`}
      actions={
        <button type="button" className={BUTTON} disabled={adding || own.secrets.length >= ENV_LIMIT} onClick={() => setAdding(true)}>
          <Plus size={12} /> Add secret
        </button>
      }
    >
      {own.secrets.map((name) => (
        <SecretRow
          key={name}
          name={name}
          scope={scope}
          set={status[name]}
          onChanged={() => setVersion((n) => n + 1)}
          onRemove={() => void remove(name)}
        />
      ))}
      {adding && (
        <NewSecret
          taken={own.secrets}
          onCancel={() => setAdding(false)}
          onSave={async (name, value) => {
            await setSecret(secretAccount(scope, name), value);
            save([...own.secrets, name]);
            setAdding(false);
            setVersion((n) => n + 1);
          }}
        />
      )}
      {!own.secrets.length && !adding && (
        <Block className="text-meta text-fg-dim">{workspace ? "No secrets of its own." : "No secrets."}</Block>
      )}
      {problem && <Block className="text-meta text-err">{problem}</Block>}
      {inherited && inherited.secrets.length > 0 && (
        <>
          <SubHeading>From the defaults</SubHeading>
          {inherited.secrets.map((name) => (
            <InheritedRow key={name} name={name} detail="••••••••" overridden={ownNames.has(name)} />
          ))}
        </>
      )}
    </Group>
  );
}

/** A scope's secret names as they are now (not as they were when a click's handler was made). */
function currentSecrets(scope: SettingsScope): string[] {
  const { base } = useSettings.getState();
  return scope === DEFAULT_SCOPE ? base.secrets : workspaceSettings(scope, base).secrets;
}

// --- Python ------------------------------------------------------------------

/** Whether a virtualenv directory has an activate script (Tauri only). */
function useVenvCheck(path: string): "ok" | "missing" | "unknown" {
  const [result, setResult] = useState<"ok" | "missing" | "unknown">("unknown");
  useEffect(() => {
    if (!path || !isTauri()) {
      setResult("unknown");
      return;
    }
    let live = true;
    stat(`${path.replace(/\/+$/, "")}/bin/activate`)
      .then((entry) => live && setResult(entry ? "ok" : "missing"))
      .catch(() => live && setResult("unknown"));
    return () => {
      live = false;
    };
  }, [path]);
  return result;
}

async function pickVenv(current: string): Promise<string | null> {
  if (!isTauri()) {
    const typed = window.prompt("Virtualenv folder", current);
    return typed?.trim() || null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, defaultPath: current || undefined, title: "Python virtualenv" });
  return typeof picked === "string" ? picked : null;
}

const PYTHON_OPTIONS = [
  { value: "none" as const, label: "None" },
  { value: "venv" as const, label: "Virtualenv" },
  { value: "conda" as const, label: "Conda" },
];

function Python() {
  const python = useScopedSettings((state) => state.python);
  const { updateSettings } = useScopedActions();
  const workspace = useEditedWorkspace();
  // Each kind remembers what was typed for it while switching back and forth.
  const remembered = useRef<Record<string, string>>({ [python.kind]: python.target });
  const set = (next: PythonEnv) => {
    remembered.current[next.kind] = next.target;
    updateSettings({ python: next });
  };
  const check = useVenvCheck(python.kind === "venv" ? python.target : "");
  // A relative folder is refused (it would be looked up wherever a terminal opens).
  const [relative, setRelative] = useState<string | null>(null);
  const commitVenv = (typed: string) => {
    const target = expandHome(typed.trim());
    if (target && !target.startsWith("/")) {
      setRelative(target);
      return;
    }
    setRelative(null);
    set({ kind: "venv", target });
  };
  return (
    <Group
      title="Python"
      help="Activated in each new terminal once your shell’s startup files have run, so it comes first on PATH and your prompt shows it. A virtualenv runs its bin/activate; a conda environment needs conda set up in your shell (conda init)."
    >
      <Row label="Environment" setting="python" help={workspace ? "Unless set here, this workspace uses the defaults’ choice." : undefined}>
        <Segmented
          label="Python environment"
          value={python.kind}
          options={PYTHON_OPTIONS}
          onChange={(kind) => set({ kind, target: kind === "none" ? "" : (remembered.current[kind] ?? "") })}
        />
      </Row>
      {python.kind === "venv" && (
        <Row
          label="Folder"
          hint={
            relative ? (
              <span className="inline-flex items-center gap-1 text-warn">
                <TriangleAlert size={10} strokeWidth={2.5} /> Use a full path (from / or ~), not “{relative}”
              </span>
            ) : !python.target ? (
              "Pick the virtualenv’s folder (the one with bin/activate)."
            ) : check === "ok" ? (
              <span className="inline-flex items-center gap-1 text-ok">
                <Check size={10} strokeWidth={2.5} /> Found bin/activate
              </span>
            ) : check === "missing" ? (
              <span className="inline-flex items-center gap-1 text-warn">
                <TriangleAlert size={10} strokeWidth={2.5} /> No bin/activate in this folder
              </span>
            ) : undefined
          }
        >
          <CommitField
            label="Virtualenv folder"
            className={`w-64 ${MONO}`}
            placeholder="~/project/.venv"
            value={python.target}
            onCommit={commitVenv}
          />
          <Tip content="Choose a folder">
            <button
              type="button"
              aria-label="Choose a folder"
              className={ICON_BUTTON}
              onClick={() => void pickVenv(python.target).then((path) => path && commitVenv(path))}
            >
              <FolderOpen size={13} />
            </button>
          </Tip>
        </Row>
      )}
      {python.kind === "conda" && (
        <Row label="Environment name" hint={python.target ? `Runs conda activate ${python.target}` : "As listed by conda env list."}>
          <CommitField
            label="Conda environment"
            className={`w-64 ${MONO}`}
            placeholder="base"
            value={python.target}
            onCommit={(target) => set({ kind: "conda", target: target.trim() })}
          />
        </Row>
      )}
    </Group>
  );
}

/** `~/x` → `/Users/me/x`: the backend takes the path literally. */
function expandHome(path: string): string {
  const home = homeDirectory();
  return home && (path === "~" || path.startsWith("~/")) ? home + path.slice(1) : path;
}

export function EnvironmentSection() {
  return (
    <>
      <p className="mb-4 px-1 pt-1 text-meta text-fg-dim">Changes apply to terminals opened afterwards.</p>
      <Variables />
      <Secrets />
      <Python />
    </>
  );
}
