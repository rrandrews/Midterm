/*
 * Claude Code settings files and memory files, read and written directly
 * (there is no CLI or SDK call for the raw text, and the webview edits JSON).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ConfigFile, ConfigScope, MemoryFile } from "../protocol";
import { BridgeFailure } from "./errors";

/** `$CLAUDE_CONFIG_DIR` or `~/.claude`, read on each call so tests can change the environment. */
export function userConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function settingsPath(cwd: string, scope: ConfigScope): string {
  switch (scope) {
    case "user":
      return join(userConfigDir(), "settings.json");
    case "project":
      return join(cwd, ".claude", "settings.json");
    case "local":
      return join(cwd, ".claude", "settings.local.json");
  }
}

export async function readConfig(cwd: string, scope: ConfigScope): Promise<ConfigFile> {
  const path = settingsPath(cwd, scope);
  try {
    return { scope, path, exists: true, text: await readFile(path, "utf8") };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { scope, path, exists: false, text: "" };
    throw e;
  }
}

export async function writeConfig(cwd: string, scope: ConfigScope, text: string): Promise<ConfigFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BridgeFailure(e instanceof Error ? e.message : String(e), "invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BridgeFailure("Settings must be a JSON object", "invalid");
  }
  const path = settingsPath(cwd, scope);
  await mkdir(dirname(path), { recursive: true });
  // Temp file in the same directory so the rename is atomic and never leaves half a settings file.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return { scope, path, exists: true, text };
}

export function memoryFiles(cwd: string): MemoryFile[] {
  const entry = (label: string, path: string): MemoryFile => ({ label, path, exists: existsSync(path) });
  return [
    entry("User memory", join(userConfigDir(), "CLAUDE.md")),
    entry("Project memory", join(cwd, "CLAUDE.md")),
    entry("Project memory (.claude)", join(cwd, ".claude", "CLAUDE.md")),
    entry("Local memory", join(cwd, "CLAUDE.local.md")),
  ];
}
