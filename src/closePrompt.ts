/*
 * The question asked before closing panes that have programs running or
 * unsaved changes (src/closing.ts). Pure; unit-tested.
 */

function list(names: string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * What closing would lose: `programs` still running in terminals and
 * `files` (names) with unsaved changes. `null` if nothing.
 */
export function closePromptMessage(programs: string[], files: string[]): string | null {
  const parts: string[] = [];
  const consequences: string[] = [];
  if (programs.length) {
    parts.push(`${list(programs)} ${programs.length === 1 ? "is" : "are"} still running`);
    consequences.push(`ends ${programs.length === 1 ? "it" : "them"}`);
  }
  if (files.length) {
    parts.push(`${list(files)} ${files.length === 1 ? "has" : "have"} unsaved changes`);
    consequences.push(programs.length ? "discards the changes" : "discards them");
  }
  if (!parts.length) return null;
  return `${parts.join(", and ")}. Closing ${consequences.join(" and ")}.`;
}
