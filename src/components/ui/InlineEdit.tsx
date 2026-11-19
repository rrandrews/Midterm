import { useEffect, useRef } from "react";

type InlineEditProps = {
  value: string;
  /** Called with the new value on Enter or blur (not called if unchanged, or blank unless `allowEmpty`). */
  onCommit: (value: string) => void;
  /** A blank value is committed too (it means something, e.g. "name it automatically"). */
  allowEmpty?: boolean;
  /** Called when editing ends, whether or not anything was committed. */
  onDone: () => void;
  label: string;
  className?: string;
};

/** A text field that edits a label in place and sizes itself to its content. */
export function InlineEdit({
  value,
  onCommit,
  onDone,
  label,
  allowEmpty = false,
  className = "",
}: InlineEditProps) {
  // Escape blurs the field; this keeps that blur from committing.
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  // Opened from a menu, `autoFocus` loses to the menu's focus trap, which
  // lets go only once the menu has closed; so take focus again after that.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (document.activeElement !== input.current) input.current?.focus();
    });
    return () => clearTimeout(timer);
  }, []);

  const finish = (input: HTMLInputElement) => {
    const next = input.value.trim();
    if (!cancelled.current && (next || allowEmpty) && next !== value) onCommit(next);
    onDone();
  };

  return (
    <input
      ref={input}
      aria-label={label}
      defaultValue={value}
      autoFocus
      spellCheck={false}
      className={`min-w-[3ch] rounded-sm bg-field px-1 text-fg-bright outline-none ring-1 ring-accent [field-sizing:content] select-text ${className}`}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => finish(event.currentTarget)}
      onKeyDown={(event) => {
        // Keep app shortcuts and tab-strip handlers from seeing typing.
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
      onClick={(event) => event.stopPropagation()}
      // The field's own menu (cut, copy, paste), not the menu of what it sits in.
      onContextMenu={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
