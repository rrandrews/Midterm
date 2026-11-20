import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Combobox } from "../../components/ui/Combobox";
import {
  type AiTarget,
  type CliStatus,
  type Effort,
  type EffortOptions,
  PROVIDERS,
  type ProviderConfig,
  aiCliStatus,
  aiEffortOptions,
  aiKeyDelete,
  aiKeySet,
  aiKeyStatus,
  aiModels,
  aiTest,
  providerInfo,
  toAiError,
} from "../../ipc/ai";
import { BUTTON, CommitField, FIELD, Row } from "../../settings/controls";
import { AI_PROFILE_NAME_MAX, type AiProfile, EFFORT_LEVELS, type EffortLevel } from "../../settings/schema";
import { clearBackoff } from "../engine";
import { AgentStatusLine } from "./AgentStatus";
import { formatExtra, nameTaken, parseExtra, profileProblem, providerConfigOf, saveProfile, targetOf } from "../profiles";

/*
 * Settings → AI → Models: the editor for one model profile. It works on a
 * draft, saved or dropped with Save / Cancel. Keys are the exception: they
 * are saved to (and removed from) the keychain at once, per provider (and
 * for `custom` per base URL), so every profile of that provider shares one.
 */

type Status = { kind: "key"; set: boolean } | { kind: "cli"; status: CliStatus } | { kind: "loading" } | { kind: "error"; message: string };

/** The key or CLI status of a provider config. */
function useProviderStatus(config: ProviderConfig | null): [Status | null, () => void] {
  const [status, setStatus] = useState<Status | null>(null);
  const [revision, setRevision] = useState(0);
  const configKey = JSON.stringify(config);
  useEffect(() => {
    const current: ProviderConfig | null = configKey === "null" ? null : JSON.parse(configKey);
    const info = current ? providerInfo(current.id) : undefined;
    if (!current || !info) {
      setStatus(null);
      return;
    }
    if (info.id === "custom" && !current.baseUrl) {
      setStatus({ kind: "key", set: false });
      return;
    }
    let live = true;
    setStatus({ kind: "loading" });
    const check: Promise<Status> =
      info.type === "cli"
        ? aiCliStatus(current).then((status) => ({ kind: "cli", status }))
        : aiKeyStatus(current).then((set) => ({ kind: "key", set }));
    void check
      .catch((error: unknown): Status => ({ kind: "error", message: toAiError(error).message }))
      .then((next) => live && setStatus(next));
    return () => {
      live = false;
    };
  }, [configKey, revision]);
  return [status, useCallback(() => setRevision((n) => n + 1), [])];
}

function StatusLine({ status, needsKey }: { status: Status | null; needsKey: boolean }) {
  if (!status) return null;
  if (status.kind === "loading") return <span className="text-fg-dim">Checking…</span>;
  if (status.kind === "error") return <span className="text-err">{status.message}</span>;
  if (status.kind === "key")
    return status.set ? (
      <span className="text-ok">Key saved in the keychain</span>
    ) : (
      <span className={needsKey ? "text-warn" : "text-fg-dim"}>{needsKey ? "No key yet" : "No key (optional)"}</span>
    );
  const version = status.status.version ? ` · ${status.status.version}` : "";
  if (status.status.found && status.status.outdated)
    return (
      <span className="text-warn">
        Found {status.status.path}
        {version} · {status.status.outdated}
      </span>
    );
  return status.status.found ? (
    <span className="text-ok">
      Found {status.status.path}
      {version}
    </span>
  ) : (
    <span className="text-warn">Not found on the login shell’s PATH</span>
  );
}

/** The provider's model list, loaded while `ready`; a list is only kept for the config it was asked for. */
function useModelList(config: ProviderConfig | null, ready: boolean) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configKey = JSON.stringify(config);
  const latest = useRef(0);
  const load = useCallback(() => {
    const request = ++latest.current;
    if (!ready || configKey === "null") {
      setModels([]);
      setLoading(false);
      setError(null);
      return;
    }
    // The old config's list must not stay selectable meanwhile.
    setModels([]);
    setLoading(true);
    setError(null);
    void aiModels(JSON.parse(configKey) as ProviderConfig).then(
      (list) => {
        if (request !== latest.current) return;
        setModels([...list].sort());
        setLoading(false);
      },
      (raw: unknown) => {
        if (request !== latest.current) return;
        setModels([]);
        setError(toAiError(raw).message);
        setLoading(false);
      },
    );
  }, [configKey, ready]);
  useEffect(load, [load]);
  return { models, loading, error, reload: load };
}

const EFFORT_LABELS: Record<Effort, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** What `ai_effort_options` says for a target. */
function useEffortOptions(target: AiTarget | null, ready: boolean) {
  const [options, setOptions] = useState<EffortOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Extra JSON does not change the options.
  const key = target && ready ? JSON.stringify({ ...target, extra: undefined }) : null;
  useEffect(() => {
    setOptions(null);
    setError(null);
    if (!key) return;
    let live = true;
    void aiEffortOptions(JSON.parse(key) as AiTarget).then(
      (next) => live && setOptions(next),
      (raw: unknown) => live && setError(toAiError(raw).message),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return { options, error };
}

function EffortRow({ draft, ready, onChange }: { draft: AiProfile; ready: boolean; onChange: (effort: EffortLevel | undefined) => void }) {
  const stored = draft.effort;
  const { options, error } = useEffortOptions(targetOf(draft), ready);
  const levels = options?.levels ?? [];
  // A stored level the model does not offer stays selectable, so the select shows it.
  const listed: Effort[] = stored && stored !== "default" && !levels.includes(stored) ? [...levels, stored] : levels;
  const ordered = EFFORT_LEVELS.filter((level) => listed.includes(level));
  let hint: ReactNode = "How long the model may think before it answers. Higher is slower and costs more.";
  if (error) hint = <span className="text-err">{error}</span>;
  else if (options) {
    const effective = options.effective ? EFFORT_LABELS[options.effective] : null;
    if (stored === undefined) hint = effective ? `Midterm’s pick: ${effective}.` : "Midterm’s pick: nothing is sent.";
    else if (stored !== "default" && options.effective !== stored)
      hint = effective ? `This model does not offer ${EFFORT_LABELS[stored]}; ${effective} is sent.` : "This model takes no effort setting; nothing is sent.";
    if (options.note) hint = <>{hint} {options.note}</>;
  }
  return (
    <Row label="Reasoning effort" hint={hint}>
      <select
        aria-label="Reasoning effort"
        className={`${FIELD} w-56 pr-6`}
        value={stored ?? ""}
        disabled={!ready}
        onChange={(event) => onChange(event.target.value ? (event.target.value as EffortLevel) : undefined)}
      >
        <option value="">Automatic</option>
        <option value="default">Provider default</option>
        {ordered.map((level) => (
          <option key={level} value={level}>
            {EFFORT_LABELS[level]}
            {levels.includes(level) ? "" : " (not offered)"}
          </option>
        ))}
      </select>
    </Row>
  );
}

function KeyRow({ config, status, recheck, isCustom }: { config: ProviderConfig; status: Status | null; recheck: () => void; isCustom: boolean }) {
  const [keyDraft, setKeyDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const configKey = JSON.stringify(config);
  useEffect(() => {
    setKeyDraft("");
    setError(null);
  }, [configKey]);
  const set = status?.kind === "key" && status.set;
  const missingUrl = isCustom && !config.baseUrl;
  const save = async () => {
    if (!keyDraft.trim()) return;
    try {
      await aiKeySet(config, keyDraft);
      clearBackoff();
      setKeyDraft("");
      setError(null);
      recheck();
    } catch (raw) {
      setError(toAiError(raw).message);
    }
  };
  const remove = async () => {
    await aiKeyDelete(config).catch((raw: unknown) => setError(toAiError(raw).message));
    recheck();
  };
  const name = providerInfo(config.id)?.name ?? config.id;
  return (
    <Row
      label="API key"
      hint={
        error ? (
          <span className="text-err">{error}</span>
        ) : (
          `Saved to the OS keychain at once and never shown again. Shared by every model using ${isCustom ? "this base URL" : name}.`
        )
      }
    >
      <div className="flex items-center gap-1.5">
        <input
          aria-label="API key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={set ? "•••••••• (replace)" : "Paste a key"}
          className={`${FIELD} w-48`}
          value={keyDraft}
          disabled={missingUrl}
          onChange={(event) => setKeyDraft(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void save()}
        />
        <button type="button" className={BUTTON} disabled={!keyDraft.trim()} onClick={() => void save()}>
          Save
        </button>
        <button type="button" className={BUTTON} disabled={!set} onClick={() => void remove()}>
          Remove
        </button>
      </div>
    </Row>
  );
}

export function ProfileEditor({ initial, isNew, onDone }: { initial: AiProfile; isNew: boolean; onDone: () => void }) {
  const [draft, setDraft] = useState<AiProfile>(initial);
  const [extraText, setExtraText] = useState(() => formatExtra(initial.extra));
  const [extraError, setExtraError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | "running" | null>(null);
  // Bumped by every draft change and test, so a late answer for an older draft is dropped.
  const testRun = useRef(0);
  const info = providerInfo(draft.provider);
  const config = providerConfigOf(draft);
  const [status, recheck] = useProviderStatus(config);
  const patch = (next: Partial<AiProfile>) => {
    setDraft((current) => ({ ...current, ...next }));
    testRun.current += 1;
    setTest(null);
  };

  const keyReady = info?.type === "api" && (!info.needsKey || (status?.kind === "key" && status.set));
  const cliReady = info?.type === "cli" && status?.kind === "cli" && status.status.found;
  const reachable = !!(keyReady || cliReady) && !(info?.id === "custom" && !draft.baseUrl);
  const modelList = useModelList(config, reachable);

  const name = draft.name.trim();
  const nameError = !name
    ? "Give the model a name."
    : name.length > AI_PROFILE_NAME_MAX
      ? `At most ${AI_PROFILE_NAME_MAX} characters.`
      : nameTaken(name, draft.id)
        ? "Another model has this name."
        : null;

  const checkExtra = () => {
    const parsed = parseExtra(extraText);
    setExtraError(parsed.ok ? null : parsed.error);
    return parsed;
  };
  /** The draft as it would be saved; null while something is invalid. */
  const finished = (): AiProfile | null => {
    if (nameError) return null;
    const profile: AiProfile = { ...draft, name };
    delete profile.extra;
    if (info?.type === "api") {
      const parsed = checkExtra();
      if (!parsed.ok) return null;
      if (parsed.value) profile.extra = parsed.value;
    }
    if (info?.id !== "custom") profile.baseUrl = "";
    if (info?.type !== "cli") profile.cliPath = "";
    return profile;
  };
  const save = () => {
    const profile = finished();
    if (!profile) return;
    saveProfile(profile);
    onDone();
  };
  const runTest = async () => {
    const profile = finished();
    const target = profile && targetOf(profile);
    if (!target) return;
    const run = ++testRun.current;
    setTest("running");
    const result = await aiTest(target).catch((error: unknown) => ({ ok: false, message: toAiError(error).message }));
    if (run === testRun.current) setTest(result);
  };
  const problem = profileProblem(draft);

  return (
    <div data-ai-profile-editor className="mb-2 rounded-[5px] bg-field/60 px-3 pb-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <Row label="Name" hint={nameError ? <span className="text-warn">{nameError}</span> : "How this model is listed under Features."}>
        <input
          aria-label="Name"
          spellCheck={false}
          maxLength={AI_PROFILE_NAME_MAX}
          className={`${FIELD} w-56`}
          value={draft.name}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Row>

      <Row
        label="Provider"
        hint={
          info ? (
            <>
              <StatusLine status={status} needsKey={info.needsKey} />
              <AgentStatusLine provider={info} agent={status?.kind === "cli" ? status.status.agent : undefined} />
            </>
          ) : (
            "Where requests go."
          )
        }
      >
        <select
          aria-label="Provider"
          className={`${FIELD} w-56 pr-6`}
          value={draft.provider}
          onChange={(event) => {
            // Model, effort, extra JSON, base URL and executable belong to the old provider.
            patch({ provider: event.target.value, model: "", effort: undefined, extra: undefined, baseUrl: "", cliPath: "" });
            setExtraText("");
            setExtraError(null);
          }}
        >
          <option value="">Choose…</option>
          {draft.provider && !info && <option value={draft.provider}>Unknown ({draft.provider})</option>}
          <optgroup label="APIs (your key)">
            {PROVIDERS.filter((p) => p.type === "api").map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="CLIs (their own login)">
            {PROVIDERS.filter((p) => p.type === "cli").map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        </select>
      </Row>

      {info?.id === "custom" && (
        <Row label="Base URL" hint="OpenAI-compatible, e.g. http://localhost:11434/v1. A key is kept per URL.">
          <CommitField label="Base URL" className="w-72 font-mono" placeholder="https://…/v1" value={draft.baseUrl} onCommit={(baseUrl) => patch({ baseUrl: baseUrl.trim() })} />
        </Row>
      )}

      {info?.type === "api" && config && <KeyRow config={config} status={status} recheck={recheck} isCustom={info.id === "custom"} />}

      {info?.type === "cli" && (
        <Row label="Executable" hint={`Leave empty to look up “${info.executable}” on the login shell’s PATH.`}>
          <CommitField label="Executable path" className="w-72 font-mono" placeholder={info.executable} value={draft.cliPath} onCommit={(cliPath) => patch({ cliPath: cliPath.trim() })} />
        </Row>
      )}

      {info && (
        <Row label="Model" hint={info.type === "api" ? "Text models listed by the provider; any id can be typed." : "Leave empty for the CLI’s default."}>
          <Combobox
            label="Model"
            className="w-72"
            value={draft.model}
            onCommit={(model) => patch({ model })}
            options={modelList.models}
            placeholder={info.type === "cli" ? "The CLI’s default" : "Model id"}
            loading={modelList.loading}
            error={modelList.error}
            onRefresh={reachable ? modelList.reload : undefined}
            emptyText={
              info.type === "cli"
                ? "This CLI does not list models; type one or leave empty for its default."
                : reachable
                  ? "No models listed; type an id."
                  : "Set up the key to list models; or type an id."
            }
          />
        </Row>
      )}

      {info && <EffortRow draft={draft} ready={reachable} onChange={(effort) => patch({ effort })} />}

      {info?.type === "api" && (
        <div className="flex flex-col gap-1 border-b border-line/60 py-1.5">
          <div className="text-ui text-fg-soft">Extra request JSON</div>
          <textarea
            aria-label="Extra request JSON"
            rows={4}
            spellCheck={false}
            placeholder={'{ "provider": { "order": ["…"] } }'}
            className={`${FIELD} h-auto resize-y py-1 font-mono text-meta`}
            value={extraText}
            onChange={(event) => {
              setExtraText(event.target.value);
              if (extraError) setExtraError(null);
            }}
            onBlur={checkExtra}
          />
          <div className="text-meta text-fg-dim">
            {extraError ? (
              <span className="text-err">{extraError}</span>
            ) : (
              "Merged into the request body. Sampling parameters are rejected by current Anthropic models."
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5 pt-2">
        {info && (
          <button type="button" className={BUTTON} disabled={test === "running" || !!problem || !!extraError} onClick={() => void runTest()}>
            Test
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-meta">
          {test === "running" ? (
            <span className="text-fg-dim">Asking…</span>
          ) : test ? (
            <span className={test.ok ? "text-ok" : "text-err"} title={test.message}>
              {test.message}
            </span>
          ) : problem && info ? (
            <span className="text-fg-dim">{problem}</span>
          ) : null}
        </span>
        <button type="button" className={BUTTON} onClick={onDone}>
          Cancel
        </button>
        <button type="button" className={`${BUTTON} text-fg-bright`} disabled={!!nameError || !!extraError} onClick={save}>
          {isNew ? "Add" : "Save"}
        </button>
      </div>
    </div>
  );
}
