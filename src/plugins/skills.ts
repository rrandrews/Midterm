import { type Schema, Validator } from "@cfworker/json-schema";
import { getSettings, useSettings } from "../settings/settings";
import { apiOf, enabledPlugins, getPlugin, subscribePlugins } from "./registry";
import type { Skill, SkillTool } from "./types";

/*
 * The skill registry: the skills of every enabled plugin, under namespaced
 * ids (`<plugin>.<skill>`), each with its own on/off switch
 * (`settings.plugins[id].skills[skill]`, on unless set to false).
 *
 * The agent (src/ai/agent/) calls them. `invokeSkillTool` is the single
 * entry point: it validates the input against the tool's JSON Schema,
 * honours the switch, asks for confirmation before `write` tools (the
 * caller's `confirm`, else the hook set with `setWriteConfirmation`, else
 * refused), and turns failures into an error result instead of throwing
 * into the host. Skills that do not pass validation at
 * registration are left out and reported (`skillProblems`).
 */

export type RegisteredSkill = {
  /** `<plugin>.<skill>`. */
  id: string;
  pluginId: string;
  skill: Skill;
  enabled: boolean;
};

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Problems with a skill's declaration; empty when it can be registered. */
export function checkSkill(skill: unknown): string[] {
  if (typeof skill !== "object" || skill === null) return ["a skill must be an object"];
  const { id, title, description, instructions, tools } = skill as Record<string, unknown>;
  const problems: string[] = [];
  const name = typeof id === "string" ? id : "?";
  if (typeof id !== "string" || !SKILL_ID.test(id)) problems.push(`skill id "${String(id)}" must be lowercase letters, digits and -`);
  if (typeof title !== "string" || !title.trim()) problems.push(`skill ${name}: title is required`);
  if (typeof description !== "string" || !description.trim()) problems.push(`skill ${name}: description is required`);
  if (instructions !== undefined && typeof instructions !== "string") problems.push(`skill ${name}: instructions must be a string`);
  if (tools !== undefined && !Array.isArray(tools)) problems.push(`skill ${name}: tools must be an array`);
  if (Array.isArray(tools)) {
    const names = new Set<string>();
    for (const tool of tools) {
      for (const problem of checkTool(tool)) problems.push(`skill ${name}: ${problem}`);
      const toolName = (tool as SkillTool | null)?.name;
      if (typeof toolName === "string") {
        if (names.has(toolName)) problems.push(`skill ${name}: tool "${toolName}" is declared twice`);
        names.add(toolName);
      }
    }
  }
  if (tools === undefined && instructions === undefined) problems.push(`skill ${name}: needs instructions or tools`);
  return problems;
}

function checkTool(tool: unknown): string[] {
  if (typeof tool !== "object" || tool === null) return ["a tool must be an object"];
  const { name, description, inputSchema, effect, run } = tool as Record<string, unknown>;
  const label = typeof name === "string" ? name : "?";
  const problems: string[] = [];
  if (typeof name !== "string" || !TOOL_NAME.test(name)) problems.push(`tool name "${String(name)}" must be letters, digits, _ and -`);
  if (typeof description !== "string" || !description.trim()) problems.push(`tool ${label}: description is required`);
  if (effect !== "read" && effect !== "write") problems.push(`tool ${label}: effect must be "read" or "write"`);
  if (typeof run !== "function") problems.push(`tool ${label}: run must be a function`);
  problems.push(...checkSchema(inputSchema).map((problem) => `tool ${label}: ${problem}`));
  return problems;
}

/** Problems with a tool's input schema: it must be an object schema the validator accepts. */
export function checkSchema(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return ["inputSchema must be a JSON Schema object"];
  if ((schema as Record<string, unknown>).type !== "object") return ['inputSchema must have type "object"'];
  try {
    // Compiling dereferences the schema and catches broken $refs; validating `{}` exercises its keywords.
    new Validator(schema as Schema, "2020-12").validate({});
  } catch (error) {
    return [`inputSchema is not usable: ${error instanceof Error ? error.message : String(error)}`];
  }
  return [];
}

/** The input's problems against a schema, as readable lines; empty when valid. */
export function validateInput(schema: Record<string, unknown>, input: unknown): string[] {
  const result = new Validator(schema as Schema, "2020-12", false).validate(input);
  if (result.valid) return [];
  // The innermost errors say what is wrong; the outer ones repeat it.
  const errors = result.errors.filter((error) => !/^(properties|allOf|anyOf|oneOf|\$ref|items)$/.test(error.keyword));
  return (errors.length ? errors : result.errors).map((error) => `${error.instanceLocation}: ${error.error}`);
}

/** Whether a value survives JSON unchanged: plain objects, arrays, strings, finite numbers, booleans and null (`undefined` counts as null). */
export function isJsonSerializable(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const ok = Object.values(value).every((item) => item !== undefined && isJsonSerializable(item, seen));
  seen.delete(value);
  return ok;
}

function isSkillEnabled(pluginId: string, skillId: string): boolean {
  return getSettings().plugins[pluginId]?.skills?.[skillId] !== false;
}

/** Extra skills of a plugin besides `plugin.skills` (guidance-only skills from an imported plugin's SKILL.md files). */
const extraSkills = new Map<string, Skill[]>();

export function setFileSkills(pluginId: string, skills: Skill[]): void {
  if (skills.length) extraSkills.set(pluginId, skills);
  else extraSkills.delete(pluginId);
  rebuild();
}

let skills = new Map<string, RegisteredSkill>();
let problems = new Map<string, string[]>();
const listeners = new Set<() => void>();
let version = 0;

/** Changes whenever the skills or their switches change (for `useSyncExternalStore`). */
export function skillsVersion(): number {
  return version;
}

/** The skills a plugin declares (code and files), valid or not. */
export function declaredSkills(pluginId: string): Skill[] {
  const plugin = getPlugin(pluginId)?.plugin;
  return [...(plugin?.skills ?? []), ...(extraSkills.get(pluginId) ?? [])];
}

function rebuild(): void {
  const next = new Map<string, RegisteredSkill>();
  const nextProblems = new Map<string, string[]>();
  for (const plugin of enabledPlugins()) {
    const found: string[] = [];
    for (const skill of declaredSkills(plugin.id)) {
      const issues = checkSkill(skill);
      const id = `${plugin.id}.${skill?.id}`;
      if (!issues.length && next.has(id)) issues.push(`skill ${skill.id} is declared twice`);
      if (issues.length) {
        found.push(...issues);
        continue;
      }
      next.set(id, { id, pluginId: plugin.id, skill, enabled: isSkillEnabled(plugin.id, skill.id) });
    }
    if (found.length) {
      nextProblems.set(plugin.id, found);
      console.warn(`Skills of the ${plugin.id} plugin were left out:`, found);
    }
  }
  skills = next;
  problems = nextProblems;
  version += 1;
  for (const listener of listeners) listener();
}

/** Every skill of every enabled plugin, enabled or switched off. */
export function allSkills(): RegisteredSkill[] {
  return [...skills.values()];
}

export function getSkill(id: string): RegisteredSkill | undefined {
  return skills.get(id);
}

/** Why some of a plugin's skills were left out. */
export function skillProblems(pluginId: string): string[] {
  return problems.get(pluginId) ?? [];
}

export function subscribeSkills(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSkillEnabled(pluginId: string, skillId: string, enabled: boolean): void {
  const { plugins, updatePluginEntry } = useSettings.getState();
  updatePluginEntry(pluginId, { skills: { ...plugins[pluginId]?.skills, [skillId]: enabled } });
}

export type WriteConfirmation = (request: { skill: RegisteredSkill; tool: SkillTool; input: unknown }) => Promise<boolean>;

/**
 * Asked before a `write` tool runs when the caller passes no `confirm` of
 * its own. None is installed by default, so such calls are refused.
 */
let confirmWrite: WriteConfirmation | null = null;

export function setWriteConfirmation(handler: WriteConfirmation | null): void {
  confirmWrite = handler;
}

/**
 * Runs a skill's tool: the only way anything should call one. Never throws.
 * `confirm` asks the user before a `write` tool and takes precedence over
 * the hook set with `setWriteConfirmation`; with neither, write tools are
 * refused.
 */
export async function invokeSkillTool(
  skillId: string,
  toolName: string,
  input: unknown,
  options: { paneId?: string; signal?: AbortSignal; confirm?: WriteConfirmation } = {},
): Promise<ToolResult> {
  const skill = skills.get(skillId);
  if (!skill) return { ok: false, error: `No skill "${skillId}" (its plugin may be disabled)` };
  if (!skill.enabled) return { ok: false, error: `The skill "${skillId}" is switched off` };
  const tool = skill.skill.tools?.find((candidate) => candidate.name === toolName);
  if (!tool) return { ok: false, error: `The skill "${skillId}" has no tool "${toolName}"` };
  let invalid: string[];
  try {
    invalid = validateInput(tool.inputSchema, input);
  } catch (error) {
    return { ok: false, error: `The tool's input schema failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (invalid.length) return { ok: false, error: `Invalid input: ${invalid.join("; ")}` };
  if (tool.effect === "write") {
    const ask = options.confirm ?? confirmWrite;
    const allowed = ask ? await ask({ skill, tool, input }).catch(() => false) : false;
    if (!allowed) return { ok: false, error: "The user did not allow this action" };
  }
  if (options.signal?.aborted) return { ok: false, error: "Cancelled" };
  if (tool.effect === "write") {
    // The skill or its plugin may have been switched off while the user was asked.
    const live = skills.get(skillId);
    if (!live?.enabled || !live.skill.tools?.includes(tool)) return { ok: false, error: `The skill "${skillId}" is switched off` };
  }
  const api = apiOf(skill.pluginId);
  if (!api) return { ok: false, error: "The plugin host is not ready" };
  try {
    const result = await tool.run(input, { api, paneId: options.paneId, signal: options.signal });
    if (!isJsonSerializable(result)) return { ok: false, error: "The tool returned a result that is not JSON" };
    return { ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

subscribePlugins(rebuild);
let lastSwitches = JSON.stringify(Object.entries(getSettings().plugins).map(([id, entry]) => [id, entry.skills]));
useSettings.subscribe((state) => {
  const switches = JSON.stringify(Object.entries(state.plugins).map(([id, entry]) => [id, entry.skills]));
  if (switches === lastSwitches) return;
  lastSwitches = switches;
  rebuild();
});
