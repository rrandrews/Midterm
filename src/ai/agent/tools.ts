import type { ToolDef } from "../../ipc/ai";
import type { RegisteredSkill } from "../../plugins/skills";
import type { SkillTool } from "../../plugins/types";

/*
 * The agent's toolset, built once per conversation from the enabled skills
 * (pure; see docs/ai.md "Agent"). Every enabled skill's tools are declared
 * up front, plus `load_skill`, and the system prompt lists the skills: the
 * system prompt and tool list must not change during a conversation, or
 * providers reject the replayed thinking of earlier turns.
 */

export const AGENT_SYSTEM_PROMPT = [
  "You are the agent inside Midterm, a terminal emulator with panes for terminals, a file explorer, an editor and a viewer.",
  "You act for the user through the tools you are given; never claim to have done something you did not do with a tool.",
  "Tools are grouped into skills. Before you first use a skill's tools, call load_skill to read its instructions.",
  "Tools marked \"Asks the user first\" wait for the user's permission. When the user denies an action, that is final: do not retry it or work around it, say what you would have done instead.",
  "The user's first message starts with a short context line saying which pane you are working with; tools act on that pane when no pane id is given.",
  "Be brief. Reply in Markdown; put commands and code in fenced blocks.",
].join("\n");

/** The name of the tool that returns a skill's instructions. */
export const LOAD_SKILL = "load_skill";

/** Longest tool name providers accept. */
const MAX_NAME = 64;

/** What a wire name stands for. */
export type ResolvedTool =
  | { kind: "load_skill" }
  | { kind: "tool"; skillId: string; skillTitle: string; toolName: string; effect: SkillTool["effect"] };

export type Toolset = {
  system: string;
  tools: ToolDef[];
  /** What a tool name the model called stands for; undefined for unknown names. */
  resolve(name: string): ResolvedTool | undefined;
  /** What `load_skill` returns for a skill id, or undefined for an unknown one. */
  loadSkill(skillId: string): { skill: string; title: string; instructions: string; tools: string[] } | undefined;
};

/** A provider-safe tool name: characters outside `[A-Za-z0-9_-]` become `_`, at most 64 long. */
export function wireName(pluginId: string, skillId: string, tool: string): string {
  return `${pluginId}__${skillId}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_NAME);
}

/** `name`, or `name` cut and suffixed (`_2`, `_3`…) until it is not in `taken`. */
function unique(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** One line per skill for the system prompt. */
function skillLine(skill: RegisteredSkill): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  return `- ${skill.id} — ${oneLine(skill.skill.title)}: ${oneLine(skill.skill.description)}`;
}

/**
 * The toolset for `skills`: only enabled ones, sorted by id so the same
 * skills always give the same system prompt and tools.
 */
export function buildToolset(skills: readonly RegisteredSkill[]): Toolset {
  const enabled = skills.filter((skill) => skill.enabled).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const taken = new Set<string>([LOAD_SKILL]);
  const byName = new Map<string, ResolvedTool>([[LOAD_SKILL, { kind: "load_skill" }]]);
  const namesOf = new Map<string, string[]>();
  const tools: ToolDef[] = [];

  for (const registered of enabled) {
    const { skill } = registered;
    const names: string[] = [];
    for (const tool of skill.tools ?? []) {
      const name = unique(wireName(registered.pluginId, skill.id, tool.name), taken);
      taken.add(name);
      names.push(name);
      byName.set(name, { kind: "tool", skillId: registered.id, skillTitle: skill.title, toolName: tool.name, effect: tool.effect });
      const asks = tool.effect === "write" ? " Asks the user first." : "";
      tools.push({ name, description: `[${skill.title}] ${tool.description}${asks}`, inputSchema: tool.inputSchema });
    }
    namesOf.set(registered.id, names);
  }

  const ids = enabled.map((skill) => skill.id);
  const loadSkill: ToolDef = {
    name: LOAD_SKILL,
    description: "Returns a skill's instructions and the names of its tools. Call it before first using a skill's tools.",
    inputSchema: {
      type: "object",
      properties: { skill: { type: "string", enum: ids, description: "The skill id, as listed in the system prompt" } },
      required: ["skill"],
      additionalProperties: false,
    },
  };

  const system = enabled.length
    ? `${AGENT_SYSTEM_PROMPT}\n\nSkills:\n${enabled.map(skillLine).join("\n")}`
    : `${AGENT_SYSTEM_PROMPT}\n\nNo skills are enabled, so there is nothing you can act on; say so if asked to act.`;

  return {
    system,
    tools: enabled.length ? [loadSkill, ...tools] : [],
    resolve: (name) => byName.get(name),
    loadSkill: (skillId) => {
      const registered = enabled.find((skill) => skill.id === skillId);
      if (!registered) return undefined;
      return {
        skill: registered.id,
        title: registered.skill.title,
        instructions: registered.skill.instructions ?? registered.skill.description,
        tools: namesOf.get(registered.id) ?? [],
      };
    },
  };
}
