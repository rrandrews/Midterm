import { Command } from "cmdk";
import fuzzysort from "fuzzysort";
import { ChevronsUpDown, RotateCw } from "lucide-react";
import { Popover } from "radix-ui";
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FIELD } from "../../settings/controls";

/*
 * A text field with a fuzzy-filtered list of suggestions (model ids). Any
 * text can be committed; the list only helps. cmdk gives the list its
 * keyboard behaviour (filtering is ours, through fuzzysort, as in the
 * palette); a Radix popover places it under the field. The list is
 * portaled: cmdk finds its items through the list's own ref.
 */

/** Options rendered at most with an empty query. */
const SHOW_ALL_LIMIT = 200;

export type ComboItem =
  | { kind: "use"; key: string; value: string }
  | { kind: "option"; key: string; value: string; highlight: readonly number[] };

/**
 * The rows for `query`: every option (up to 200, or up to `current` if it
 * comes later; `more` counts the rest) when it is empty; else the best fuzzy
 * matches, after a `Use "<query>"` row when the query is not exactly an
 * option.
 */
export function comboItems(query: string, options: readonly string[], current?: string): { items: ComboItem[]; more: number } {
  const q = query.trim();
  if (!q) {
    const at = current ? options.indexOf(current) : -1;
    const shown = options.slice(0, Math.max(SHOW_ALL_LIMIT, at + 1));
    return {
      items: shown.map((value) => ({ kind: "option", key: `o:${value}`, value, highlight: [] })),
      more: options.length - shown.length,
    };
  }
  const items: ComboItem[] = [];
  if (!options.includes(q)) items.push({ kind: "use", key: "use", value: q });
  for (const result of fuzzysort.go(q, options, { limit: 100 })) {
    items.push({ kind: "option", key: `o:${result.target}`, value: result.target, highlight: [...result.indexes] });
  }
  return { items, more: 0 };
}

function Highlighted({ text, indexes }: { text: string; indexes: readonly number[] }) {
  if (!indexes.length) return <>{text}</>;
  const marked = new Set(indexes);
  return (
    <>
      {Array.from(text, (char, index) =>
        marked.has(index) ? (
          <span key={index} className="text-accent-fg">
            {char}
          </span>
        ) : (
          <Fragment key={index}>{char}</Fragment>
        ),
      )}
    </>
  );
}

export function Combobox({
  label,
  value,
  onCommit,
  options,
  placeholder,
  loading,
  error,
  onRefresh,
  emptyText,
  disabled,
  className = "w-56",
  countNoun = "models",
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  options: readonly string[];
  placeholder?: string;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  emptyText?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** What the footer counts ("N models"). */
  countNoun?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  // The filter: empty until the user types after opening, so the whole list shows first.
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(value), [value]);

  // cmdk always says the list is expanded.
  useLayoutEffect(() => {
    input.current?.setAttribute("aria-expanded", String(open));
  });

  const { items, more } = useMemo(() => comboItems(query, options, value), [query, options, value]);

  // Select the current value when the whole list shows, else the best match.
  useEffect(() => {
    if (!open) return;
    if (!query.trim() && value) {
      // The current value, or nothing when it is not listed (⏎ then keeps
      // it). Never empty: cmdk selects the first item that registers
      // whenever its value is empty.
      setSelected(`o:${value}`);
      return;
    }
    setSelected(items[0]?.key ?? "");
  }, [open, items, query, value]);

  // Keep the selected row in view when the list opens or the selection jumps.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [open, selected]);

  const show = () => {
    if (disabled || open) return;
    setQuery("");
    setOpen(true);
  };

  const commit = (text: string) => {
    const next = text.trim();
    setOpen(false);
    setQuery("");
    setDraft(next);
    if (next !== value) onCommit(next);
  };

  const footer = loading ? (
    <span>Loading…</span>
  ) : error ? (
    <>
      <span className="min-w-0 flex-1 truncate text-err" title={error}>
        {error}
      </span>
      {onRefresh && (
        <button type="button" className="flex-none text-fg-mid hover:text-fg-bright" onClick={onRefresh}>
          Retry
        </button>
      )}
    </>
  ) : onRefresh ? (
    <>
      <span className="min-w-0 flex-1 truncate">
        {options.length} {countNoun}
      </span>
      <button type="button" aria-label="Refresh the list" title="Refresh the list" className="flex flex-none text-fg-dim hover:text-fg-bright" onClick={onRefresh}>
        <RotateCw size={11} />
      </button>
    </>
  ) : null;

  return (
    <Command shouldFilter={false} loop label={label} value={selected} onValueChange={setSelected} className="contents">
      <Popover.Root open={open} onOpenChange={(next) => !next && setOpen(false)}>
        <Popover.Anchor asChild>
          <div ref={anchor} className={`relative flex ${className}`}>
            <Command.Input
              ref={input}
              aria-label={label}
              spellCheck={false}
              autoComplete="off"
              placeholder={placeholder}
              disabled={disabled}
              // Tells the settings dialog that Escape is ours (close the list or revert).
              data-escape-local={open || draft !== value ? "" : undefined}
              className={`${FIELD} w-full pr-6 font-mono`}
              value={draft}
              onValueChange={(text) => {
                setDraft(text);
                setQuery(text);
                setOpen(!disabled);
              }}
              onFocus={show}
              onClick={show}
              onBlur={() => commit(draft)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && !open) {
                  event.preventDefault();
                  show();
                } else if (event.key === "Enter" && (!open || !items.some((item) => item.key === selected))) {
                  // Closed, or no row selected (an unlisted current value): keep the text.
                  event.preventDefault();
                  commit(draft);
                } else if (event.key === "Escape") {
                  if (open) {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                  } else if (draft !== value) {
                    event.preventDefault();
                    event.stopPropagation();
                    setDraft(value);
                  }
                }
              }}
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={open ? "Hide the list" : "Show the list"}
              disabled={disabled}
              className="absolute top-0 right-0 flex h-6 w-6 items-center justify-center text-fg-dim hover:text-fg-bright disabled:opacity-40"
              // Keeps focus in the field.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (open) setOpen(false);
                else {
                  input.current?.focus();
                  show();
                }
              }}
            >
              <ChevronsUpDown size={12} />
            </button>
          </div>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={4}
            collisionPadding={8}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              // The field is outside the content but part of the combobox.
              if (anchor.current?.contains(event.target as Node)) event.preventDefault();
            }}
            // Clicks in the list must not take focus from the field (that would commit it).
            onMouseDown={(event) => event.preventDefault()}
            // The settings dialog's scroll lock would otherwise eat the wheel.
            onWheel={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
            style={{ width: "var(--radix-popover-trigger-width)" }}
            className="z-50 flex flex-col rounded-lg bg-popover p-[5px] shadow-menu outline-none"
          >
            <Command.List ref={list} className="max-h-[240px] overflow-y-auto">
              {items.length === 0 && !loading && <div className="px-2 py-1 text-meta text-fg-dim">{emptyText ?? "No matches"}</div>}
              {items.map((item) => (
                <Command.Item
                  key={item.key}
                  value={item.key}
                  onSelect={() => commit(item.value)}
                  className="flex h-6 cursor-default items-center rounded-[5px] px-2 font-mono text-menu text-fg-soft data-[selected=true]:bg-selected data-[selected=true]:text-fg-bright"
                >
                  <span className="min-w-0 truncate">
                    {item.kind === "use" ? (
                      <>
                        <span className="font-sans text-fg-dim">Use </span>“{item.value}”
                      </>
                    ) : (
                      <Highlighted text={item.value} indexes={item.highlight} />
                    )}
                  </span>
                </Command.Item>
              ))}
              {more > 0 && <div className="px-2 py-1 text-micro text-fg-dim">{more} more: type to filter</div>}
            </Command.List>
            {footer && <div className="mt-[5px] flex h-5 items-center gap-2 border-t border-line-menu px-2 pt-[5px] text-micro text-fg-dim">{footer}</div>}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Command>
  );
}
