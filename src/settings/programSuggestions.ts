import { commandPrograms } from "../terminal/fullPane";

/*
 * Suggestions for a program-list setting (the `programs` field): programs
 * from the command history, most recent first, then well-known TUIs. Pure;
 * unit-tested.
 */

/** Interactive programs that draw inline (no alternate screen), offered even before they were run here. */
export const KNOWN_TUIS = ["agy", "claude", "codex", "gemini", "opencode", "aider", "copilot", "cursor-agent"] as const;

/** Builtins and one-shot tools that never belong in such a list; not offered unless typed. */
const NOISE = new Set([
  ".", "alias", "bg", "cat", "cd", "clear", "cp", "echo", "exit", "export", "fg", "grep", "history", "jobs", "kill",
  "la", "ll", "ls", "mkdir", "mv", "open", "popd", "pushd", "pwd", "rm", "rmdir", "source", "touch", "true", "false",
  "type", "unset", "which",
]);

export type ProgramSuggestion = { name: string; source: "history" | "known" };

/**
 * Up to `limit` suggestions for `query` (prefix matches first, then
 * substring), leaving out the programs already in `taken`. `history` is
 * oldest first.
 */
export function programSuggestions(
  history: readonly string[],
  query: string,
  taken: readonly string[],
  limit = 8,
): ProgramSuggestion[] {
  const q = query.trim().toLowerCase();
  const excluded = new Set(taken.map((name) => name.toLowerCase()));
  const seen = new Set<string>();
  const all: ProgramSuggestion[] = [];
  const add = (name: string, source: ProgramSuggestion["source"]) => {
    const key = name.toLowerCase();
    if (seen.has(key) || excluded.has(key)) return;
    seen.add(key);
    all.push({ name, source });
  };
  for (let i = history.length - 1; i >= 0; i--) {
    for (const program of commandPrograms(history[i])) {
      // Paths and odd tokens (`./run.sh`, `$EDITOR`, `(cd`) are not program names to list.
      if (!/^[\w][\w.+-]*$/.test(program)) continue;
      if (!q && NOISE.has(program)) continue;
      add(program, "history");
    }
  }
  for (const name of KNOWN_TUIS) add(name, "known");
  if (!q) {
    // Nothing typed: the known TUIs first (those run here before the others), then the rest of the history.
    const known = new Set<string>(KNOWN_TUIS);
    return [...all.filter(({ name }) => known.has(name)), ...all.filter(({ name }) => !known.has(name))].slice(0, limit);
  }
  const prefix = all.filter(({ name }) => name.toLowerCase().startsWith(q));
  const inner = all.filter(({ name }) => !name.toLowerCase().startsWith(q) && name.toLowerCase().includes(q));
  return [...prefix, ...inner].slice(0, limit);
}
