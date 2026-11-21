import { type FormattingOptions, type JSONPath, type ParseError, applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import { Braces, ExternalLink, FileText, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { openFile } from "../../../actions";
import { Combobox } from "../../../components/ui/Combobox";
import { Select } from "../../../components/ui/Select";
import { create as createPath, stat, writeTextFile } from "../../../ipc/fs";
import { homeDirectory } from "../../../ipc/system";
import { CommitField, FIELD } from "../../../settings/controls";
import { BridgeRequestError, request } from "../../client";
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

/**
 * A settings file being edited: the file as it was read (`file.text` is what
 * a save expects to still be on disk), the edited text, and the file as found
 * on disk when a save saw it had changed since.
 */
type Draft = { file: ConfigFile; text: string; conflict?: ConfigFile };
/**
 * Drafts are keyed by the file's path, so panes whose scopes resolve to the
 * same file (every pane's User scope) share one draft instead of saving over
 * each other. `paths` remembers which file a folder's scope resolved to.
 */
type ConfigState = {
  drafts: Record<string, Draft>;
  paths: Record<string, string>;
  scope: Record<string, ConfigScope>;
  raw: Record<string, boolean>;
};
const useConfigState = create<ConfigState>(() => ({ drafts: {}, paths: {}, scope: {}, raw: {} }));
const scopeKey = (cwd: string, scope: ConfigScope) => `${scope}\u0000${cwd}`;
const setDraft = (path: string, draft: Draft) => useConfigState.setState((state) => ({ drafts: { ...state.drafts, [path]: draft } }));
const isDirty = (draft: Draft | undefined) => !!draft && draft.text !== draft.file.text;
/** Whether what is on disk is still what the draft was read from. */
const unchanged = (a: ConfigFile, b: ConfigFile) => a.exists === b.exists && a.text === b.text;

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

/**
 * The settings in `text`, or why they cannot be saved. The rule is the
 * bridge's writer's (`JSON.parse`, an object): no comments, no trailing
 * commas, not empty. Empty text (a file not created yet) still shows as `{}`
 * in the fields, but cannot be saved as it is.
 */
type Parsed = { value?: Record<string, unknown>; error?: string; empty?: boolean };

function parseSettings(text: string): Parsed {
  if (!text.trim()) return { value: {}, empty: true, error: "The file is empty. Settings must be a JSON object, at least {}." };
  // jsonc-parser, strict, for where the problem is; JSON.parse as the final word.
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length > 0) {
    const first = errors[0];
    const before = text.slice(0, first.offset).split("\n");
    const code = printParseErrorCode(first.error);
    const why = code === "InvalidCommentToken" ? "Comments are not allowed" : code === "PropertyNameExpected" || code === "ValueExpected" ? `${describe(code)} (a trailing comma?)` : describe(code);
    return { error: `Line ${before.length}, column ${before[before.length - 1].length + 1}: ${why}.` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (failure) {
    return { error: errorText(failure) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Settings must be a JSON object." };
  return { value: value as Record<string, unknown> };
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
  const path = useConfigState((state) => state.paths[scopeKey(cwd, scope)]);
  const draft = useConfigState((state) => (path ? state.drafts[path] : undefined));
  const dirtyScopes = useConfigState((state) =>
    SCOPES.filter(({ value }) => {
      const known = state.paths[scopeKey(cwd, value)];
      return known !== undefined && isDirty(state.drafts[known]);
    })
      .map(({ value }) => value)
      .join(","),
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  /** Reads the file. A clean draft (or `discard`) takes what is on disk; a dirty one is kept. */
  const load = async (discard = false) => {
    setLoading(true);
    setError(undefined);
    try {
      const file = await request("config.read", { cwd, scope });
      useConfigState.setState((state) => {
        const current = state.drafts[file.path];
        const keep = current && isDirty(current) && !discard;
        return {
          paths: { ...state.paths, [scopeKey(cwd, scope)]: file.path },
          drafts: keep ? state.drafts : { ...state.drafts, [file.path]: { file, text: file.text } },
        };
      });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setLoading(false);
    }
  };

  // On showing a scope: a clean draft picks up edits made elsewhere (an editor pane, another tool).
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, scope]);

  const text = draft?.text ?? "";
  const parsed = useMemo(() => parseSettings(text), [text]);
  const dirty = isDirty(draft);
  const settings = parsed.value;

  const change = (jsonPath: JSONPath, value: unknown, insert = false) => {
    if (!draft || !path) return;
    try {
      setDraft(path, { ...draft, text: edit(draft.text, jsonPath, value, insert) });
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  /** Marks the draft at `path` as conflicting with `onDisk`, keeping its current text. */
  const markConflict = (target: string, onDisk: ConfigFile) =>
    useConfigState.setState((state) => {
      const current = state.drafts[target];
      return current ? { drafts: { ...state.drafts, [target]: { ...current, conflict: onDisk } } } : {};
    });

  /**
   * Writes the draft. A normal save sends the file as it was read
   * (`expected`); the bridge refuses with "conflict" when the file changed
   * since, and the Reload / Overwrite bar shows. `overwrite` writes without
   * the check. The draft may change while the write is on its way (more
   * typing, another pane sharing it): the written file becomes the baseline,
   * and the draft is clean only if its text is still what was sent.
   */
  const save = async (overwrite = false) => {
    if (!path || parsed.error) return;
    const start = useConfigState.getState().drafts[path];
    if (!start) return;
    const submitted = start.text;
    const baseline = start.file;
    setSaving(true);
    setError(undefined);
    try {
      if (!overwrite) {
        // An early, friendlier hint; the bridge's `expected` check is what guards the write.
        const onDisk = await request("config.read", { cwd, scope });
        if (!unchanged(onDisk, baseline)) {
          markConflict(path, onDisk);
          return;
        }
      }
      const file = await request("config.write", {
        cwd,
        scope,
        text: submitted,
        ...(overwrite ? {} : { expected: { exists: baseline.exists, text: baseline.text } }),
      });
      useConfigState.setState((state) => {
        const current = state.drafts[path];
        const text = current && current.text !== submitted ? current.text : file.text;
        return { drafts: { ...state.drafts, [path]: { file, text } } };
      });
    } catch (failure) {
      if (failure instanceof BridgeRequestError && failure.code === "conflict") {
        const onDisk = await request("config.read", { cwd, scope }).catch(() => undefined);
        markConflict(path, onDisk ?? { ...baseline, text: "" });
      } else setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };

  const openInEditor = async () => {
    const paneId = getSession(sessionKey)?.paneId;
    if (!draft || !paneId) return;
    try {
      // A file that does not exist yet is created ("{}"), unless something created it meanwhile.
      const onDisk = await request("config.read", { cwd, scope });
      if (!onDisk.exists) {
        const file = await request("config.write", { cwd, scope, text: "{}\n", expected: { exists: false, text: "" } });
        // The created file is the new baseline; edits not saved yet stay as they are.
        useConfigState.setState((state) => {
          const current = state.drafts[file.path];
          const text = current && isDirty(current) ? current.text : file.text;
          return { drafts: { ...state.drafts, [file.path]: { file, text } } };
        });
        openFile(file.path, { fromPaneId: paneId });
      } else openFile(onDisk.path, { fromPaneId: paneId });
    } catch (failure) {
      if (failure instanceof BridgeRequestError && failure.code === "conflict") {
        // Created meanwhile: open what is there.
        const onDisk = await request("config.read", { cwd, scope }).catch(() => undefined);
        if (onDisk) openFile(onDisk.path, { fromPaneId: paneId });
      } else setError(errorText(failure));
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
        ) : raw || (parsed.error && !parsed.empty) ? (
          <RawEditor text={text} error={parsed.error} forced={!raw} onChange={(next) => path && setDraft(path, { ...draft, text: next })} />
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
                if (!draft || !path || !to || to === from || to in env) return;
                try {
                  const value = env[from];
                  setDraft(path, { ...draft, text: edit(edit(draft.text, ["env", from], undefined), ["env", to], value) });
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
      {draft?.conflict ? (
        <div className="cp-savebar cp-savebar-conflict" role="alert">
          <span className="cp-savebar-text">This file changed since you opened it.</span>
          <Button variant="ghost" disabled={saving} onClick={() => void load(true)} title="Discard your changes and read the file again">
            Reload
          </Button>
          <Button variant="danger" busy={saving} onClick={() => void save(true)} title="Replace what is on disk with your version">
            Overwrite
          </Button>
        </div>
      ) : (
        dirty && (
          <div className="cp-savebar">
            <span className="cp-savebar-text" title={parsed.error}>
              {parsed.error ? <span className="cp-err">{parsed.empty ? "Can’t save an empty file" : "Can’t save until the JSON is valid"}</span> : "Unsaved changes"}
            </span>
            <Button variant="ghost" disabled={saving} onClick={() => void load(true)} title="Discard changes and read the file again">
              Revert
            </Button>
            <Button variant="primary" busy={saving} disabled={!!parsed.error} onClick={() => void save()}>
              Save
            </Button>
          </div>
        )
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
  return <Select label={label} className="w-[148px]" value={value} options={[{ value: "", label: "Not set" }, ...options]} onChange={onChange} />;
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
      {forced && <p className="cp-note">The file isn’t plain JSON (Claude Code’s settings allow no comments or trailing commas), so it can only be edited as text until it is.</p>}
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
      // The user's file and this folder's always show (to create them); a parent folder's only when it exists.
      const all = await request("config.memoryFiles", { cwd });
      setFiles(all.filter((file, index) => file.exists || index === 0 || file.path.startsWith(`${cwd.replace(/\/+$/, "")}/`)));
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
