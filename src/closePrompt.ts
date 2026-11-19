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
 * What closing would lose: `programs` still running in terminals, `files`
 * (names) with unsaved changes, and `other` sentences from plugins. `null`
 * if nothing.
 */
export function closePromptMessage(programs: string[], files: string[], other: string[] = []): string | null {
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
  const extra = other.map((sentence) => (/[.!?]$/.test(sentence) ? sentence : `${sentence}.`)).join(" ");
  if (!parts.length) return extra || null;
  const main = `${parts.join(", and ")}. Closing ${consequences.join(" and ")}.`;
  return extra ? `${main} ${extra}` : main;
}
