import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useMemo, useState } from "react";
import { atPrompt, dismiss, leftPrompt, shownSuggestion, typed, useAiSuggestions } from "../../ai/engine";
import { runFromBlocks } from "../../terminal/blockMode";
import { globalHistory, historyEntries, loadGlobalHistory, suggestion } from "../../terminal/history";
import type { TerminalSession } from "../../terminal/session";

/** Lines the editor grows to before it scrolls. */
const MAX_ROWS = 12;

/**
 * The blocks mode command line: a textarea with history (↑/↓) and an
 * autosuggestion drawn as ghost text (⇥ or → accepts, ⏎ runs, ⇧⏎ adds a
 * line). At an empty prompt the suggestion comes from the AI provider, if
 * one is set up (src/ai/engine.ts); once the user types, the history's
 * suggestion wins unless the AI's continues what was typed. Esc dismisses
 * the AI suggestion. Shown only while the shell waits at a prompt (so it
 * remounts at every prompt).
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
  const source: "ai" | "history" | undefined =
    walk.index !== -1 || !caretAtEnd ? undefined : aiContinues ? "ai" : fromHistory ? "history" : undefined;
  const suggested = source === "ai" ? aiText : source === "history" ? fromHistory : undefined;
  const ghost = suggested?.slice(value.length) ?? "";

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

  const run = () => {
    if (!value.trim()) return;
    runFromBlocks(session, value, scope);
    setValue("");
    setWalk({ index: -1, draft: "", entries: [] });
  };

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

    if (event.key === "Enter" && plain && !event.shiftKey) {
      event.preventDefault();
      run();
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
    } else if (event.key === "Escape" && ai && (source === "ai" || ai.status === "loading" || ai.status === "error")) {
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
      }
    }
  };

  const rows = Math.min(MAX_ROWS, value.split("\n").length);

  return (
    <div className="blocks-input">
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
            if (!value) atPrompt(paneId);
          }}
          onChange={(event) => {
            setValue(event.target.value);
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
      {footer(<SuggestionStatus source={source} loading={ai?.status === "loading"} error={ai?.status === "error" ? ai.error : undefined} />)}
    </div>
  );
}

function SuggestionStatus({ source, loading, error }: { source?: "ai" | "history"; loading: boolean; error?: string }) {
  if (loading) return <span className="blocks-ai-status animate-pulse">AI…</span>;
  if (error)
    return (
      <span className="blocks-ai-status truncate text-err/80" title={error}>
        AI unavailable
      </span>
    );
  if (source === "ai") return <span className="blocks-ai-status">AI suggestion · esc dismisses</span>;
  if (source === "history") return <span className="blocks-ai-status">from history</span>;
  return null;
}
