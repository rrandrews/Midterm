import { Popover } from "radix-ui";
import type { ReactNode } from "react";
import { HexAlphaColorPicker, HexColorInput, HexColorPicker } from "react-colorful";
import { normalizeHex } from "../../theme/color";

/*
 * Color picking without the native color well: a swatch (or any trigger)
 * that opens a popover with a saturation/hue picker and a hex field.
 */

const CHECKER = "repeating-conic-gradient(#8888 0% 25%, transparent 0% 50%) 50% / 8px 8px";

/** A color chip over a checkerboard, so alpha shows. */
export function Swatch({ color, className = "size-4 rounded-[4px]" }: { color: string; className?: string }) {
  return (
    <span className={`relative flex-none overflow-hidden shadow-[inset_0_0_0_1px_var(--color-line-strong)] ${className}`} style={{ background: CHECKER }}>
      <span className="absolute inset-0" style={{ background: color }} />
      <span className="absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-fg-bright)_12%,transparent)]" />
    </span>
  );
}

export function ColorPopover({
  label,
  value,
  onChange,
  alpha = false,
  children,
  side = "bottom",
  align = "center",
  onReset,
  resetLabel = "Reset",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** `#rrggbbaa` allowed. */
  alpha?: boolean;
  /** The trigger; a swatch with the hex value by default. */
  children?: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Shows a reset button under the picker (back to a derived or default value). */
  onReset?: () => void;
  resetLabel?: string;
}) {
  const Picker = alpha ? HexAlphaColorPicker : HexColorPicker;
  const accept = (color: string) => {
    const hex = normalizeHex(color);
    if (!hex) return;
    onChange(alpha ? hex : hex.slice(0, 7));
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        {children ?? (
          <button
            type="button"
            aria-label={`${label}: ${value}`}
            className="flex h-6 items-center gap-1.5 rounded-[5px] bg-field pr-2 pl-1 font-mono text-micro text-fg-mid outline-none shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:text-fg-soft focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] data-[state=open]:shadow-[inset_0_0_0_1px_var(--color-accent)]"
          >
            <Swatch color={value} />
            <span>{value}</span>
          </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="color-popover z-[60] flex w-[212px] flex-col gap-2 rounded-lg bg-popover p-2.5 shadow-menu outline-none"
        >
          <Picker color={value} onChange={accept} />
          <div className="flex items-center gap-2">
            <Swatch color={value} className="size-6 rounded-[5px]" />
            <HexColorInput
              alpha={alpha}
              prefixed
              aria-label={`${label} hex`}
              color={value}
              onChange={accept}
              spellCheck={false}
              className="h-6 min-w-0 flex-1 rounded-[5px] bg-field px-2 font-mono text-meta text-fg outline-none shadow-[inset_0_0_0_1px_var(--color-line-strong)] focus:shadow-[inset_0_0_0_1px_var(--color-accent)]"
            />
          </div>
          {onReset && (
            <Popover.Close
              onClick={onReset}
              className="h-6 rounded-[5px] text-meta text-fg-dim outline-none hover:bg-hover hover:text-fg-bright focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
            >
              {resetLabel}
            </Popover.Close>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
