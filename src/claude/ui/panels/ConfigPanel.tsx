import { type FormattingOptions, type JSONPath, type ParseError, applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import { Braces, ExternalLink, FileText, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { openFile } from "../../../actions";
import { Combobox } from "../../../components/ui/Combobox";
import { create as createPath, stat, writeTextFile } from "../../../ipc/fs";
import { homeDirectory } from "../../../ipc/system";
import { CommitField, FIELD } from "../../../settings/controls";
import { request } from "../../client";
import type { ConfigFile, ConfigScope, MemoryFile } from "../../protocol";
import { getSession, useSession } from "../../store";
import { tildePath } from "./format";
import { Badge, Button, ErrorLine, Heading, IconButton, Segmented, Spinner, Toolbar, errorText } from "./shared";

/*
 * Config: the Claude Code settings files (user, project, local) as fields
 * (model, effort, default permission mode, permission rules, env) or raw
 * JSON. Field edits are applied to the text with jsonc-parser, so comments,
 * unknown keys and formatting survive. Drafts outlive the panel closing.
 * Below: the CLAUDE.md memory files, opened (or created) in an editor pane.
 */

type Draft = { file: ConfigFile; text: string };
type ConfigState = { drafts: Record<string, Draft>; scope: Record<string, ConfigScope>; raw: Record<string, boolean> };
const useConfigState = create<ConfigState>(() => ({ drafts: {}, scope: {}, raw: {} }));
const draftKey = (cwd: string, scope: ConfigScope) => `${scope}\u0000${cwd}`;
const setDraft = (key: string, draft: Draft) => useConfigState.setState((state) => ({ drafts: { ...state.drafts, [key]: draft } }));

const SCOPES: { value: ConfigScope; label: string; title: string }[] = [
  { value: "user", label: "User", title: "Your settings, for every project" },
  { value: "project", label: "Project", title: "Shared with the repo (.claude/settings.json)" },
  { value: "local", label: "Local", title: "This project, only you (.claude/settings.local.json)" },
];

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const MODES: { value: string; label: string }[] = [
  { value: "default", label: "Ask" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" },
  { value: "dontAsk", label: "Don’t ask" },
  { value: "bypassPermissions", label: "Bypass permissions" },
];
const RULE_LISTS = [
  { key: "allow", label: "Allow", tone: "ok" },
  { key: "ask", label: "Ask", tone: "warn" },
  { key: "deny", label: "Deny", tone: "err" },
] as const;

/** The file's own indentation and line ends, for edits that look like the rest of it. */
function formattingOf(text: string): FormattingOptions {
  const indent = /^([ \t]+)["}\]]/m.exec(text)?.[1];
  const insertSpaces = !indent?.startsWith("\t");
  return {
    insertSpaces,
    tabSize: indent && insertSpaces ? indent.length : 2,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    insertFinalNewline: true,
  };
}

type Parsed = { value?: Record<string, unknown>; error?: string };

function parseSettings(text: string): Parsed {
  if (!text.trim()) return { value: {} };
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    const before = text.slice(0, first.offset).split("\n");
    return { error: `Line ${before.length}, column ${before[before.length - 1].length + 1}: ${describe(printParseErrorCode(first.error))}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "The settings must be a JSON object." };
  return { value };
}

function describe(code: string): string {
  // "CommaExpected" → "comma expected"
  return code.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/^./, (first) => first.toUpperCase());
}

function edit(text: string, path: JSONPath, value: unknown, insert = false): string {
  const base = text.trim() ? text : "{}\n";
  const edits = modify(base, path, value, { formattingOptions: formattingOf(base), isArrayInsertion: insert });
  return applyEdits(base, edits);
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function ConfigPanel({ sessionKey }: { sessionKey: string }) {
  const cwd = useSession(sessionKey, (session) => session?.cwd ?? "");
  const models = useSession(sessionKey, (session) => session?.init?.models);
  const scope = useConfigState((state) => state.scope[sessionKey] ?? "user");
  const raw = useConfigState((state) => state.raw[sessionKey] ?? false);
  const key = draftKey(cwd, scope);
  const draft = useConfigState((state) => state.drafts[key]);
  const dirtyScopes = useConfigState((state) => SCOPES.filter(({ value }) => {
    const other = state.drafts[draftKey(cwd, value)];
    return other && other.text !== other.file.text;
  }).map(({ value }) => value).join(","));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const file = await request("config.read", { cwd, scope });
      setDraft(key, { file, text: file.text });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!useConfigState.getState().drafts[key]) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const text = draft?.text ?? "";
  const parsed = useMemo(() => parseSettings(text), [text]);
  const dirty = !!draft && draft.text !== draft.file.text;
  const settings = parsed.value;

  const change = (path: JSONPath, value: unknown, insert = false) => {
    if (!draft) return;
    try {
      setDraft(key, { ...draft, text: edit(draft.text, path, value, insert) });
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const save = async () => {
    if (!draft || parsed.error) return;
    setSaving(true);
    setError(undefined);
    try {
      const file = await request("config.write", { cwd, scope, text: draft.text });
      setDraft(key, { file, text: file.text });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };

  const openInEditor = async () => {
    const paneId = getSession(sessionKey)?.paneId;
    if (!draft || !paneId) return;
    try {
      if (!draft.file.exists) {
        const file = await request("config.write", { cwd, scope, text: draft.text.trim() ? draft.text : "{}\n" });
        setDraft(key, { file, text: file.text });
        openFile(file.path, { fromPaneId: paneId });
      } else openFile(draft.file.path, { fromPaneId: paneId });
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const permissions = record(settings?.permissions);
  const env = record(settings?.env);

  return (
    <>
      <Toolbar>
        <Segmented<ConfigScope>
          label="Settings scope"
          className="cp-grow"
          value={scope}
          onChange={(next) => useConfigState.setState((state) => ({ scope: { ...state.scope, [sessionKey]: next } }))}
          options={SCOPES.map((option) => ({
            ...option,
            label: (
              <>
                {option.label}
                {dirtyScopes.split(",").includes(option.value) && <span className="cp-dirty-dot" aria-label="unsaved" />}
              </>
            ),
          }))}
        />
        <IconButton
          label={raw ? "Edit as fields" : "Edit JSON"}
          aria-pressed={raw}
          className={raw ? "cp-pressed" : ""}
          onClick={() => useConfigState.setState((state) => ({ raw: { ...state.raw, [sessionKey]: !raw } }))}
        >
          <Braces size={12} />
        </IconButton>
        <IconButton label="Open in editor" disabled={!draft} onClick={() => void openInEditor()}>
          <ExternalLink size={12} />
        </IconButton>
      </Toolbar>
      <div className="cp-path">
        <span className="cp-mono cp-truncate" title={draft?.file.path}>
          {draft ? tildePath(draft.file.path, homeDirectory()) : " "}
        </span>
        {draft && !draft.file.exists && <Badge>new file</Badge>}
        {loading && <Spinner size={11} />}
      </div>
      <div className="cp-body">
        {error && <ErrorLine>{error}</ErrorLine>}
        {!draft ? (
          loading && (
            <div className="cp-loading">
              <Spinner /> Reading settings…
            </div>
          )
        ) : raw || parsed.error ? (
          <RawEditor text={text} error={parsed.error} forced={!raw} onChange={(next) => setDraft(key, { ...draft, text: next })} />
        ) : (
          <>
            <Heading>Model</Heading>
            <Field label="Model" hint="Default for new sessions">
              <Combobox
                label="Model"
                className="w-[148px]"
                value={typeof settings?.model === "string" ? settings.model : ""}
                options={(models ?? []).map((model) => model.value)}
                placeholder="default"
                emptyText="Type a model id"
                onCommit={(value) => change(["model"], value || undefined)}
              />
            </Field>
            <Field label="Effort">
              <PlainSelect
                label="Effort"
                value={typeof settings?.effortLevel === "string" ? settings.effortLevel : ""}
                options={EFFORTS.map((effort) => ({ value: effort, label: effort[0].toUpperCase() + effort.slice(1) }))}
                onChange={(value) => change(["effortLevel"], value || undefined)}
              />
            </Field>
            <Field label="Permission mode" hint="How a session starts">
              <PlainSelect
                label="Default permission mode"
                value={typeof permissions.defaultMode === "string" ? permissions.defaultMode : ""}
                options={MODES}
                onChange={(value) => change(["permissions", "defaultMode"], value || undefined)}
              />
            </Field>

            <Heading>Permission rules</Heading>
            {RULE_LISTS.map((list) => (
              <RuleList
                key={list.key}
                label={list.label}
                tone={list.tone}
                rules={strings(permissions[list.key])}
                onAdd={(rule) => change(["permissions", list.key, strings(permissions[list.key]).length], rule, true)}
                onRemove={(index) => change(["permissions", list.key, index], undefined)}
              />
            ))}

            <Heading aside={Object.keys(env).length > 0 && <span className="cp-mono">{Object.keys(env).length}</span>}>Environment</Heading>
            <EnvEditor
              env={env}
              onSet={(name, value) => change(["env", name], value)}
              onRename={(from, to) => {
                if (!draft || !to || to === from || to in env) return;
                try {
                  const value = env[from];
                  setDraft(key, { ...draft, text: edit(edit(draft.text, ["env", from], undefined), ["env", to], value) });
                } catch (failure) {
                  setError(errorText(failure));
                }
              }}
              onRemove={(name) => change(["env", name], undefined)}
            />
          </>
        )}

        <Memory sessionKey={sessionKey} cwd={cwd} />
      </div>
      {dirty && (
        <div className="cp-savebar">
          <span className="cp-savebar-text">Unsaved changes</span>
          <Button variant="ghost" disabled={saving} onClick={() => void load()} title="Discard changes and read the file again">
            Revert
          </Button>
          <Button variant="primary" busy={saving} disabled={!!parsed.error} onClick={() => void save()}>
            Save
          </Button>
        </div>
      )}
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="cp-field">
      <div className="cp-field-label">
        <span>{label}</span>
        {hint && <span className="cp-field-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function PlainSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  const known = value === "" || options.some((option) => option.value === value);
  return (
    <select aria-label={label} className={`${FIELD} w-[148px] pr-6`} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Not set</option>
      {!known && <option value={value}>{value}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function RuleList({ label, tone, rules, onAdd, onRemove }: { label: string; tone: "ok" | "warn" | "err"; rules: string[]; onAdd: (rule: string) => void; onRemove: (index: number) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const rule = draft.trim();
    if (!rule) return;
    if (!rules.includes(rule)) onAdd(rule);
    setDraft("");
  };
  return (
    <div className="cp-rules">
      <div className="cp-rules-label">
        <span className={`cp-dot cp-tone-${tone}`} aria-hidden="true" />
        {label}
        <span className="cp-faint cp-mono">{rules.length || ""}</span>
      </div>
      <div className="cp-chips">
        {rules.map((rule, index) => (
          <span key={`${index}:${rule}`} className="cp-chip">
            <span className="cp-chip-text" title={rule}>
              {rule}
            </span>
            <button type="button" className="cp-chip-remove" aria-label={`Remove ${rule}`} onClick={() => onRemove(index)}>
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          className="cp-chip-input"
          spellCheck={false}
          placeholder={rules.length ? "Add…" : "Add a rule, e.g. Bash(npm test:*)"}
          aria-label={`Add a rule to ${label}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={add}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            } else if (event.key === "Escape" && draft) {
              event.preventDefault();
              setDraft("");
            } else if (event.key === "Backspace" && !draft && rules.length) {
              onRemove(rules.length - 1);
            }
          }}
        />
      </div>
    </div>
  );
}

function EnvEditor({
  env,
  onSet,
  onRename,
  onRemove,
}: {
  env: Record<string, unknown>;
  onSet: (name: string, value: string) => void;
  onRename: (from: string, to: string) => void;
  onRemove: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const add = () => {
    const key = name.trim();
    if (!key) return;
    onSet(key, value);
    setName("");
    setValue("");
  };
  return (
    <div className="cp-env">
      {Object.entries(env).map(([key, current]) => (
        <div key={key} className="cp-env-row">
          <CommitField label="Variable name" className="cp-env-key" value={key} onCommit={(next) => onRename(key, next.trim())} />
          <CommitField label={`Value of ${key}`} className="cp-env-value" value={typeof current === "string" ? current : JSON.stringify(current)} onCommit={(next) => onSet(key, next)} />
          <IconButton label={`Remove ${key}`} onClick={() => onRemove(key)}>
            <X size={11} />
          </IconButton>
        </div>
      ))}
      <form
        className="cp-env-row"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input aria-label="New variable name" spellCheck={false} placeholder="NAME" className={`${FIELD} cp-env-key`} value={name} onChange={(event) => setName(event.target.value)} />
        <input aria-label="New variable value" spellCheck={false} placeholder="value" className={`${FIELD} cp-env-value`} value={value} onChange={(event) => setValue(event.target.value)} />
        <IconButton label="Add variable" type="submit" disabled={!name.trim()}>
          <Plus size={12} />
        </IconButton>
      </form>
    </div>
  );
}

function RawEditor({ text, error, forced, onChange }: { text: string; error?: string; forced: boolean; onChange: (text: string) => void }) {
  return (
    <div className="cp-raw">
      {forced && <p className="cp-note">The file isn’t valid JSON, so it can only be edited as text until it is.</p>}
      <textarea
        className="cp-raw-text"
        spellCheck={false}
        aria-label="Settings JSON"
        aria-invalid={!!error}
        value={text}
        placeholder="{}"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Tab indents instead of leaving the field.
          if (event.key !== "Tab" || event.shiftKey) return;
          event.preventDefault();
          const field = event.currentTarget;
          const { selectionStart, selectionEnd } = field;
          field.setRangeText("  ", selectionStart, selectionEnd, "end");
          onChange(field.value);
        }}
      />
      <div className={`cp-raw-status ${error ? "cp-err" : "cp-ok"}`}>{error ?? "Valid JSON"}</div>
    </div>
  );
}

function Memory({ sessionKey, cwd }: { sessionKey: string; cwd: string }) {
  const [files, setFiles] = useState<MemoryFile[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const home = homeDirectory();

  const load = async () => {
    try {
      setFiles(await request("config.memoryFiles", { cwd }));
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const open = async (file: MemoryFile) => {
    const paneId = getSession(sessionKey)?.paneId;
    if (!paneId) return;
    setError(undefined);
    setBusy(file.path);
    try {
      if (!file.exists) {
        const parent = file.path.slice(0, file.path.lastIndexOf("/"));
        if (parent && !(await stat(parent))) await createPath(parent, "dir");
        await writeTextFile(file.path, "", { kind: "absent" });
        await load();
      }
      openFile(file.path, { fromPaneId: paneId });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <Heading>Memory</Heading>
      {error && <ErrorLine onRetry={() => void load()}>{error}</ErrorLine>}
      <ul className="cp-list">
        {files?.map((file, index) => (
          <li key={`${index}:${file.path}`} className={`cp-row cp-row-tight${file.exists ? "" : " cp-row-off"}`}>
            <FileText size={12} className="cp-row-icon" aria-hidden="true" />
            <div className="cp-row-main">
              <div className="cp-row-title">
                <span className="cp-row-name">{file.label}</span>
              </div>
              <div className="cp-row-meta">
                <span className="cp-mono cp-truncate" title={file.path}>
                  {tildePath(file.path, home)}
                </span>
              </div>
            </div>
            <Button variant={file.exists ? "default" : "ghost"} busy={busy === file.path} onClick={() => void open(file)}>
              {file.exists ? "Open" : "Create"}
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}
