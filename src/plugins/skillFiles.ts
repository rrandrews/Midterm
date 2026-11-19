import type { Skill } from "./types";

/*
 * Guidance-only skills shipped as files: `skills/<id>/SKILL.md`, with front
 * matter giving `title` and `description` and the body as instructions.
 * Pure; unit-tested.
 */

/** A skill from a SKILL.md file at `path` (`skills/<id>/SKILL.md`), or a reason it is unusable. */
export function parseSkillFile(path: string, content: string): Skill | string {
  const id = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1] ?? /([^/]+)\/SKILL\.md$/.exec(path)?.[1];
  if (!id) return `${path}: expected skills/<id>/SKILL.md`;
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return `${path}: missing front matter (--- title / description ---)`;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    fields[field[1]] = value;
  }
  if (!fields.title) return `${path}: front matter has no title`;
  if (!fields.description) return `${path}: front matter has no description`;
  const instructions = match[2].trim();
  return { id, title: fields.title, description: fields.description, ...(instructions && { instructions }) };
}
