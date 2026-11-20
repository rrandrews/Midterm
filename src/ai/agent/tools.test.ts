import { describe, expect, it } from "vitest";
import type { RegisteredSkill } from "../../plugins/skills";
import type { Skill, SkillTool } from "../../plugins/types";
import { ACP_MAX_NAME, ACP_PROMPT_LINE, AGENT_SYSTEM_PROMPT, LOAD_SKILL, buildToolset, wireName } from "./tools";

const tool = (name: string, effect: SkillTool["effect"] = "read"): SkillTool => ({
  name,
  description: `Does ${name}.`,
  effect,
  inputSchema: { type: "object" },
  run: async () => null,
});

const registered = (pluginId: string, skill: Partial<Skill> & { id: string }, enabled = true): RegisteredSkill => ({
  id: `${pluginId}.${skill.id}`,
  pluginId,
  enabled,
  skill: { title: skill.id.toUpperCase(), description: `About ${skill.id}.`, ...skill },
});

describe("buildToolset", () => {
  it("names tools <plugin>__<skill>__<tool>, provider-safe", () => {
    expect(wireName("terminal", "commands", "run_command")).toBe("terminal__commands__run_command");
    expect(wireName("my.plugin", "a b", "x")).toBe("my_plugin__a_b__x");
    expect(wireName("p".repeat(40), "s".repeat(40), "t")).toHaveLength(64);
  });

  it("declares every enabled skill's tools, with load_skill first", () => {
    const set = buildToolset([
      registered("terminal", { id: "commands", tools: [tool("recent_blocks"), tool("run_command", "write")] }),
      registered("editor", { id: "edit", tools: [tool("save", "write")] }, false),
    ]);
    expect(set.tools.map((t) => t.name)).toEqual([LOAD_SKILL, "terminal__commands__recent_blocks", "terminal__commands__run_command"]);
    expect(set.tools[1].description).toBe("[COMMANDS] Does recent_blocks.");
    expect(set.tools[2].description).toBe("[COMMANDS] Does run_command. Asks the user first.");
    expect(set.resolve("terminal__commands__run_command")).toEqual({
      kind: "tool",
      skillId: "terminal.commands",
      skillTitle: "COMMANDS",
      toolName: "run_command",
      effect: "write",
    });
    expect(set.resolve("editor__edit__save")).toBeUndefined();
    expect(set.resolve(LOAD_SKILL)).toEqual({ kind: "load_skill" });
    expect((set.tools[0].inputSchema.properties as { skill: { enum: string[] } }).skill.enum).toEqual(["terminal.commands"]);
  });

  it("suffixes names that collide after cutting to 64", () => {
    const long = "x".repeat(70);
    const set = buildToolset([registered("p", { id: "s", tools: [tool(`${long}a`), tool(`${long}b`), tool(`${long}c`)] })]);
    const names = set.tools.slice(1).map((t) => t.name);
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
    expect(names[1].endsWith("_2")).toBe(true);
    expect(names[2].endsWith("_3")).toBe(true);
    expect(set.resolve(names[2])).toMatchObject({ toolName: `${long}c` });
  });

  it("gives a deterministic system prompt listing skills sorted by id", () => {
    const a = registered("b-plugin", { id: "two", description: "Second\n  thing." , tools: [tool("t")] });
    const b = registered("a-plugin", { id: "one", instructions: "Read me." });
    const one = buildToolset([a, b]);
    const two = buildToolset([b, a]);
    expect(one.system).toBe(two.system);
    expect(JSON.stringify(one.tools)).toBe(JSON.stringify(two.tools));
    expect(one.system.startsWith(AGENT_SYSTEM_PROMPT)).toBe(true);
    expect(one.system).toContain("- a-plugin.one — ONE: About one.\n- b-plugin.two — TWO: Second thing.");
  });

  it("loads guidance-only skills too, and only enabled ones", () => {
    const set = buildToolset([
      registered("a", { id: "notes", instructions: "Read the notes." }),
      registered("b", { id: "off", instructions: "x" }, false),
      registered("c", { id: "tools", tools: [tool("go")] }),
    ]);
    expect(set.loadSkill("a.notes")).toEqual({ skill: "a.notes", title: "NOTES", instructions: "Read the notes.", tools: [] });
    expect(set.loadSkill("c.tools")).toEqual({ skill: "c.tools", title: "TOOLS", instructions: "About tools.", tools: ["c__tools__go"] });
    expect(set.loadSkill("b.off")).toBeUndefined();
  });

  it("has an ACP variant: names capped for the CLI's MCP prefix, and a line about that prefix", () => {
    const skills = [registered("p".repeat(40), { id: "s".repeat(40), tools: [tool("a"), tool("b")] })];
    const api = buildToolset(skills);
    const acp = buildToolset(skills, { acp: true });
    expect(api.system).not.toContain(ACP_PROMPT_LINE);
    expect(acp.system.startsWith(`${AGENT_SYSTEM_PROMPT}\n${ACP_PROMPT_LINE}\n\nSkills:`)).toBe(true);
    const names = acp.tools.slice(1).map((t) => t.name);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(ACP_MAX_NAME);
    // Claude Code's limit is 128 including "mcp__midterm__".
    for (const name of names) expect(`mcp__midterm__${name}`.length).toBeLessThanOrEqual(128);
    expect(acp.resolve(names[1])).toMatchObject({ toolName: "b" });
  });

  it("declares no tools when no skill is enabled", () => {
    const set = buildToolset([registered("a", { id: "x", tools: [tool("t")] }, false)]);
    expect(set.tools).toEqual([]);
    expect(set.system).toContain("No skills are enabled");
  });
});
