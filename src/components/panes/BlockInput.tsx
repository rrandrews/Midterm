import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { atPrompt, dismiss, leftPrompt, shownSuggestion, typed, useAiSuggestions } from "../../ai/engine";
import {
  bindEditor,
  cancelEditorRequest,
  clearEditorRequest,
  failEditorRequest,
  markApplied,
  pendingText,
  startEditorRequest,
  useEditorRequests,
} from "../../ai/editorRequests";
import { type ParsedSlash, parseSlash, slashCompletion, slashHandler, writeCommand } from "../../ai/slash";
import { runFromBlocks } from "../../terminal/blockMode";
import { applyEdit, emptyKill, isKillKey, type KillBuffer, lineEdit } from "../../terminal/lineEdit";
import { globalHistory, historyEntries, loadGlobalHistory, suggestion } from "../../terminal/history";
import type { TerminalSession } from "../../terminal/session";

/** Lines the editor grows to before it scrolls. */
const MAX_ROWS = 12;

/**
 * The blocks mode command line: a textarea with history (↑/↓) and an
 * autosuggestion drawn as ghost text (⇥ or → accepts, ⏎ runs, ⇧⏎ adds a
 * line). At an empty prompt the suggestion is predicted from the command
 * log, or else comes from the AI provider if one is set up (src/ai/engine.ts); once the user types, the history's
 * suggestion wins unless the AI's continues what was typed. Esc dismisses
 * the AI suggestion. A line starting with a registered slash command
 * (src/ai/slash.ts) is handled here instead of going to the shell: `/cmd
 * <task>` asks the model for a command and puts it in the editor, below the
 * request, ready to edit or run; `/agent <task>` hands the task to the
 * agent, whose card (src/ai/agent/) the pane host shows over the pane.
 * Requests like `/cmd` and a block's Fix
 * live in src/ai/editorRequests.ts; this shows them and applies their
 * answers. Shown only while the shell waits at a prompt (so it remounts at
 * every prompt).
 */
export function BlockInput({
  session,
  scope,
  inputRef,
  footer,
}: {
  session: TerminalSession;
  /** Whose prompt this editor is for (see `scopeOf`): nothing is sent to another shell's. */
  scope: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The line below the editor; `status` says where the suggestion comes from, or that one is loading or failed. */
  footer: (status: ReactNode) => ReactNode;
}) {
  const paneId = session.paneId;
  const [value, setValue] = useState("");
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  /** Position in `walk.entries` while walking the history with ↑/↓; -1 when not. */
  const [walk, setWalk] = useState<{ index: number; draft: string; entries: string[] }>({
    index: -1,
    draft: "",
    entries: [],
  });
  const [historyLoaded, setHistoryLoaded] = useState(false);
  /** The last request for the editor (`/cmd`, Fix) and how it went; shown above the editor. */
  const request = useEditorRequests((state) => state[paneId]);
  const busy = request?.status === "loading";
  useEffect(() => () => void cancelEditorRequest(paneId), [paneId]);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(
    () => bindEditor(paneId, { draft: () => valueRef.current, focus: () => inputRef.current?.focus() }),
    [paneId, inputRef],
  );

  useEffect(() => {
    let live = true;
    void loadGlobalHistory().then(() => live && setHistoryLoaded(true));
    return () => {
      live = false;
    };
  }, []);

  // At a nested shell's prompt (over ssh) only its own commands apply: the
  // saved history is this machine's.
  const scopeCommands = session.blocks.commandsFor(scope);
  const entries = useMemo(
    () => historyEntries(session.blocks.commandsFor(scope), scope === "" ? globalHistory() : []),
    // The lists only change between commands (and when the saved history loads).
    [session, historyLoaded, scope, scopeCommands.length],
  );
  // The AI's suggestion: asked for at an empty prompt, dropped when the prompt goes.
  useEffect(() => {
    atPrompt(paneId);
    return () => leftPrompt(paneId);
  }, [paneId]);
  const ai = shownSuggestion(useAiSuggestions((state) => state[paneId]), session);
  const aiText = ai?.status === "ready" ? ai.text : undefined;
  const aiContinues = aiText !== undefined && aiText.length > value.length && aiText.startsWith(value);

  const fromHistory = walk.index === -1 && caretAtEnd ? suggestion(entries, value) : undefined;
  const slashHint = walk.index === -1 && caretAtEnd ? slashCompletion(value) : undefined;
  const source: "slash" | "ai" | "local" | "history" | undefined =
    walk.index !== -1 || !caretAtEnd || busy
      ? undefined
      : slashHint
        ? "slash"
        : aiContinues
        ? ai?.source === "local"
          ? "local"
          : "ai"
        : fromHistory
          ? "history"
          : undefined;
  const suggested =
    source === "slash"
      ? `/${slashHint?.name} `
      : source === "ai" || source === "local"
        ? aiText
        : source === "history"
          ? fromHistory
          : undefined;
  // A slash command's ghost also shows what it takes (`/cmd <what to do>`); ⇥ accepts only the name.
  const ghost = source === "slash" && slashHint ? slashHint.usage.slice(value.length) : (suggested?.slice(value.length) ?? "");

  const set = (next: string) => {
    setValue(next);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.selectionStart = input.selectionEnd = next.length;
      setCaretAtEnd(true);
    });
  };

  const accept = () => {
    if (suggested) set(suggested);
  };

  // A request started (here or by a block's Fix): the editor waits empty.
  const loadingId = busy ? request.id : undefined;
  useEffect(() => {
    if (loadingId !== undefined) setValue("");
  }, [loadingId]);
  // A request settled: its command goes in the editor, or on an error what was there before.
  const pending = pendingText(request);
  useEffect(() => {
    if (!request || pending === undefined) return;
    markApplied(paneId, request.id);
    set(pending);
    // `set` is recreated every render; the request is what matters.
  }, [paneId, request, pending]);

  /** Runs a slash command line: `/cmd` stays shown above the editor with its result; others go to their handler (`/agent` opens the pane's agent card). */
  const runSlash = (line: string, { command, args }: ParsedSlash) => {
    if (command.name !== "cmd") {
      const handler = slashHandler(command.name);
      const problem = handler ? handler(paneId, args) : `/${command.name} is not available`;
      if (problem) failEditorRequest(paneId, { line, restore: line, message: problem });
      else setValue("");
      return;
    }
    if (!args) {
      failEditorRequest(paneId, { line, restore: line, message: "Say what the command should do: /cmd <what to do>" });
      return;
    }
    // On an error the line goes back in the editor, so ⏎ tries again.
    startEditorRequest(paneId, { line, restore: line, busy: "writing a command… esc cancels", run: () => writeCommand(paneId, args) });
    setValue("");
  };

  const cancelRequest = () => {
    set(cancelEditorRequest(paneId) ?? "");
  };

  const run = () => {
    if (!value.trim()) return;
    const parsed = parseSlash(value);
    if (parsed) {
      runSlash(value.trim(), parsed);
      setWalk({ index: -1, draft: "", entries: [] });
      return;
    }
    runFromBlocks(session, value, scope);
    setValue("");
    setWalk({ index: -1, draft: "", entries: [] });
  };

  const killRef = useRef<KillBuffer>(emptyKill);

  const step = (direction: 1 | -1) => {
    const list = walk.index === -1 ? entries : walk.entries;
    const index = walk.index + direction;
    if (index < -1 || index >= list.length) return false;
    const draft = walk.index === -1 ? value : walk.draft;
    setWalk({ index, draft, entries: list });
    set(index === -1 ? draft : list[index]);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const input = event.currentTarget;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const { selectionStart, selectionEnd } = input;
    const collapsed = selectionStart === selectionEnd;

    // Any key but a kill ends a run of kills.
    if (!["Control", "Shift", "Alt", "Meta"].includes(event.key) && !(event.ctrlKey && isKillKey(event.key.toLowerCase()))) {
      killRef.current = { ...killRef.current, chained: false };
    }
    if (busy) {
      // Nothing reaches the editor or the shell (⌃D would send EOF) until the request settles.
      if (event.key === "Escape" || (event.ctrlKey && event.key.toLowerCase() === "c")) {
        event.preventDefault();
        cancelRequest();
      } else if (event.key === "Enter" || event.key === "Tab" || event.ctrlKey || event.metaKey) {
        if (!event.metaKey) event.preventDefault();
      }
      return;
    }
    if (event.key === "Enter" && plain && !event.shiftKey) {
      event.preventDefault();
      // A held ⏎ must not run what /cmd just put in the editor.
      if (!event.repeat) run();
    } else if (event.key === "Tab" && plain && !event.shiftKey) {
      // There is no completion here; Tab never leaves the editor.
      event.preventDefault();
      accept();
    } else if (event.key === "ArrowRight" && plain && !event.shiftKey && suggested && collapsed && selectionEnd === value.length) {
      event.preventDefault();
      accept();
    } else if (event.key === "ArrowUp" && plain && !event.shiftKey && collapsed && !value.slice(0, selectionStart).includes("\n")) {
      if (step(1)) event.preventDefault();
    } else if (event.key === "ArrowDown" && plain && !event.shiftKey && collapsed && !value.slice(selectionEnd).includes("\n")) {
      if (step(-1)) event.preventDefault();
    } else if (event.key === "Escape" && walk.index !== -1) {
      event.preventDefault();
      set(walk.draft);
      setWalk({ index: -1, draft: "", entries: [] });
    } else if (event.key === "Escape" && ai && (source === "ai" || source === "local" || ai.status === "loading" || ai.status === "error")) {
      event.preventDefault();
      dismiss(paneId);
    } else if (event.ctrlKey && !event.metaKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "c") {
        // As at a shell prompt: abandon the line.
        event.preventDefault();
        setValue("");
        setWalk({ index: -1, draft: "", entries: [] });
      } else if (key === "d" && !value) {
        event.preventDefault();
        session.input("\x04");
      } else if (key === "l") {
        event.preventDefault();
        session.clear();
      } else if (key === "p" || key === "n") {
        // Like ↑/↓: only from the first/last line, else the caret moves a line natively.
        const edge = key === "p" ? !value.slice(0, selectionStart).includes("\n") : !value.slice(selectionEnd).includes("\n");
        if (collapsed && edge && step(key === "p" ? 1 : -1)) event.preventDefault();
      } else if (key === "e" && suggested && collapsed && selectionEnd === value.length) {
        event.preventDefault();
        accept();
      } else if (isKillKey(key) || key === "y") {
        event.preventDefault();
        const result = lineEdit(key, value, selectionStart, selectionEnd, killRef.current);
        if (result) {
          killRef.current = result.kill;
          applyEdit(input, result.edit);
        }
      }
    }
  };

  const rows = Math.min(MAX_ROWS, value.split("\n").length);

  return (
    <div className="blocks-input">
      {request && (
        <div className="blocks-slash">
          <span className="blocks-slash-line">{request.line}</span>
          {busy && <span className="animate-pulse text-fg-faint">{request.busy}</span>}
          {request.status === "error" && <span className="truncate text-err/80">{request.message}</span>}
        </div>
      )}
      <div className="blocks-input-field">
        <div className="blocks-input-ghost" aria-hidden="true">
          <span className="invisible">{value}</span>
          <span className="text-fg-faint">{ghost}</span>
        </div>
        <textarea
          ref={inputRef}
          className="blocks-input-text"
          value={value}
          rows={rows}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-label="Command"
          onFocus={() => {
            if (!value && !busy) atPrompt(paneId);
          }}
          onChange={(event) => {
            if (busy) return;
            setValue(event.target.value);
            if (!event.target.value && request) clearEditorRequest(paneId);
            if (event.target.value) typed(paneId);
            else atPrompt(paneId);
            setCaretAtEnd(event.target.selectionEnd === event.target.value.length);
            if (walk.index !== -1) setWalk({ index: -1, draft: "", entries: [] });
          }}
          onSelect={(event) => {
            const input = event.currentTarget;
            setCaretAtEnd(input.selectionStart === input.selectionEnd && input.selectionEnd === input.value.length);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {footer(
        <SuggestionStatus
          source={source}
          slashDescription={slashHint?.description}
          loading={ai?.status === "loading" || busy}
          error={ai?.status === "error" ? ai.error : undefined}
        />,
      )}
    </div>
  );
}

function SuggestionStatus({
  source,
  slashDescription,
  loading,
  error,
}: {
  source?: "slash" | "ai" | "local" | "history";
  slashDescription?: string;
  loading: boolean;
  error?: string;
}) {
  if (source === "slash") return <span className="blocks-ai-status">{slashDescription}</span>;
  if (loading) return <span className="blocks-ai-status animate-pulse">AI…</span>;
  if (error)
    return (
      <span className="blocks-ai-status truncate text-err/80" title={error}>
        AI unavailable
      </span>
    );
  if (source === "ai") return <span className="blocks-ai-status">AI suggestion · esc dismisses</span>;
  if (source === "local") return <span className="blocks-ai-status">predicted from history · esc dismisses</span>;
  if (source === "history") return <span className="blocks-ai-status">from history</span>;
  return null;
}
