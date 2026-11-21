import { isTauri } from "@tauri-apps/api/core";

/** Asks for a folder (a native picker; a prompt in the browser build). `null` if cancelled. */
export async function pickFolder(current: string): Promise<string | null> {
  if (!isTauri()) {
    const typed = window.prompt("Folder", current);
    return typed?.trim() || null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, defaultPath: current, title: "Folder for Claude Code" });
  return typeof picked === "string" ? picked : null;
}
