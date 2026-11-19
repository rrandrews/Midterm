import { useCallback, useEffect, useState } from "react";
import {
  type CliStatus,
  PROVIDERS,
  aiCliStatus,
  aiKeyDelete,
  aiKeySet,
  aiKeyStatus,
  aiModels,
  aiTest,
  providerInfo,
  toAiError,
} from "../ipc/ai";
import { BUTTON, CommitField, FIELD, Row, SectionHeading, Toggle } from "../settings/controls";
import { useSettings } from "../settings/settings";
import { AI_CONTEXT_RANGE } from "../settings/schema";
import { activeTerminal } from "../terminal/blockMode";
import { aiConfigured, contextFor, providerConfig } from "./engine";

/*
 * Settings → AI: next-command suggestions and the provider they come from.
 * Keys are write-only here: they go to the OS keychain and never come back.
 */

type Status = { kind: "key"; set: boolean } | { kind: "cli"; status: CliStatus } | { kind: "loading" } | { kind: "error"; message: string };

function useProviderStatus(provider: string, baseUrl: string, cliPath: string | undefined): [Status | null, () => void] {
  const [status, setStatus] = useState<Status | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const info = providerInfo(provider);
    const config = providerConfig();
    if (!info || !config) {
      setStatus(null);
      return;
    }
    if (info.id === "custom" && !baseUrl) {
      setStatus({ kind: "key", set: false });
      return;
    }
    let live = true;
    setStatus({ kind: "loading" });
    const check: Promise<Status> =
      info.type === "cli"
        ? aiCliStatus(config).then((status) => ({ kind: "cli", status }))
        : aiKeyStatus(config).then((set) => ({ kind: "key", set }));
    void check
      .catch((error: unknown): Status => ({ kind: "error", message: toAiError(error).message }))
      .then((next) => live && setStatus(next));
    return () => {
      live = false;
    };
  }, [provider, baseUrl, cliPath, revision]);
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
  return status.status.found ? (
    <span className="text-ok">
      Found {status.status.path}
      {status.status.version ? ` · ${status.status.version}` : ""}
    </span>
  ) : (
    <span className="text-warn">Not found on the login shell’s PATH</span>
  );
}

function ModelPicker({ provider, model, ready }: { provider: string; model: string; ready: boolean }) {
  const updateAi = useSettings((s) => s.updateAi);
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const info = providerInfo(provider);
  const load = useCallback(() => {
    const config = providerConfig();
    if (!config) return;
    setError(null);
    setModels(null);
    void aiModels(config).then(
      (list) => setModels([...list].sort()),
      (raw: unknown) => setError(toAiError(raw).message),
    );
  }, []);
  useEffect(() => {
    if (ready) load();
    else setModels(null);
  }, [ready, load, provider]);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <CommitField
          label="Model"
          className="w-56 font-mono"
          placeholder={info?.type === "cli" ? "The CLI’s default" : "Model id"}
          value={model}
          onCommit={(next) => updateAi({ model: next.trim() })}
        />
        {models && models.length > 0 && (
          <select aria-label="Available models" className={`${FIELD} w-8 pr-0`} value="" onChange={(event) => updateAi({ model: event.target.value })}>
            <option value="" disabled>
              ▾
            </option>
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        )}
        <button type="button" className={BUTTON} onClick={load} disabled={!ready} title="Refresh the list">
          ↻
        </button>
      </div>
      {error && <span className="max-w-80 truncate text-meta text-err" title={error}>{error}</span>}
      {models && models.length === 0 && info?.type === "cli" && <span className="text-meta text-fg-dim">This CLI does not list models; type one or leave empty.</span>}
    </div>
  );
}

export function AiSection() {
  const ai = useSettings((s) => s.ai);
  const updateAi = useSettings((s) => s.updateAi);
  const info = providerInfo(ai.provider);
  const [status, recheck] = useProviderStatus(ai.provider, ai.baseUrl, ai.cliPaths[ai.provider]);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | "running" | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    setTest(null);
    setKeyDraft("");
    setKeyError(null);
  }, [ai.provider, ai.baseUrl]);

  const keyReady = info?.type === "api" && (!info.needsKey || (status?.kind === "key" && status.set));
  const cliReady = info?.type === "cli" && status?.kind === "cli" && status.status.found;
  const reachable = !!(keyReady || cliReady) && !(info?.id === "custom" && !ai.baseUrl);

  const saveKey = async () => {
    const config = providerConfig();
    if (!config || !keyDraft.trim()) return;
    try {
      await aiKeySet(config, keyDraft);
      setKeyDraft("");
      setKeyError(null);
      recheck();
    } catch (error) {
      setKeyError(toAiError(error).message);
    }
  };
  const deleteKey = async () => {
    const config = providerConfig();
    if (!config) return;
    await aiKeyDelete(config).catch((error: unknown) => setKeyError(toAiError(error).message));
    recheck();
  };
  const runTest = async () => {
    const config = providerConfig();
    if (!config) return;
    setTest("running");
    setTest(await aiTest(config, ai.model).catch((error: unknown) => ({ ok: false, message: toAiError(error).message })));
  };
  const showPreview = async () => {
    const paneId = activeTerminal();
    const context = paneId ? await contextFor(paneId) : null;
    setPreview(context ? `System:\n${context.system}\n\n---\n\n${context.prompt}` : "Focus a terminal pane first: the preview is built from its history.");
  };

  return (
    <div>
      <div className="mb-3 rounded-[5px] bg-raised px-3 py-2 text-meta text-fg-mid">
        Suggestions send the current terminal’s recent commands, their output (cut to its start and end), the directory, git
        branch, shell and OS to the provider you choose. Values that look like secrets are replaced with [redacted] first.
        Nothing is sent until you choose a provider{info?.type === "api" ? " and a model" : ""}, and a suggestion is only ever
        placed in the input editor, never run.
      </div>

      <SectionHeading>Suggestions</SectionHeading>
      <Row label="Suggest next commands" hint="In blocks mode, at an empty prompt of the focused terminal.">
        <Toggle label="Suggest next commands" checked={ai.suggestions} onChange={(suggestions) => updateAi({ suggestions })} />
      </Row>
      <Row label="Context size" hint="Finished commands (with their output) sent with each request.">
        <input
          aria-label="Context size"
          type="number"
          min={AI_CONTEXT_RANGE.min}
          max={AI_CONTEXT_RANGE.max}
          className={`${FIELD} w-20`}
          value={ai.contextBlocks}
          onChange={(event) => updateAi({ contextBlocks: Number(event.target.value) })}
        />
      </Row>

      <SectionHeading>Provider</SectionHeading>
      <Row label="Provider" hint={info ? <StatusLine status={status} needsKey={info.needsKey} /> : "Choose where suggestions come from."}>
        <select
          aria-label="Provider"
          className={`${FIELD} w-56 pr-6`}
          value={ai.provider}
          onChange={(event) => updateAi({ provider: event.target.value, model: "" })}
        >
          <option value="">None</option>
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
          <CommitField label="Base URL" className="w-72 font-mono" placeholder="https://…/v1" value={ai.baseUrl} onCommit={(baseUrl) => updateAi({ baseUrl: baseUrl.trim() })} />
        </Row>
      )}

      {info?.type === "api" && (
        <Row label="API key" hint={keyError ? <span className="text-err">{keyError}</span> : "Stored in the OS keychain; it cannot be shown again."}>
          <div className="flex items-center gap-1.5">
            <input
              aria-label="API key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={status?.kind === "key" && status.set ? "•••••••• (replace)" : "Paste a key"}
              className={`${FIELD} w-48`}
              value={keyDraft}
              disabled={info.id === "custom" && !ai.baseUrl}
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void saveKey()}
            />
            <button type="button" className={BUTTON} disabled={!keyDraft.trim()} onClick={() => void saveKey()}>
              Save
            </button>
            <button type="button" className={BUTTON} disabled={!(status?.kind === "key" && status.set)} onClick={() => void deleteKey()}>
              Remove
            </button>
          </div>
        </Row>
      )}

      {info?.type === "cli" && (
        <Row label="Executable" hint={`Leave empty to look up “${info.executable}” on the login shell’s PATH.`}>
          <CommitField
            label="Executable path"
            className="w-72 font-mono"
            placeholder={info.executable}
            value={ai.cliPaths[info.id] ?? ""}
            onCommit={(path) => {
              const cliPaths = { ...ai.cliPaths };
              if (path.trim()) cliPaths[info.id] = path.trim();
              else delete cliPaths[info.id];
              updateAi({ cliPaths });
            }}
          />
        </Row>
      )}

      {info && (
        <Row label="Model" hint={info.type === "api" ? "Listed by the provider; any id can be typed." : undefined}>
          <ModelPicker provider={ai.provider} model={ai.model} ready={reachable} />
        </Row>
      )}

      {info && (
        <Row
          label="Check"
          hint={
            test === "running" ? (
              "Asking…"
            ) : test ? (
              <span className={test.ok ? "text-ok" : "text-err"}>{test.message}</span>
            ) : aiConfigured() ? (
              "Ready."
            ) : (
              "Choose a model to start."
            )
          }
        >
          <div className="flex items-center gap-1.5">
            <button type="button" className={BUTTON} disabled={test === "running" || (info.type === "api" && !ai.model)} onClick={() => void runTest()}>
              Test
            </button>
            <button type="button" className={BUTTON} onClick={() => void showPreview()}>
              Preview what is sent
            </button>
          </div>
        </Row>
      )}

      {preview !== null && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between text-meta text-fg-dim">
            <span>Sent for the focused terminal, as it is now:</span>
            <button type="button" className={BUTTON} onClick={() => setPreview(null)}>
              Hide
            </button>
          </div>
          <pre data-ai-preview className="max-h-72 overflow-auto rounded-[5px] bg-field p-2 font-mono text-micro whitespace-pre-wrap text-fg-mid">
            {preview}
          </pre>
        </div>
      )}
    </div>
  );
}
