import { memo } from "react";
import type { IconKind, LoadedIconSet } from "./types";

/*
 * One file or folder icon, 16px. Image icons are drawn as <img> (a mono
 * one as a mask in the text color), never as inline SVG: SVG loaded as an
 * image runs no script and loads nothing, and ids inside different icons
 * cannot collide.
 */

type Props = {
  /** The set showing; null while it loads (a blank of the same width keeps the row from shifting). */
  set: LoadedIconSet | null;
  light: boolean;
  name: string;
  path?: string;
  kind: IconKind;
  expanded?: boolean;
};

export const FileIcon = memo(function FileIcon({ set, light, name, path, kind, expanded = false }: Props) {
  if (set?.id === "none") return null;
  const image = set?.icon({ name, path, kind, expanded, light });
  if (!image) return <span className="file-icon" aria-hidden="true" />;
  if ("lucide" in image) {
    const Icon = image.lucide;
    return <Icon size={14} strokeWidth={1.75} className="file-icon is-lucide" aria-hidden="true" />;
  }
  if (image.mono) {
    const mask = `url("${image.url}")`;
    return (
      <span
        className="file-icon is-mono"
        aria-hidden="true"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      />
    );
  }
  return <img className="file-icon" src={image.url} alt="" aria-hidden="true" draggable={false} decoding="sync" />;
});

/** Whether a set draws icons (the row then makes room for them). */
export function drawsIcons(set: LoadedIconSet | null): boolean {
  return set?.id !== "none";
}
