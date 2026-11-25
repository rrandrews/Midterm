import { DEFAULT_SCOPE, settingsFor, useSettings } from "../settings/settings";
import { useAppStore } from "../state/store";
import type { Workspace } from "../state/types";
import { scopeResolvedTheme, useThemeState } from "../theme/state";
import { workspaceIcon } from "./icons";

/*
 * A workspace's badge: its icon, or its initial, on a rounded square in
 * its accent. Each workspace may have its own theme or accent, so a badge
 * for a workspace that is not showing uses that workspace's accent.
 */

const SIZES = {
  /** Title bar. */
  sm: { box: "size-3.5 rounded-[4px] text-badge", icon: 9.5, stroke: 2.4 },
  /** Menus and lists. */
  md: { box: "size-[18px] rounded-[5px] text-micro", icon: 11, stroke: 2.2 },
  /** The settings' identity row and icon picker preview. */
  lg: { box: "size-10 rounded-[10px] text-heading", icon: 20, stroke: 1.9 },
} as const;

/** The accent of a workspace's settings, as a CSS color. */
export function useWorkspaceAccent(workspaceId: string): string {
  const active = useAppStore((state) => state.activeWorkspaceId);
  const systemDark = useThemeState((state) => state.systemDark);
  const settings = useSettings((state) => settingsFor(workspaceId || DEFAULT_SCOPE, state.base));
  if (workspaceId === active) return "var(--color-accent)";
  return scopeResolvedTheme(settings, systemDark).tokens.accent;
}

export function WorkspaceBadge({
  workspace,
  size = "sm",
  icon,
  className = "",
}: {
  workspace: Pick<Workspace, "id" | "name" | "icon">;
  size?: keyof typeof SIZES;
  /** Shows this icon instead of the saved one (a preview while picking); `null` for the initial. */
  icon?: string | null;
  className?: string;
}) {
  const accent = useWorkspaceAccent(workspace.id);
  const spec = SIZES[size];
  const Icon = workspaceIcon(icon === undefined ? workspace.icon : (icon ?? undefined));
  return (
    <span
      aria-hidden="true"
      className={`flex flex-none items-center justify-center font-bold text-app ${spec.box} ${className}`}
      style={{ background: accent }}
    >
      {Icon ? <Icon size={spec.icon} strokeWidth={spec.stroke} /> : workspace.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
