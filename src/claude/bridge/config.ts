/*
 * Claude Code settings files and memory files, read and written directly
 * (there is no CLI or SDK call for the raw text, and the webview edits JSON).
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
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

/** Writes per file path, one at a time, so a baseline check and its write cannot interleave with another save. */
const writing = new Map<string, Promise<unknown>>();

export function writeConfig(cwd: string, scope: ConfigScope, text: string, expected?: { exists: boolean; text: string }): Promise<ConfigFile> {
  const path = settingsPath(cwd, scope);
  const previous = writing.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => writeNow(cwd, scope, text, expected));
  writing.set(path, next);
  void next.finally(() => {
    if (writing.get(path) === next) writing.delete(path);
  }).catch(() => {});
  return next;
}

async function writeNow(cwd: string, scope: ConfigScope, text: string, expected?: { exists: boolean; text: string }): Promise<ConfigFile> {
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
  if (expected) {
    const current = await readConfig(cwd, scope);
    if (current.exists !== expected.exists || current.text !== expected.text) {
      throw new BridgeFailure("The file changed since it was loaded.", "conflict");
    }
  }
  await mkdir(dirname(path), { recursive: true });
  // Replace what a symlink points at, not the link; keep the existing file's mode.
  let target = path;
  let mode: number | undefined;
  try {
    target = await realpath(path);
    mode = (await stat(target)).mode & 0o7777;
  } catch {
    // does not exist yet: default mode
  }
  // Exclusive temp file in the same directory: the rename is atomic, never half a file, and we only ever remove our own temp.
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, text, { flag: "wx", ...(mode !== undefined ? { mode } : {}) });
    // writeFile's mode is masked by the umask; restore the exact mode.
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return { scope, path, exists: true, text };
}

export function memoryFiles(cwd: string): MemoryFile[] {
  const entry = (label: string, path: string): MemoryFile => ({ label, path, exists: existsSync(path) });
  // Claude Code also loads CLAUDE.md files of parent folders; nearest last, like its own load order.
  const parents: MemoryFile[] = [];
  const home = homedir();
  for (let dir = dirname(cwd); dir !== parse(dir).root && dir !== dirname(dir); dir = dirname(dir)) {
    const label = dir === home ? "~" : dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir;
    parents.unshift(
      entry(`Parent memory (${label})`, join(dir, "CLAUDE.md")),
      entry(`Parent memory (${label}, .claude)`, join(dir, ".claude", "CLAUDE.md")),
    );
  }
  return [
    entry("User memory", join(userConfigDir(), "CLAUDE.md")),
    ...parents,
    entry("Project memory", join(cwd, "CLAUDE.md")),
    entry("Project memory (.claude)", join(cwd, ".claude", "CLAUDE.md")),
    entry("Local memory", join(cwd, "CLAUDE.local.md")),
  ];
}
