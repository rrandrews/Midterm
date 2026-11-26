/*
 * The explorers' own clipboard for files (⌘C / ⌘X, then ⌘V), shared by
 * every explorer in the window. It holds paths, not contents; the system
 * clipboard is left alone (⌥⌘C copies paths as text there).
 */

export type FileClipboard = { paths: string[]; cut: boolean } | null;

let current: FileClipboard = null;
const listeners = new Set<() => void>();

export function fileClipboard(): FileClipboard {
  return current;
}

export function setFileClipboard(next: FileClipboard): void {
  current = next && next.paths.length ? next : null;
  for (const listener of listeners) listener();
}

export function subscribeFileClipboard(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
