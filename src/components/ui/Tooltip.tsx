import { CircleHelp } from "lucide-react";
import { Tooltip as Primitive } from "radix-ui";
import type { ReactNode } from "react";

/*
 * Tooltips: `Tip` wraps any element; `Help` is the small (?) that holds the
 * explanation a setting needs, so the settings themselves stay one line.
 */

const CONTENT =
  "z-[70] max-w-[260px] rounded-md bg-popover px-2.5 py-1.5 text-meta leading-snug text-fg-soft shadow-menu select-none " +
  "data-[state=delayed-open]:animate-[tip-in_120ms_ease-out]";

export function Tip({
  content,
  children,
  side = "top",
  delay = 350,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delay?: number;
}) {
  if (!content) return <>{children}</>;
  return (
    <Primitive.Provider delayDuration={delay} skipDelayDuration={200}>
      <Primitive.Root>
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
