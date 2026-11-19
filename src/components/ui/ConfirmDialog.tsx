import { AlertDialog } from "radix-ui";
import { useEffect, useState } from "react";
import { refocusPane } from "../../layout/dock";

/*
 * A promise-based confirmation dialog: `confirm({...})` resolves to whether
 * the user agreed. `<ConfirmHost />` (mounted once, in App) renders it.
 * Only one is shown at a time; a second request while one is open is
 * declined at once.
 */

export type ConfirmRequest = {
  title: string;
  message: string;
  /** Label of the confirming (destructive) button. */
  action: string;
};

type Pending = ConfirmRequest & { resolve: (ok: boolean) => void };

let pending: Pending | null = null;
let show: ((request: Pending | null) => void) | null = null;

export function confirm(request: ConfirmRequest): Promise<boolean> {
  if (pending || !show) return Promise.resolve(false);
  return new Promise((resolve) => {
    pending = { ...request, resolve };
    show?.(pending);
  });
}

/** Whether a confirmation is open (it owns the keyboard meanwhile). */
export function isConfirming(): boolean {
  return pending !== null;
}

function settle(ok: boolean): void {
  const current = pending;
  pending = null;
  show?.(null);
  current?.resolve(ok);
}

export function ConfirmHost() {
  const [request, setRequest] = useState<Pending | null>(null);

  useEffect(() => {
    show = setRequest;
    return () => {
      show = null;
      settle(false);
    };
  }, []);

  return (
    <AlertDialog.Root open={request !== null} onOpenChange={(open) => !open && settle(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <AlertDialog.Content
          className="fixed top-[22%] left-1/2 z-50 w-[360px] -translate-x-1/2 rounded-lg bg-popover p-4 shadow-menu outline-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            refocusPane();
          }}
        >
          <AlertDialog.Title className="text-input font-medium text-fg-bright">
            {request?.title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-ui text-fg-mid">
            {request?.message}
          </AlertDialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel
              className="h-7 rounded-[5px] px-3 text-menu text-fg-soft outline-none hover:bg-white/[0.06] focus-visible:shadow-[0_0_0_1px_var(--color-accent)]"
              onClick={() => settle(false)}
            >
              Cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              className="h-7 rounded-[5px] bg-err/15 px-3 text-menu text-err outline-none hover:bg-err/25 focus-visible:shadow-[0_0_0_1px_var(--color-err)]"
              onClick={() => settle(true)}
            >
              {request?.action}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
