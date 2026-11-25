import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { parseSlash, slashCompletesPath, slashCompletion } from "../../ai/slash";
import { homeDirectory } from "../../ipc/system";
import {
  applyCandidate,
  applyPrefix,
  type Candidate,
  type CompletionContext,
  completionContext,
  type Edit,
  filterCandidates,
} from "../../terminal/completion";
import { findCandidates } from "../../terminal/completionSource";
import type { TerminalSession } from "../../terminal/session";
import { CompletionList, MAX_SHOWN } from "./CompletionList";

/** The list shown when ⇥ finds several matches and their common prefix adds nothing. */
type ListState = {
  context: CompletionContext;
  /** What the list was opened with: typing may narrow it, not widen it. */
  all: Candidate[];
  matches: Candidate[];
  selected: number;
};

/**
 * ⇥ completion in the blocks input editor (see `src/terminal/completion.ts`).
 * `onKeyDown` runs before the editor's own keys and returns whether it took
 * the key; `onEdit` follows typing while the list is open; `list` is the
 * element to show above the editor. `apply` puts a completed line in the
 * editor with its caret; `enabled` is false at a nested shell's prompt
 * (its files are on another machine).
 */
export function useCompletion({
  session,
  inputRef,
  enabled,
  apply,
}: {
  session: TerminalSession;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
  apply: (edit: Edit) => void;
}) {
  const [list, setListState] = useState<ListState | null>(null);
  /**
   * The list as of the last change, read by `onEdit`: a key handler that
   * closes the list (⌃W) is followed by a synchronous input event, which
   * would otherwise still see the open list of this render and reopen it.
   */
  const current = useRef(list);
  current.current = list;
  const setList = (next: ListState | null) => {
    current.current = next;
    setListState(next);
  };
  /** Bumped by every ⇥, so that only the latest lookup's result is used. */
  const lookup = useRef(0);

  // Leaving the editor drops a pending lookup and the list; so does a click
  // in it, which moves the caret without an edit.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const close = () => {
      lookup.current++;
      setList(null);
    };
    input.addEventListener("blur", close);
    input.addEventListener("mousedown", close);
    return () => {
      input.removeEventListener("blur", close);
      input.removeEventListener("mousedown", close);
    };
  }, [inputRef]);

  const close = () => {
    lookup.current++;
    setList(null);
  };

  const take = (candidate: Candidate) => {
    const input = inputRef.current;
    if (!input || !list) return;
    setList(null);
    // Only into the word the list was for, as it is now.
    const context = completionContext(input.value, input.selectionEnd);
    if (!context || context.from !== list.context.from || input.selectionStart !== input.selectionEnd) return;
    apply(applyCandidate(input.value, input.selectionEnd, context, candidate));
  };

  /** Starts a completion of the word at the caret; `fallback` runs if nothing completes. */
  const start = (line: string, caret: number, fallback: () => void): boolean => {
    if (!enabled || !line.trim() || slashCompletion(line)) return false;
    // Slash command lines are not shell commands; `/open`'s path still completes.
    if (parseSlash(line) && !slashCompletesPath(line, caret)) return false;
    const context = completionContext(line, caret);
    if (!context) return false;
    const id = ++lookup.current;
    void findCandidates(context, { cwd: session.cwd, home: homeDirectory(), path: session.shellPath }).then(
      ({ matches, ignoreCase }) => {
        const input = inputRef.current;
        // Typed or moved meanwhile: the result is for another word.
        if (id !== lookup.current || !input || input.value !== line || input.selectionEnd !== caret) return;
        if (matches.length === 0) fallback();
        else if (matches.length === 1) apply(applyCandidate(line, caret, context, matches[0]));
        else {
          const edit = applyPrefix(line, caret, context, matches, ignoreCase);
          if (edit) apply(edit);
          else setList({ context, all: matches, matches, selected: 0 });
        }
      },
    );
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, fallback: () => void): boolean => {
    const input = event.currentTarget;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (list) {
      const count = Math.min(list.matches.length, MAX_SHOWN);
      const move = (by: number) => setList({ ...list, selected: (list.selected + by + count) % count });
      const key = event.key;
      if (plain && (key === "Tab" || key === "ArrowDown" || key === "ArrowUp")) {
        move(key === "ArrowUp" || (key === "Tab" && event.shiftKey) ? -1 : 1);
      } else if (plain && !event.shiftKey && (key === "Enter" || key === "ArrowRight")) {
        const choice = list.matches[list.selected];
        if (choice) take(choice);
      } else if (key === "Escape") {
        close();
      } else {
        // Typing filters (see `onEdit`); anything else (caret moves, ⌃ keys) ends the list.
        const typing = plain && (key.length === 1 || key === "Backspace" || key === "Delete");
        const modifier = ["Shift", "Alt", "Control", "Meta", "CapsLock"].includes(key);
        if (!typing && !modifier) close();
        return false;
      }
      event.preventDefault();
      return true;
    }
    if (event.key !== "Tab" || !plain || event.shiftKey) return false;
    if (input.selectionStart !== input.selectionEnd) return false;
    if (!start(input.value, input.selectionEnd, fallback)) return false;
    event.preventDefault();
    return true;
  };

  /** The line changed by typing: narrows the list by the word's new text, or closes it. */
  const onEdit = (line: string, caret: number) => {
    const list = current.current;
    if (!list) return;
    const context = completionContext(line, caret);
    if (
      !context ||
      context.from !== list.context.from ||
      context.kind !== list.context.kind ||
      context.dir !== list.context.dir
    ) {
      close();
      return;
    }
    const { matches } = filterCandidates(list.all, context.prefix);
    if (matches.length === 0) close();
    else setList({ ...list, context, matches, selected: 0 });
  };

  const element = list && (
    <CompletionList
      matches={list.matches}
      selected={list.selected}
      onPick={take}
    />
  );

  return { onKeyDown, onEdit, close, list: element };
}
