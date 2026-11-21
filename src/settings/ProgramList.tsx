import { History, Plus, SquareTerminal, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { normalizePrograms } from "../plugins/fields";
import { globalHistory, loadGlobalHistory } from "../terminal/history";
import { programSuggestions } from "./programSuggestions";

/*
 * The editor for a `programs` field: each program a chip with a remove
 * button, and a field at the end that adds one, suggesting programs from
 * the command history and well-known TUIs as you type.
 *
 * Keys: ⏎ (or , and space) adds the typed name, or the suggestion picked
 * with ↑/↓ (or the mouse); ⇥ completes to the best match; ⌫ in the empty field
 * marks the last chip and a second ⌫ removes it; Escape closes the list,
 * then clears the field.
 */

const CHIP =
  "group inline-flex h-5 max-w-full items-center gap-0.5 rounded-[4px] bg-raised pl-1.5 pr-px font-mono text-meta text-fg-soft shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-[box-shadow,background-color] duration-150";

export function ProgramList({
  label,
  value,
  onChange,
  placeholder = "Add a program…",
}: {
  label: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  /** The chip ⌫ will remove (marked by a first ⌫ in the empty field). */
  const [armed, setArmed] = useState<string | null>(null);
  /** A chip flashed because its name was added again. */
  const [flash, setFlash] = useState<{ name: string; token: number } | null>(null);
  const [historyReady, setHistoryReady] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void loadGlobalHistory().then(() => live && setHistoryReady(true));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 700);
    return () => clearTimeout(timer);
  }, [flash]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: historyReady re-reads the loaded history
  const suggestions = useMemo(() => programSuggestions(globalHistory(), draft, value), [draft, value, historyReady]);
  const open = focused && !dismissed && suggestions.length > 0;

  // Nothing is highlighted until ↑/↓ or the mouse picks a row: ⏎ adds exactly
  // what was typed (`code` must not become `codex`), ⇥ completes to the best match.
  useEffect(() => setHighlight(-1), [draft]);

  /** Adds the names (the field may hold several, pasted); returns whether anything changed. */
  const add = (names: string[]) => {
    const existing = new Set(value.map((name) => name.toLowerCase()));
    const fresh = normalizePrograms(names).filter((name) => !existing.has(name.toLowerCase()));
    const repeated = names.map((name) => name.trim()).find((name) => name && existing.has(name.toLowerCase()));
    if (repeated) {
      const shown = value.find((name) => name.toLowerCase() === repeated.toLowerCase());
      if (shown) setFlash({ name: shown, token: Date.now() });
    }
    setDraft("");
    setArmed(null);
    if (fresh.length) onChange([...value, ...fresh]);
  };

  const remove = (name: string) => {
    setArmed(null);
    onChange(value.filter((entry) => entry !== name));
  };

  const commitDraft = () => {
    const names = draft.split(/[\s,]+/).filter(Boolean);
    if (names.length) add(names);
  };

  return (
    <Popover.Root open={open}>
      <Popover.Anchor asChild>
        <div
          ref={anchor}
          role="group"
          aria-label={label}
          className="flex min-h-7 w-full cursor-text flex-wrap items-center gap-1 rounded-[5px] bg-field p-[3px] shadow-[inset_0_0_0_1px_var(--color-line-strong)] focus-within:shadow-[inset_0_0_0_1px_var(--color-accent)]"
          onMouseDown={(event) => {
            // Clicking the empty space focuses the field (without stealing it from a chip's button).
            if (event.target === event.currentTarget) {
              event.preventDefault();
              input.current?.focus();
            }
          }}
        >
          {value.map((name) => {
            const isArmed = armed === name;
            const isFlashing = flash?.name === name;
            return (
              <span
                key={flash && isFlashing ? `${name}:${flash.token}` : name}
                className={`${CHIP} ${isArmed ? "bg-err/15 text-fg-bright shadow-[inset_0_0_0_1px_var(--color-err)]" : ""} ${isFlashing ? "animate-[chip-flash_700ms_ease-out]" : ""}`}
              >
                <span className="min-w-0 truncate" title={name}>
                  {name}
                </span>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Remove ${name}`}
                  title={`Remove ${name}`}
                  className="flex size-4 flex-none items-center justify-center rounded-[3px] text-fg-faint outline-none hover:bg-hover hover:text-fg-bright"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => remove(name)}
                >
                  <X size={10} strokeWidth={2.25} />
                </button>
              </span>
            );
          })}
          <div className="flex min-w-[120px] flex-1 items-center">
            {!draft && !focused && value.length > 0 && <Plus size={11} className="mr-0.5 ml-1 flex-none text-fg-faint" />}
            <input
              ref={input}
              aria-label={`Add to ${label}`}
              role="combobox"
              aria-expanded={open}
              aria-autocomplete="list"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              placeholder={value.length ? "Add…" : placeholder}
              className="h-5 min-w-0 flex-1 bg-transparent px-1 font-mono text-meta text-fg outline-none placeholder:font-sans placeholder:text-fg-faint"
              value={draft}
              // Tells the settings dialog that Escape is ours (close the list or clear the field).
              data-escape-local={open || draft || armed ? "" : undefined}
              onFocus={() => {
                setFocused(true);
                setDismissed(false);
              }}
              onBlur={() => {
                setFocused(false);
                setArmed(null);
                commitDraft();
              }}
              onChange={(event) => {
                setArmed(null);
                setDismissed(false);
                const text = event.target.value;
                // A separator typed (or pasted) ends a name.
                if (/[\s,]/.test(text)) {
                  const parts = text.split(/[\s,]+/);
                  const rest = parts.pop() ?? "";
                  add(parts.filter(Boolean));
                  setDraft(rest);
                } else setDraft(text);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  if (!suggestions.length) return;
                  event.preventDefault();
                  setDismissed(false);
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  // Cycles through the suggestions and "none" (-1).
                  const states = suggestions.length + 1;
                  setHighlight((at) => ((at + 1 + step + states) % states) - 1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const picked = open && highlight >= 0 ? suggestions[highlight] : undefined;
                  if (picked) add([picked.name]);
                  else commitDraft();
                } else if (event.key === "Tab" && !event.shiftKey && open && draft.trim()) {
                  event.preventDefault();
                  add([suggestions[Math.max(highlight, 0)].name]);
                } else if (event.key === "Backspace" && !draft && value.length) {
                  event.preventDefault();
                  // A held key must not clear the whole list: one chip per deliberate press.
                  if (event.repeat) return;
                  const last = value[value.length - 1];
                  if (armed === last) remove(last);
                  else setArmed(last);
                } else if (event.key === "Escape") {
                  if (open) {
                    event.stopPropagation();
                    setDismissed(true);
                  } else if (draft || armed) {
                    event.stopPropagation();
                    setDraft("");
                    setArmed(null);
                  }
                } else if (armed) setArmed(null);
              }}
            />
          </div>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // Clicks in the list must not take focus from the field.
          onMouseDown={(event) => event.preventDefault()}
          onWheel={(event) => event.stopPropagation()}
          className="z-50 flex w-[220px] flex-col rounded-lg bg-popover p-[5px] shadow-menu outline-none"
        >
          <div className="px-2 pt-0.5 pb-1 text-micro text-fg-dim">{draft.trim() ? "Matching programs" : "Suggestions"}</div>
          <div role="listbox" aria-label={`${label} suggestions`} className="max-h-[220px] overflow-y-auto">
            {suggestions.map((suggestion, index) => (
              <div
                key={suggestion.name}
                role="option"
                aria-selected={index === highlight}
                tabIndex={-1}
                className="flex h-6 cursor-default items-center gap-2 rounded-[5px] px-2 text-menu text-fg-soft aria-selected:bg-selected aria-selected:text-fg-bright"
                onMouseEnter={() => setHighlight(index)}
                onClick={() => add([suggestion.name])}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{suggestion.name}</span>
                {suggestion.source === "history" ? (
                  <span className="flex flex-none items-center gap-1 text-micro text-fg-faint" title="Run in a terminal before">
                    <History size={10} />
                    recent
                  </span>
                ) : (
                  <span className="flex flex-none items-center gap-1 text-micro text-fg-faint" title="An interactive app that draws inline">
                    <SquareTerminal size={10} />
                    TUI
                  </span>
                )}
              </div>
            ))}
          </div>
          {draft.trim() && (
            <div className="mt-[5px] flex h-5 items-center gap-2 border-t border-line-menu px-2 pt-[5px] text-micro text-fg-dim">
              <span className="min-w-0 truncate">
                ↵ adds <span className="font-mono text-fg-soft">{draft.trim()}</span>
              </span>
              {highlight < 0 && suggestions[0] && (
                <span className="ml-auto flex-none">
                  ⇥ <span className="font-mono text-fg-soft">{suggestions[0].name}</span>
                </span>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
