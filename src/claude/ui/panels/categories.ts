import type { ContextUsage } from "../../protocol";

/*
 * Context-window categories and their colors (docs/claude-code.md, Design).
 * Matched on the category's stable `id`, never on the SDK's `color` names or
 * English labels. Shared by the Context panel's grid and legend; the context
 * strip can use it too.
 */

export type ContextCategory = ContextUsage["categories"][number];
export type CategoryId = NonNullable<ContextCategory["id"]>;

export type CategoryStyle = {
  /** A CSS color (a token variable). */
  color: string;
  /** Drawn hatched (the autocompact buffer). */
  hatched?: boolean;
  /** The free part of the window (drawn as the track). */
  free?: boolean;
};

const token = (name: string) => `var(--color-${name})`;

const STYLES: Record<CategoryId, CategoryStyle> = {
  system_prompt: { color: token("fg-faint") },
  // Fixed costs in greys, what the user controls (MCP, agents, memory, skills, messages) in color.
  system_tools: { color: token("fg-dim") },
  system_tools_deferred: { color: token("fg-dim") },
  mcp_tools: { color: token("ansi-cyan") },
  mcp_instructions: { color: token("ansi-cyan") },
  mcp_tools_deferred: { color: token("ansi-cyan") },
  custom_agents: { color: token("keyword") },
  memory_files: { color: token("type") },
  skills: { color: token("string") },
  messages: { color: token("accent") },
  autocompact_buffer: { color: token("fg-faint"), hatched: true },
  compact_buffer: { color: token("fg-faint"), hatched: true },
  free_space: { color: token("line"), free: true },
};

const UNKNOWN: CategoryStyle = { color: token("fg-dim") };

/** The style of a category, by id; by kind when the id is missing or new. */
export function categoryStyle(category: Pick<ContextCategory, "id" | "kind"> | undefined): CategoryStyle {
  if (!category) return UNKNOWN;
  if (category.id && category.id in STYLES) return STYLES[category.id];
  if (category.kind === "free") return STYLES.free_space;
  if (category.kind === "buffer") return STYLES.autocompact_buffer;
  return UNKNOWN;
}

/** Category name → category, for the grid's squares (which only carry the name). */
export function categoriesByName(context: ContextUsage): Map<string, ContextCategory> {
  return new Map(context.categories.map((category) => [category.name, category]));
}
