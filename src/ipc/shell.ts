import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

/** Opens a link in the user's default browser. Only http(s) links are opened. */
export function openExternal(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (isTauri()) {
    openUrl(url.href).catch((error) => console.error("Opening link failed:", error));
  } else {
    window.open(url.href, "_blank", "noopener,noreferrer");
  }
}

/** Shows a file or directory in Finder (the file manager elsewhere), selected. */
export function revealInFileManager(path: string): void {
  if (!isTauri()) {
    console.info("Reveal:", path);
    return;
  }
  revealItemInDir(path).catch((error) => console.error("Revealing the file failed:", error));
}

/** Opens a file or directory with its default application (Finder for a folder). */
export function openWithDefaultApp(path: string): void {
  if (!isTauri()) {
    console.info("Open with default application:", path);
    return;
  }
  invoke("fs_open_default", { path }).catch((error) => console.error("Opening the file failed:", error));
}
