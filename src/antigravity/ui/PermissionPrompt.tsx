import { ExternalLink, HelpCircle, ShieldAlert } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { homeDirectory } from "../../ipc/system";
import { validateInput } from "../../plugins/skills";
import { answerElicitation, answerPermission } from "../store";
import type { PendingElicitation, PendingPermission } from "../types";
import { Diff } from "./Diff";
import { relativeTo, TOOL_KIND_LABELS, toolDiffs } from "./format";

/*
 * Inline ACP permission (`session/request_permission`) and elicitation
 * (`elicitation/create`) prompts right inside the transcript.
 */

function useTakeFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const active = document.activeElement;
    const typing = (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && active.value.trim() !== "";
    if (!typing && ref.current && ref.current.closest(".ag-pane")?.contains(active ?? null) !== false) {
      ref.current.focus({ preventScroll: true });
    }
  }, []);
  return ref;
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ag-kbd">{children}</kbd>;
}

const rec = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function PermissionPrompt({
  sessionKey,
  request,
  cwd,
}: {
  sessionKey: string;
  request: PendingPermission;
  cwd: string;
}) {
  const focusRef = useTakeFocus<HTMLDivElement>();
  const home = homeDirectory();
  const tc = request.toolCall;
  const allowOnce = request.options.find((o) => o.kind === "allow_once");
  const rejectOpt = request.options.find((o) => o.kind === "reject_once") ?? request.options.find((o) => o.kind === "reject_always");

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void answerPermission(sessionKey, request.rpcId, rejectOpt ? rejectOpt.optionId : "cancelled");
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.target === event.currentTarget) {
      event.preventDefault();
      if (allowOnce) void answerPermission(sessionKey, request.rpcId, allowOnce.optionId);
    }
  };

  const diffs = tc.content ? toolDiffs(tc.content) : [];
  const input = rec(tc.rawInput);
  const command = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
  const locPath = tc.locations?.[0]?.path;

  let preview: ReactNode = null;
  if (command) {
    preview = <pre className="ag-pre is-command">{command}</pre>;
  } else if (diffs.length > 0) {
    preview = (
      <Diff
        lines={diffs[0].lines}
        limit={24}
        header={{ label: relativeTo(diffs[0].path, cwd, home), added: diffs[0].added, removed: diffs[0].removed }}
      />
    );
  } else if (Object.keys(input).length > 0) {
    preview = <pre className="ag-pre">{JSON.stringify(input, null, 2)}</pre>;
  }

  const kindLabel = tc.kind ? TOOL_KIND_LABELS[tc.kind] : "Tool";

  return (
    <div
      ref={focusRef}
      className="ag-perm"
      tabIndex={-1}
      role="group"
      aria-label={`Permission: ${tc.title ?? kindLabel}`}
      onKeyDown={onKeyDown}
    >
      <div className="ag-perm-title">
        <ShieldAlert size={12} className="text-accent flex-none" />
        <span>
          <strong>{tc.title || kindLabel}</strong>
          {locPath && !tc.title?.includes(relativeTo(locPath, cwd, home)) && (
            <span className="ag-mono text-fg-dim"> {relativeTo(locPath, cwd, home)}</span>
          )}
        </span>
      </div>
      {preview && <div className="ag-perm-preview">{preview}</div>}
      <div className="ag-perm-actions">
        {request.options.map((opt) => {
          const isPrimary = allowOnce ? opt.optionId === allowOnce.optionId : opt.kind === "allow_once";
          const isReject = opt.kind === "reject_once" || opt.kind === "reject_always";
          const isEscapeTarget = rejectOpt ? opt.optionId === rejectOpt.optionId : false;
          return (
            <button
              key={opt.optionId}
              type="button"
              className={`ag-button${isPrimary ? " is-primary" : ""}${isReject ? " is-reject" : ""}`}
              onClick={() => void answerPermission(sessionKey, request.rpcId, opt.optionId)}
            >
              {opt.name}
              {isPrimary && <Kbd>⏎</Kbd>}
              {isEscapeTarget && <Kbd>esc</Kbd>}
            </button>
          );
        })}
        {!rejectOpt && (
          <button
            type="button"
            className="ag-button"
            onClick={() => void answerPermission(sessionKey, request.rpcId, "cancelled")}
          >
            Cancel <Kbd>esc</Kbd>
          </button>
        )}
      </div>
    </div>
  );
}

/** Allows the oldest permission prompt with ⏎ from an empty composer. */
export function allowPermissionByEnter(sessionKey: string, request: PendingPermission): boolean {
  const allowOnce = request.options.find((o) => o.kind === "allow_once");
  if (!allowOnce) return false;
  void answerPermission(sessionKey, request.rpcId, allowOnce.optionId);
  return true;
}

type SchemaProp = {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  items?: { type?: string; enum?: unknown[] };
  default?: unknown;
};

function UrlElicitation({
  sessionKey,
  item,
  url,
  message,
  focusRef,
}: {
  sessionKey: string;
  item: PendingElicitation;
  url: string;
  message: string;
  focusRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [openError, setOpenError] = useState<string | undefined>(undefined);
  const openUrl = async () => {
    setOpenError(undefined);
    try {
      if (isTauri()) {
        const { openUrl: openExternal } = await import("@tauri-apps/plugin-opener");
        await openExternal(url);
      } else {
        const win = window.open(url, "_blank", "noopener,noreferrer");
        if (!win) throw new Error("Pop-up was blocked by the browser.");
      }
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Could not open link.");
      return;
    }
    void answerElicitation(sessionKey, item.rpcId, { action: "accept" });
  };
  return (
    <div ref={focusRef} className="ag-perm" tabIndex={-1} role="group" aria-label="Antigravity request">
      <div className="ag-perm-title">
        <HelpCircle size={12} className="text-accent flex-none" />
        <span>{message}</span>
      </div>
      <div className="ag-perm-url ag-mono">{url}</div>
      {openError && <div className="ag-notice-text text-err">{openError}</div>}
      <div className="ag-perm-actions">
        <button type="button" className="ag-button is-primary" onClick={() => void openUrl()}>
          Open link <ExternalLink size={10} />
        </button>
        <button type="button" className="ag-button" onClick={() => void answerElicitation(sessionKey, item.rpcId, { action: "decline" })}>
          Decline
        </button>
      </div>
    </div>
  );
}

export function ElicitationPrompt({
  sessionKey,
  item,
}: {
  sessionKey: string;
  item: PendingElicitation;
}) {
  const focusRef = useTakeFocus<HTMLDivElement>();
  const req = item.request;

  if (req.mode === "url") {
    const url = typeof req.url === "string" ? req.url : String(req.url ?? "");
    return <UrlElicitation sessionKey={sessionKey} item={item} url={url} message={req.message} focusRef={focusRef} />;
  }

  return <FormElicitation sessionKey={sessionKey} item={item} focusRef={focusRef} />;
}

type FormFieldValue = string | boolean | string[];

function FormElicitation({
  sessionKey,
  item,
  focusRef,
}: {
  sessionKey: string;
  item: PendingElicitation;
  focusRef: React.RefObject<HTMLDivElement | null>;
}) {
  const req = item.request;
  const schema = req.mode === "form" ? rec(req.requestedSchema) : {};
  const properties = rec(schema.properties) as Record<string, SchemaProp>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const keys = Object.keys(properties);

  const [values, setValues] = useState<Record<string, FormFieldValue>>(() => {
    const init: Record<string, FormFieldValue> = {};
    for (const k of keys) {
      const p = properties[k];
      if (p.type === "array") {
        init[k] = Array.isArray(p.default) ? p.default.map(String) : [];
      } else if (p.type === "boolean") {
        init[k] = typeof p.default === "boolean" ? p.default : false;
      } else if (p.default !== undefined && (typeof p.default === "string" || typeof p.default === "number")) {
        init[k] = String(p.default);
      } else if (Array.isArray(p.enum) && p.enum.length > 0 && required.has(k)) {
        init[k] = String(p.enum[0]);
      } else {
        init[k] = "";
      }
    }
    return init;
  });
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const complete = [...required].every((k) => {
    const v = values[k];
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "boolean") return true;
    return v !== undefined && v.trim() !== "";
  });

  const submit = () => {
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const k of keys) {
      const p = properties[k];
      const v = values[k];
      if (p.type === "boolean") {
        content[k] = Boolean(v);
      } else if (p.type === "array") {
        const list = Array.isArray(v)
          ? v
          : typeof v === "string"
            ? v
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [];
        if (list.length > 0 || required.has(k)) content[k] = list;
      } else if (p.type === "number" || p.type === "integer") {
        const raw = typeof v === "string" ? v.trim() : "";
        if (raw === "") continue; // Omit blank optional numbers rather than coercing "" to 0.
        const num = Number(raw);
        if (!Number.isFinite(num) || (p.type === "integer" && !Number.isInteger(num))) {
          setValidationErrors([`${p.title ?? k}: must be a valid ${p.type}`]);
          return;
        }
        content[k] = num;
      } else if (typeof v === "string" && v !== "") {
        content[k] = v;
      }
    }
    const problems = Object.keys(schema).length > 0 ? validateInput(schema, content) : [];
    if (problems.length > 0) {
      setValidationErrors(problems);
      return;
    }
    setValidationErrors([]);
    void answerElicitation(sessionKey, item.rpcId, { action: "accept", content });
  };

  const toggleMulti = (key: string, choice: string) => {
    setValues((cur) => {
      const arr = Array.isArray(cur[key]) ? cur[key] : [];
      const next = arr.includes(choice) ? arr.filter((x) => x !== choice) : [...arr, choice];
      return { ...cur, [key]: next };
    });
    setValidationErrors([]);
  };

  return (
    <div
      ref={focusRef}
      className="ag-perm"
      tabIndex={-1}
      role="group"
      aria-label="Antigravity question"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          void answerElicitation(sessionKey, item.rpcId, { action: "cancel" });
        } else if (e.key === "Enter" && !e.shiftKey && complete && e.target instanceof HTMLInputElement) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="ag-perm-title">
        <HelpCircle size={12} className="text-accent flex-none" />
        <span>{req.message}</span>
      </div>
      <div className="ag-form-fields">
        {keys.map((k) => {
          const prop = properties[k];
          const label = prop.title ?? k;
          if (prop.type === "boolean") {
            return (
              <label key={k} className="ag-form-check">
                <input
                  type="checkbox"
                  checked={Boolean(values[k])}
                  onChange={(e) => {
                    setValues((cur) => ({ ...cur, [k]: e.target.checked }));
                    setValidationErrors([]);
                  }}
                />
                <span>{label}</span>
                {prop.description && <span className="ag-dim"> — {prop.description}</span>}
              </label>
            );
          }
          if (prop.type === "array" && Array.isArray(prop.items?.enum) && prop.items.enum.length > 0) {
            const chosen = Array.isArray(values[k]) ? values[k] : [];
            return (
              <div key={k} className="ag-form-field">
                <label className="ag-form-label">{label}</label>
                <div className="ag-form-pills">
                  {prop.items.enum.map((opt) => {
                    const s = String(opt);
                    const active = chosen.includes(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={active}
                        className={`ag-button${active ? " is-primary" : ""}`}
                        onClick={() => toggleMulti(k, s)}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          }
          if (Array.isArray(prop.enum) && prop.enum.length > 0) {
            return (
              <div key={k} className="ag-form-field">
                <label className="ag-form-label">{label}</label>
                <div className="ag-form-pills">
                  {prop.enum.map((opt) => {
                    const s = String(opt);
                    const active = String(values[k]) === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        className={`ag-button${active ? " is-primary" : ""}`}
                        onClick={() => {
                          setValues((cur) => ({ ...cur, [k]: s }));
                          setValidationErrors([]);
                        }}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          }
          const displayVal = Array.isArray(values[k]) ? values[k].join(", ") : String(values[k] ?? "");
          return (
            <div key={k} className="ag-form-field">
              <label className="ag-form-label">{label}</label>
              <input
                type={prop.type === "number" || prop.type === "integer" ? "number" : "text"}
                className="ag-perm-note"
                value={displayVal}
                placeholder={prop.type === "array" ? (prop.description ?? "Comma-separated values") : (prop.description ?? "")}
                onChange={(e) => {
                  const raw = e.target.value;
                  setValues((cur) => ({ ...cur, [k]: prop.type === "array" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : raw }));
                  setValidationErrors([]);
                }}
              />
            </div>
          );
        })}
      </div>
      {validationErrors.length > 0 && (
        <div className="ag-notice-text text-err">{validationErrors.join(" · ")}</div>
      )}
      <div className="ag-perm-actions">
        <button type="button" className="ag-button is-primary" disabled={!complete} onClick={submit}>
          Submit <Kbd>⏎</Kbd>
        </button>
        <button type="button" className="ag-button" onClick={() => void answerElicitation(sessionKey, item.rpcId, { action: "decline" })}>
          Decline <Kbd>esc</Kbd>
        </button>
      </div>
    </div>
  );
}
