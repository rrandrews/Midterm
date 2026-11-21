import { CornerDownLeft, ShieldAlert } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Markdown } from "../../components/ui/Markdown";
import { homeDirectory } from "../../ipc/system";
import type { PermissionRequest, PermissionResult, PermissionUpdate } from "../protocol";
import { answerPermission, updateSession } from "../store";
import { Diff } from "./Diff";
import { MODE_LABELS, relativeTo, toolDiff, toolLabel } from "./format";

/*
 * A permission prompt, in the transcript where the tool would run: what
 * will run, then Allow (⏎), one button per "always allow" suggestion, and
 * Deny (Esc) with an optional note for Claude. ExitPlanMode asks to approve
 * the plan; AskUserQuestion shows its options as choices. With
 * `defaultToNo`, ⏎ denies and Allow takes a click.
 */

const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

const rec = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const DESTINATIONS: Record<string, string> = {
  localSettings: "in this project, for you",
  projectSettings: "in this project",
  userSettings: "everywhere",
  session: "for this session",
  cliArg: "for this session",
};

/** "Always allow `Bash(npm test:*)` in this project". */
function suggestionLabel(update: PermissionUpdate): ReactNode {
  const where = <span className="cc-perm-where">{DESTINATIONS[update.destination] ?? ""}</span>;
  switch (update.type) {
    case "addRules":
    case "replaceRules":
      return (
        <>
          Always {update.behavior}{" "}
          {update.rules.map((rule, index) => (
            <code key={index}>{rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName}</code>
          ))}{" "}
          {where}
        </>
      );
    case "setMode":
      return (
        <>
          Allow and switch to {MODE_LABELS[update.mode].toLowerCase()} {where}
        </>
      );
    case "addDirectories":
      return (
        <>
          Allow access to <code>{update.directories.join(", ")}</code> {where}
        </>
      );
    default:
      return "Allow and remember";
  }
}

/** Focuses the prompt when it appears, unless the user is typing somewhere. */
function useTakeFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const active = document.activeElement;
    const typing = (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && active.value.trim() !== "";
    if (!typing && ref.current && ref.current.closest(".cc-pane")?.contains(active ?? null) !== false) ref.current.focus({ preventScroll: true });
  }, []);
  return ref;
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="cc-kbd">{children}</kbd>;
}

function Shell({ request, title, children, onKeyDown, focusRef }: { request: PermissionRequest; title: ReactNode; children: ReactNode; onKeyDown: (event: KeyboardEvent) => void; focusRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={focusRef} className="cc-perm" tabIndex={-1} role="group" aria-label={`Permission: ${request.toolName}`} onKeyDown={onKeyDown}>
      <div className="cc-perm-title">
        <ShieldAlert size={12} className="text-accent" />
        {title}
      </div>
      {children}
    </div>
  );
}

function ToolPrompt({ sessionKey, request, cwd }: { sessionKey: string; request: PermissionRequest; cwd: string }) {
  const [note, setNote] = useState("");
  const focusRef = useTakeFocus<HTMLDivElement>();
  const input = request.input;
  const home = homeDirectory();
  const allow = (updatedPermissions?: PermissionUpdate[]) => {
    void answerPermission(sessionKey, request.requestId, { behavior: "allow", updatedInput: input, updatedPermissions });
  };
  const deny = () => {
    const result: PermissionResult = note.trim()
      ? { behavior: "deny", message: `The user doesn't want to proceed with this tool use and said: ${note.trim()}` }
      : { behavior: "deny", message: REJECTED, interrupt: true };
    void answerPermission(sessionKey, request.requestId, result);
  };
  const noFirst = request.defaultToNo === true;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      deny();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (event.target === event.currentTarget || event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      if (noFirst || note.trim()) deny();
      else allow();
    }
  };

  const diff = ["Edit", "MultiEdit", "Write"].includes(request.toolName) ? toolDiff({ name: request.toolName, input, structured: undefined }) : undefined;
  const command = request.toolName === "Bash" ? text(input.command) : "";
  const path = text(input.file_path) || text(input.notebook_path);
  const suggestions = request.suppressAlwaysAllowRule ? [] : (request.suggestions ?? []);

  let preview: ReactNode;
  if (command) preview = <pre className="cc-pre is-command">{command}</pre>;
  else if (diff?.length) preview = <Diff lines={diff} limit={24} />;
  else if (Object.keys(input).length) preview = <pre className="cc-pre">{JSON.stringify(input, null, 2)}</pre>;

  return (
    <Shell
      request={request}
      focusRef={focusRef}
      onKeyDown={onKeyDown}
      title={
        <>
          <span>
            Allow <strong>{request.displayName ?? toolLabel(request.toolName)}</strong>
            {path ? <span className="cc-mono"> {relativeTo(path, cwd, home)}</span> : null}?
          </span>
          {(request.description || text(input.description)) && <span className="cc-perm-desc">{request.description || text(input.description)}</span>}
        </>
      }
    >
      {preview && <div className="cc-perm-preview">{preview}</div>}
      {(request.decisionReason || request.blockedPath) && (
        <div className="cc-perm-reason">
          {request.decisionReason}
          {request.blockedPath ? ` ${request.blockedPath}` : ""}
        </div>
      )}
      <div className="cc-perm-actions">
        <button type="button" className={`cc-button${noFirst ? "" : " is-primary"}`} onClick={() => allow()}>
          Allow {!noFirst && <Kbd>⏎</Kbd>}
        </button>
        {suggestions.map((update, index) => (
          <button key={index} type="button" className="cc-button" onClick={() => allow([update])}>
            {suggestionLabel(update)}
          </button>
        ))}
        <button type="button" className={`cc-button${noFirst ? " is-primary" : ""}`} onClick={deny}>
          Deny {noFirst ? <Kbd>⏎</Kbd> : <Kbd>esc</Kbd>}
        </button>
      </div>
      <input className="cc-perm-note" value={note} placeholder="Or tell Claude what to do instead…" aria-label="Tell Claude what to do instead" onChange={(event) => setNote(event.target.value)} />
    </Shell>
  );
}

function PlanPrompt({ sessionKey, request }: { sessionKey: string; request: PermissionRequest }) {
  const [note, setNote] = useState("");
  const focusRef = useTakeFocus<HTMLDivElement>();
  const plan = text(request.input.plan);
  const approve = (mode: "acceptEdits" | "default") => {
    updateSession(sessionKey, { permissionMode: mode });
    void answerPermission(sessionKey, request.requestId, {
      behavior: "allow",
      updatedInput: request.input,
      updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
    });
  };
  const keepPlanning = () =>
    void answerPermission(sessionKey, request.requestId, {
      behavior: "deny",
      message: note.trim() ? `The user wants to keep planning: ${note.trim()}` : "The user wants to keep planning. Ask what to change before trying again.",
    });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      keepPlanning();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement && note.trim()) {
      event.preventDefault();
      keepPlanning();
    }
  };
  return (
    <Shell request={request} focusRef={focusRef} onKeyDown={onKeyDown} title={<span>Ready to code? Here is Claude's plan:</span>}>
      <div className="cc-perm-plan">
        <Markdown text={plan || "(no plan text)"} compact />
      </div>
      <div className="cc-perm-actions">
        <button type="button" className="cc-button is-primary" onClick={() => approve("acceptEdits")}>
          Approve and auto-accept edits
        </button>
        <button type="button" className="cc-button" onClick={() => approve("default")}>
          Approve
        </button>
        <button type="button" className="cc-button" onClick={keepPlanning}>
          Keep planning <Kbd>esc</Kbd>
        </button>
      </div>
      <input className="cc-perm-note" value={note} placeholder="What should change in the plan?" aria-label="What should change in the plan" onChange={(event) => setNote(event.target.value)} />
    </Shell>
  );
}

type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };

function QuestionPrompt({ sessionKey, request }: { sessionKey: string; request: PermissionRequest }) {
  const questions: Question[] = (Array.isArray(request.input.questions) ? request.input.questions : []).map((raw) => {
    const question = rec(raw);
    return {
      question: text(question.question),
      header: text(question.header),
      multiSelect: question.multiSelect === true,
      options: (Array.isArray(question.options) ? question.options : []).map((option) => ({ label: text(rec(option).label), description: text(rec(option).description) })),
    };
  });
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const focusRef = useTakeFocus<HTMLDivElement>();
  const answerOf = (question: Question) => [...(picked[question.question] ?? []), ...(other[question.question]?.trim() ? [other[question.question].trim()] : [])];
  const complete = questions.every((question) => answerOf(question).length > 0);

  const toggle = (question: Question, label: string) => {
    setPicked((current) => {
      const chosen = current[question.question] ?? [];
      const next = question.multiSelect ? (chosen.includes(label) ? chosen.filter((item) => item !== label) : [...chosen, label]) : [label];
      return { ...current, [question.question]: next };
    });
    // One answer per single-choice question: a preset replaces what was typed under Other.
    if (!question.multiSelect) setOther((current) => ({ ...current, [question.question]: "" }));
  };
  const submit = () => {
    if (!complete) return;
    const answers = Object.fromEntries(questions.map((question) => [question.question, answerOf(question).join(", ")]));
    void answerPermission(sessionKey, request.requestId, { behavior: "allow", updatedInput: { ...request.input, answers } });
  };
  const skip = () => void answerPermission(sessionKey, request.requestId, { behavior: "deny", message: "The user declined to answer the questions." });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      skip();
    } else if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      complete &&
      // From an Other field or the prompt itself; a focused option or button keeps its own Enter.
      (event.target === event.currentTarget || event.target instanceof HTMLInputElement)
    ) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <Shell request={request} focusRef={focusRef} onKeyDown={onKeyDown} title={<span>Claude has {questions.length === 1 ? "a question" : `${questions.length} questions`}</span>}>
      <div className="cc-questions">
        {questions.map((question) => {
          const chosen = picked[question.question] ?? [];
          return (
            <fieldset key={question.question} className="cc-question">
              <legend>
                {question.header && <span className="cc-badge">{question.header}</span>}
                <span className="text-fg-soft">{question.question}</span>
                {question.multiSelect && <span className="cc-faint">Pick any</span>}
              </legend>
              <div className="cc-options" role={question.multiSelect ? "group" : "radiogroup"}>
                {question.options.map((option) => {
                  const on = chosen.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      role={question.multiSelect ? "checkbox" : "radio"}
                      aria-checked={on}
                      className={`cc-option${on ? " is-on" : ""}${question.multiSelect ? " is-multi" : ""}`}
                      onClick={() => toggle(question, option.label)}
                    >
                      <span className="cc-option-mark" aria-hidden="true" />
                      <span className="cc-option-text">
                        <span className="cc-option-label">{option.label}</span>
                        {option.description && <span className="cc-option-desc">{option.description}</span>}
                      </span>
                    </button>
                  );
                })}
                <input
                  className="cc-perm-note"
                  value={other[question.question] ?? ""}
                  placeholder="Other…"
                  aria-label={`Other answer: ${question.question}`}
                  onChange={(event) => {
                    const value = event.target.value;
                    setOther((current) => ({ ...current, [question.question]: value }));
                    if (!question.multiSelect && value.trim()) setPicked((current) => ({ ...current, [question.question]: [] }));
                  }}
                />
              </div>
            </fieldset>
          );
        })}
      </div>
      <div className="cc-perm-actions">
        <button type="button" className="cc-button is-primary" disabled={!complete} onClick={submit}>
          Submit {complete && <Kbd><CornerDownLeft size={9} /></Kbd>}
        </button>
        <button type="button" className="cc-button" onClick={skip}>
          Skip <Kbd>esc</Kbd>
        </button>
      </div>
    </Shell>
  );
}

export function PermissionPrompt({ sessionKey, request, cwd }: { sessionKey: string; request: PermissionRequest; cwd: string }) {
  if (request.toolName === "ExitPlanMode") return <PlanPrompt sessionKey={sessionKey} request={request} />;
  if (request.toolName === "AskUserQuestion") return <QuestionPrompt sessionKey={sessionKey} request={request} />;
  return <ToolPrompt sessionKey={sessionKey} request={request} cwd={cwd} />;
}

/** What ⏎ in an empty composer does for the oldest prompt: allow it, unless it must not be allowed by one key. */
export function allowByEnter(sessionKey: string, request: PermissionRequest): boolean {
  if (request.defaultToNo || request.toolName === "ExitPlanMode" || request.toolName === "AskUserQuestion") return false;
  void answerPermission(sessionKey, request.requestId, { behavior: "allow", updatedInput: request.input });
  return true;
}
