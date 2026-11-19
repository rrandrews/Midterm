import { isTauri } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/*
 * Clipboard access. In the app it goes through the clipboard plugin, because
 * WebKit's `navigator.clipboard.readText` shows a system "Paste" button
 * before it hands anything over. In a plain browser (`bun run dev`) it falls
 * back to the web API.
 */

export async function copyText(text: string): Promise<void> {
  try {
    if (isTauri()) await writeText(text);
    else await navigator.clipboard.writeText(text);
  } catch (error) {
    console.error("Copying to the clipboard failed:", error);
  }
}

/** The clipboard's text, or `""` if it has none or cannot be read. */
export async function pasteText(): Promise<string> {
  try {
    return (isTauri() ? await readText() : await navigator.clipboard.readText()) ?? "";
  } catch {
    // An empty clipboard, or one holding something other than text.
    return "";
  }
}
