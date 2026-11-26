import { CircleHelp } from "lucide-react";
import { Tooltip as Primitive } from "radix-ui";
import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";

/*
 * Tooltips: `Tip` wraps any element; `Help` is the small (?) that holds the
 * explanation a setting needs, so the settings themselves stay one line;
 * `AnchoredTip` shows one over a screen rectangle that is no element of its
 * own (a link drawn by xterm), opened and closed by its owner.
 */

const CONTENT =
  "z-[70] max-w-[260px] rounded-md bg-popover px-2.5 py-1.5 text-meta leading-snug text-fg-soft shadow-menu select-none " +
  "data-[state=delayed-open]:animate-[tip-in_120ms_ease-out]";

export function Tip({
  content,
  children,
  side = "top",
  delay = 350,
  disabled = false,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delay?: number;
  /** Suppresses the tooltip without unmounting the trigger tree. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!content) return <>{children}</>;
  return (
    <Primitive.Provider delayDuration={delay} skipDelayDuration={200}>
      <Primitive.Root open={disabled ? false : open} onOpenChange={(next) => setOpen(!disabled && next)}>
        <Primitive.Trigger asChild>{children}</Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content side={side} sideOffset={5} collisionPadding={8} className={CONTENT}>
            {content}
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </Primitive.Provider>
  );
}

/**
 * A tooltip over `rect` (viewport coordinates), shown while mounted. The
 * owner decides when (hover delay included). It never takes the pointer, so
 * it cannot steal the hover that keeps it open.
 */
export function AnchoredTip({
  rect,
  content,
  side = "top",
}: {
  rect: { left: number; top: number; width: number; height: number };
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Primitive.Provider delayDuration={0}>
      <Primitive.Root open>
        {createPortal(
          <Primitive.Trigger asChild>
            <span
              aria-hidden
              style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: "none" }}
            />
          </Primitive.Trigger>,
          document.body,
        )}
        <Primitive.Portal>
          <Primitive.Content
            side={side}
            sideOffset={5}
            collisionPadding={8}
            // Open is controlled with no `onOpenChange`: Radix's own dismissals (Escape, outside clicks) do nothing.
            className={`${CONTENT} pointer-events-none`}
          >
            {content}
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </Primitive.Provider>
  );
}

/** A (?) that shows `children` on hover or focus. */
export function Help({ children, label = "More information" }: { children: ReactNode; label?: string }) {
  return (
    <Tip content={children} delay={80}>
      <button
        type="button"
        aria-label={label}
        // Tooltips are not announced from a click; keep the click from doing anything else.
        onClick={(event) => event.preventDefault()}
        className="inline-flex size-4 flex-none translate-y-px items-center justify-center rounded-full text-fg-faint outline-none hover:text-fg-mid focus-visible:text-fg-mid"
      >
        <CircleHelp size={12} strokeWidth={1.75} />
      </button>
    </Tip>
  );
}
