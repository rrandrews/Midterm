import { lazy, Suspense, useState } from "react";
import {
  Asterisk,
  Eye,
  FileCode,
  FolderTree,
  type LucideIcon,
  NotebookPen,
  Orbit,
  Palette,
  Puzzle,
  Rows3,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import type { IconSpec } from "./types";

/*
 * A plugin's icon (`PanePlugin.icon`): in the settings' plugin list and on
 * its panes' subtabs. Built-in plugins' icons are bundled; any other lucide
 * name (an imported plugin's) loads on first use; a URL is drawn as an
 * image; no icon, or an unknown name, gets a puzzle piece.
 */

/** Built-in plugins' lucide icon names, drawn without loading anything. */
const BUNDLED: Record<string, LucideIcon> = {
  "square-terminal": SquareTerminal,
  "rows-3": Rows3,
  "file-code": FileCode,
  eye: Eye,
  "folder-tree": FolderTree,
  asterisk: Asterisk,
  orbit: Orbit,
  palette: Palette,
  sparkles: Sparkles,
  "notebook-pen": NotebookPen,
};

const LUCIDE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Every lucide icon, loaded by name. Its table of names is itself a lazy chunk. */
const DynamicIcon = lazy(async () => {
  const { DynamicIcon: Icon, iconNames } = await import("lucide-react/dynamic");
  const known = new Set<string>(iconNames);
  return {
    default: ({ name, size, strokeWidth, className }: { name: string; size: number; strokeWidth: number; className: string }) =>
      known.has(name) ? (
        <Icon name={name as never} size={size} strokeWidth={strokeWidth} className={className} />
      ) : (
        <Puzzle size={size} strokeWidth={strokeWidth} className={className} />
      ),
  };
});

/** Whether an icon spec is an image URL rather than a lucide name. */
export function isIconUrl(icon: string): boolean {
  return /^(https?:|data:|blob:|asset:|plugin:|\/)/.test(icon) || /^[a-z][a-z0-9+.-]*:\/\//i.test(icon);
}

export function PluginIcon({ icon, size = 14, className = "" }: { icon?: IconSpec; size?: number; className?: string }) {
  // An image that cannot load (a missing file, a URL the CSP blocks) gets the puzzle piece.
  const [failed, setFailed] = useState<string | null>(null);
  const classes = `flex-none ${className}`;
  if (icon && isIconUrl(icon) && failed !== icon) {
    return (
      <img
        src={icon}
        alt=""
        draggable={false}
        className={classes}
        style={{ width: size, height: size }}
        onError={() => setFailed(icon)}
      />
    );
  }
  // Own properties only: "constructor" is a valid icon name.
  const Bundled = icon && Object.prototype.hasOwnProperty.call(BUNDLED, icon) ? BUNDLED[icon] : undefined;
  if (Bundled || !icon || !LUCIDE_NAME.test(icon) || isIconUrl(icon)) {
    const Icon = Bundled ?? Puzzle;
    return <Icon size={size} strokeWidth={1.75} className={classes} />;
  }
  return (
    <Suspense fallback={<span className={classes} style={{ width: size, height: size }} />}>
      <DynamicIcon name={icon} size={size} strokeWidth={1.75} className={classes} />
    </Suspense>
  );
}
