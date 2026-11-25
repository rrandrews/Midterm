import { Check, ChevronRight } from "lucide-react";
import { ContextMenu as ContextPrimitive, DropdownMenu as DropdownPrimitive } from "radix-ui";
import { type ComponentProps, type ReactNode, createContext, useContext } from "react";
import { refocusPane } from "../../layout/dock";

/*
 * Menus styled to the mockup's pane menu, built on Radix.
 *
 * Two flavours share the same items: a dropdown opened from a button
 * (`Menu`, `MenuTrigger`, `MenuContent`) and a right-click menu
 * (`ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`). Radix has a
 * separate primitive for each, so the content tells the items below it which
 * one to render.
 */

type Flavour = "dropdown" | "context";
const FlavourContext = createContext<Flavour>("dropdown");

const PRIMITIVES = {
  dropdown: DropdownPrimitive,
  context: ContextPrimitive,
} as const;

/** The Radix primitive set of the menu an item is in. Item props are the same for both. */
function usePrimitive(): typeof DropdownPrimitive {
  return PRIMITIVES[useContext(FlavourContext)] as typeof DropdownPrimitive;
}

const SURFACE =
  "z-50 min-w-[228px] rounded-lg bg-popover p-[5px] shadow-menu outline-none select-none";

const ITEM =
  "flex h-7 w-full cursor-default items-center gap-2 rounded-[5px] px-2.5 text-left text-menu " +
  "text-fg-soft outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40";

/**
 * Focus goes back to a pane when a menu closes, not to whatever opened it,
 * unless the command opened a text field (rename, new file), which keeps it.
 */
function returnFocusToPane(event: Event): void {
  // In a dialog (settings), focus goes back to the trigger, as Radix does by default.
  if (document.querySelector("[role=dialog][data-owns-keyboard]")) return;
  event.preventDefault();
  if (document.activeElement instanceof HTMLInputElement) return;
  refocusPane();
}

export const Menu = DropdownPrimitive.Root;
export const MenuTrigger = DropdownPrimitive.Trigger;
export const ContextMenu = ContextPrimitive.Root;
export const ContextMenuTrigger = ContextPrimitive.Trigger;

export function MenuSub(props: ComponentProps<typeof DropdownPrimitive.Sub>) {
  const Primitive = usePrimitive();
  return <Primitive.Sub {...props} />;
}

export function MenuContent({
  className = "",
  onCloseAutoFocus = returnFocusToPane,
  ...props
}: ComponentProps<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <FlavourContext.Provider value="dropdown">
        <DropdownPrimitive.Content
          align="end"
          sideOffset={4}
          collisionPadding={6}
          className={`${SURFACE} ${className}`}
          onCloseAutoFocus={onCloseAutoFocus}
          {...props}
        />
      </FlavourContext.Provider>
    </DropdownPrimitive.Portal>
  );
}

export function ContextMenuContent({
  className = "",
  onCloseAutoFocus = returnFocusToPane,
  ...props
}: ComponentProps<typeof ContextPrimitive.Content>) {
  return (
    <ContextPrimitive.Portal>
      <FlavourContext.Provider value="context">
        <ContextPrimitive.Content
          collisionPadding={6}
          className={`${SURFACE} ${className}`}
          onCloseAutoFocus={onCloseAutoFocus}
          {...props}
        />
      </FlavourContext.Provider>
    </ContextPrimitive.Portal>
  );
}

function Shortcut({ children }: { children: ReactNode }) {
  return <span className="font-mono text-micro text-fg-dim">{children}</span>;
}

type MenuItemProps = ComponentProps<typeof DropdownPrimitive.Item> & {
  /** Key hint shown on the right, e.g. "⌘D". */
  shortcut?: string;
  /** Shows a check mark; reserves its space when `false`. */
  checked?: boolean;
  /** Destructive (delete): drawn in the theme's error color. */
  danger?: boolean;
};

const DANGER = "text-err! data-[highlighted]:bg-err/12";

export function MenuItem({ children, shortcut, checked, danger, className = "", ...props }: MenuItemProps) {
  const Primitive = usePrimitive();
  return (
    <Primitive.Item className={`${ITEM} ${danger ? DANGER : ""} ${className}`} {...props}>
      {checked !== undefined && (
        <span className="flex w-3 flex-none text-fg-dim">{checked && <Check size={12} />}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <Shortcut>{shortcut}</Shortcut>}
    </Primitive.Item>
  );
}

export function MenuSubTrigger({
  children,
  className = "",
  ...props
}: ComponentProps<typeof DropdownPrimitive.SubTrigger>) {
  const Primitive = usePrimitive();
  return (
    <Primitive.SubTrigger
      className={`${ITEM} data-[state=open]:bg-hover ${className}`}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight size={12} className="text-fg-dim" aria-hidden="true" />
    </Primitive.SubTrigger>
  );
}

export function MenuSubContent({
  className = "",
  ...props
}: ComponentProps<typeof DropdownPrimitive.SubContent>) {
  const Primitive = usePrimitive();
  return (
    <Primitive.Portal>
      <Primitive.SubContent
        sideOffset={6}
        alignOffset={-5}
        collisionPadding={6}
        className={`${SURFACE} min-w-[150px] ${className}`}
        {...props}
      />
    </Primitive.Portal>
  );
}

export function MenuSeparator() {
  const Primitive = usePrimitive();
  return <Primitive.Separator className="my-1 h-px bg-line-menu" />;
}
