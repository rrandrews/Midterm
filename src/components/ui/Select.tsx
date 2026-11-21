import { Check, ChevronDown } from "lucide-react";
import { Select as Primitive } from "radix-ui";
import { Fragment, type ReactNode } from "react";

/*
 * The app's dropdown, in place of the native <select>: a Radix Select
 * styled like the menus (keyboard, typeahead and ARIA come from Radix).
 * Options may carry a leading visual (a color dot, an icon), a muted
 * detail on the right, and a group heading.
 *
 * Radix reserves the empty string for "no value", so an option whose value
 * is "" is stored under a sentinel and mapped back.
 */

export type SelectOption = {
  value: string;
  label: string;
  /** Leading visual: a swatch or an icon. */
  icon?: ReactNode;
  /** Muted text after the label (in the list only). */
  detail?: string;
  /** Options with the same group are listed together under it, in order of first appearance. */
  group?: string;
  disabled?: boolean;
};

const EMPTY = "\u0000empty";
const encode = (value: string) => (value === "" ? EMPTY : value);
const decode = (value: string) => (value === EMPTY ? "" : value);

export const SELECT_TRIGGER =
  "group/select flex h-6 min-w-0 items-center gap-1.5 rounded-[5px] bg-field pr-1.5 pl-2 text-left text-ui text-fg outline-none " +
  "shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-fg-dim)_45%,transparent)] " +
  "focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] data-[state=open]:shadow-[inset_0_0_0_1px_var(--color-accent)] " +
  "disabled:opacity-40 data-[placeholder]:text-fg-faint";

const ITEM =
  "relative flex h-7 cursor-default items-center gap-2 rounded-[5px] pr-7 pl-2.5 text-menu text-fg-soft outline-none select-none " +
  "data-[highlighted]:bg-hover data-[highlighted]:text-fg-bright data-[state=checked]:text-fg-bright data-[disabled]:opacity-40";

export function Select({
  value,
  options,
  onChange,
  label,
  placeholder,
  disabled,
  className = "w-44",
  align = "item-aligned",
}: {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** Accessible name. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  /** Width and extra classes of the trigger. */
  className?: string;
  /** `item-aligned` opens over the trigger like macOS; `popper` drops below it. */
  align?: "item-aligned" | "popper";
}) {
  const current = options.find((option) => option.value === value);
  const groups: { name: string | undefined; options: SelectOption[] }[] = [];
  for (const option of options) {
    const group = groups.find((candidate) => candidate.name === option.group);
    if (group) group.options.push(option);
    else groups.push({ name: option.group, options: [option] });
  }
  // A value that is not an option (stale, unknown) still shows as itself.
  const shown = current ?? (value ? { value, label: value } : undefined);

  return (
    <Primitive.Root value={shown ? encode(shown.value) : ""} onValueChange={(next) => onChange(decode(next))} disabled={disabled}>
      <Primitive.Trigger aria-label={label} className={`${SELECT_TRIGGER} ${className}`}>
        {shown?.icon && <span className="flex flex-none items-center">{shown.icon}</span>}
        <span className="min-w-0 flex-1 truncate">
          <Primitive.Value placeholder={placeholder ?? "Choose…"}>{shown?.label}</Primitive.Value>
        </span>
        <Primitive.Icon className="flex flex-none text-fg-dim group-hover/select:text-fg-mid">
          <ChevronDown size={12} />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          position={align}
          sideOffset={4}
          collisionPadding={8}
          // The settings dialog's scroll lock would otherwise eat the wheel.
          onWheel={(event) => event.stopPropagation()}
          className="z-[60] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg bg-popover shadow-menu outline-none"
        >
          <Primitive.ScrollUpButton className="flex h-5 items-center justify-center text-fg-dim">
            <ChevronDown size={12} className="rotate-180" />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport className="p-[5px]">
            {!current && shown && (
              <Primitive.Item value={encode(shown.value)} className={ITEM}>
                <Primitive.ItemText>{shown.label}</Primitive.ItemText>
                <span className="text-micro text-fg-faint">unknown</span>
              </Primitive.Item>
            )}
            {groups.map((group, index) => (
              <Fragment key={group.name ?? `group-${index}`}>
                {index > 0 && <Primitive.Separator className="mx-1 my-1 h-px bg-line-menu" />}
                <Primitive.Group>
                  {group.name && <Primitive.Label className="px-2.5 pt-1 pb-0.5 text-micro font-medium text-fg-faint">{group.name}</Primitive.Label>}
                  {group.options.map((option) => (
                    <Primitive.Item key={option.value} value={encode(option.value)} disabled={option.disabled} className={ITEM}>
                      {option.icon && <span className="flex flex-none items-center">{option.icon}</span>}
                      <span className="min-w-0 truncate">
                        <Primitive.ItemText>{option.label}</Primitive.ItemText>
                      </span>
                      {option.detail && <span className="ml-auto flex-none pl-3 text-micro text-fg-faint">{option.detail}</span>}
                      <Primitive.ItemIndicator className="absolute right-2 flex text-accent">
                        <Check size={12} />
                      </Primitive.ItemIndicator>
                    </Primitive.Item>
                  ))}
                </Primitive.Group>
              </Fragment>
            ))}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton className="flex h-5 items-center justify-center text-fg-dim">
            <ChevronDown size={12} />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

/** A color dot for an option's `icon`. */
export function Dot({ color, ring }: { color: string; ring?: string }) {
  return (
    <span
      className="size-2.5 flex-none rounded-full"
      style={{ background: color, boxShadow: `0 0 0 1px ${ring ?? "var(--color-line-strong)"}` }}
    />
  );
}
