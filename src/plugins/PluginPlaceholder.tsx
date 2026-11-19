import { useEffect, useRef } from "react";
import { registerPaneFocuser } from "../layout/dock";
import { closePane } from "../closing";
import { useSettings } from "../settings/settings";
import { getPlugin, kindLabel } from "./registry";

const BUTTON = "h-6 rounded-[5px] bg-raised px-2.5 text-meta text-fg-soft hover:text-fg-bright";

/**
 * Shown in a pane whose plugin is disabled or not installed: the pane and
 * its data are kept, so enabling (or re-importing) the plugin brings it back.
 */
export function PluginPlaceholder({ paneId, kind, problem }: { paneId: string; kind: string; problem?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => registerPaneFocuser(paneId, () => ref.current?.focus({ preventScroll: true })), [paneId]);
  const registered = getPlugin(kind);
  const label = kindLabel(kind);
  const message =
    problem ??
    (registered ? `The ${label} plugin is disabled.` : `The “${kind}” plugin is not installed.`);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-plugin-placeholder={kind}
      className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center outline-none"
    >
      <div className="font-medium text-fg-mid">{label}</div>
      <div className="text-meta text-fg-dim">{message}</div>
      <div className="flex gap-1.5 pt-1">
        {registered && !problem && (
          <button
            type="button"
            className={BUTTON}
            onClick={() => useSettings.getState().updatePluginEntry(kind, { enabled: true })}
          >
            Enable plugin
          </button>
        )}
        <button type="button" className={BUTTON} onClick={() => void closePane(paneId)}>
          Close pane
        </button>
      </div>
      <div className="text-micro text-fg-faint">Or change the pane’s type from its menu.</div>
    </div>
  );
}
