import { Check, ChevronRight } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

/* Dropdown menu styled to the mockup's pane menu, built on Radix. */

const SURFACE =
  "z-50 min-w-[228px] rounded-lg bg-popover p-[5px] shadow-menu outline-none select-none";

const ITEM =
  "flex h-7 w-full cursor-default items-center gap-2 rounded-[5px] px-2.5 text-left text-menu " +
  "text-fg-soft outline-none data-[highlighted]:bg-white/[0.06] data-[disabled]:opacity-40";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuSub = DropdownMenu.Sub;

export function MenuContent({
  className = "",
  ...props
}: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align="end"
        sideOffset={4}
        collisionPadding={6}
        className={`${SURFACE} ${className}`}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

function Shortcut({ children }: { children: ReactNode }) {
  return <span className="font-mono text-micro text-fg-dim">{children}</span>;
}

type MenuItemProps = ComponentProps<typeof DropdownMenu.Item> & {
  /** Key hint shown on the right, e.g. "⌘D". */
  shortcut?: string;
  /** Shows a check mark; reserves its space when `false`. */
  checked?: boolean;
};

export function MenuItem({ children, shortcut, checked, className = "", ...props }: MenuItemProps) {
  return (
    <DropdownMenu.Item className={`${ITEM} ${className}`} {...props}>
      {checked !== undefined && (
        <span className="flex w-3 flex-none text-fg-dim">{checked && <Check size={12} />}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <Shortcut>{shortcut}</Shortcut>}
    </DropdownMenu.Item>
  );
}

export function MenuSubTrigger({
  children,
  className = "",
  ...props
}: ComponentProps<typeof DropdownMenu.SubTrigger>) {
  return (
    <DropdownMenu.SubTrigger
      className={`${ITEM} data-[state=open]:bg-white/[0.06] ${className}`}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight size={12} className="text-fg-dim" aria-hidden="true" />
    </DropdownMenu.SubTrigger>
  );
}

export function MenuSubContent({
  className = "",
  ...props
}: ComponentProps<typeof DropdownMenu.SubContent>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent
        sideOffset={6}
        alignOffset={-5}
        collisionPadding={6}
        className={`${SURFACE} min-w-[150px] ${className}`}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line-menu" />;
}
