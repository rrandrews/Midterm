import { afterEach, describe, expect, it } from "vitest";
import { useSettings } from "../settings/settings";
import type { MidtermApi } from "./api";
import { installPluginHost, registerPlugin } from "./registry";
import {
  allSkills,
  checkSchema,
  checkSkill,
  invokeSkillTool,
  isJsonSerializable,
  setSkillEnabled,
  setWriteConfirmation,
  skillProblems,
} from "./skills";
import type { PanePlugin, Skill } from "./types";

installPluginHost((pluginId) => ({ pluginId }) as unknown as MidtermApi);

const echo: Skill = {
  id: "echo",
  title: "Echo",
  description: "Repeats things.",
  tools: [
    {
      name: "say",
      description: "Says it back.",
      effect: "read",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      run: async (input) => ({ said: (input as { text: string }).text }),
    },
    {
      name: "shout",
      description: "Writes it.",
      effect: "write",
      inputSchema: { type: "object" },
      run: async () => "ok",
    },
    { name: "fail", description: "Fails.", effect: "read", inputSchema: { type: "object" }, run: async () => Promise.reject(new Error("nope")) },
    { name: "weird", description: "Returns a function.", effect: "read", inputSchema: { type: "object" }, run: async () => () => 1 },
  ],
};

function withSkills(id: string, skills: Skill[]): void {
  const plugin: PanePlugin = { id, name: id, pane: { mount: () => () => {} }, skills };
  cleanups.push(registerPlugin(plugin));
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useSettings.getState().updateSettings({ plugins: {} });
  setWriteConfirmation(null);
});

describe("skill declarations", () => {
  it("accepts a good skill and reports problems with bad ones", () => {
    expect(checkSkill(echo)).toEqual([]);
    expect(checkSkill({ id: "Bad", title: "", description: "x" }).length).toBeGreaterThan(1);
    expect(checkSkill({ id: "x", title: "X", description: "d" })).toContain("skill x: needs instructions or tools");
    const dup = { ...echo, tools: [echo.tools![0], echo.tools![0]] };
    expect(checkSkill(dup)).toContain('skill echo: tool "say" is declared twice');
  });

  it("checks input schemas", () => {
    expect(checkSchema({ type: "object" })).toEqual([]);
    expect(checkSchema({ type: "string" })).toEqual(['inputSchema must have type "object"']);
    expect(checkSchema(null)).toHaveLength(1);
  });

  it("knows what is JSON", () => {
    expect(isJsonSerializable({ a: [1, "b", null, true] })).toBe(true);
    expect(isJsonSerializable(Number.NaN)).toBe(false);
    expect(isJsonSerializable({ f: () => 1 })).toBe(false);
    expect(isJsonSerializable(new Date())).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonSerializable(cyclic)).toBe(false);
  });
});

describe("skill registry", () => {
  it("namespaces skills and leaves invalid ones out with a reason", () => {
    withSkills("eko", [echo, { id: "broken", title: "", description: "" } as Skill]);
    expect(allSkills().map((skill) => skill.id)).toContain("eko.echo");
    expect(allSkills().map((skill) => skill.id)).not.toContain("eko.broken");
    expect(skillProblems("eko").length).toBeGreaterThan(0);
  });

  it("drops the skills of a disabled plugin", () => {
    withSkills("eko", [echo]);
    useSettings.getState().updatePluginEntry("eko", { enabled: false });
    expect(allSkills().some((skill) => skill.pluginId === "eko")).toBe(false);
  });
});

describe("invokeSkillTool", () => {
  it("validates input, runs the tool and returns its result", async () => {
    withSkills("eko", [echo]);
    expect(await invokeSkillTool("eko.echo", "say", { text: "hi" })).toEqual({ ok: true, result: { said: "hi" } });
    const invalid = await invokeSkillTool("eko.echo", "say", { text: 3 });
    expect(invalid.ok).toBe(false);
  });

  it("refuses unknown skills and tools, and switched-off skills", async () => {
    withSkills("eko", [echo]);
    expect((await invokeSkillTool("eko.nope", "say", {})).ok).toBe(false);
    expect((await invokeSkillTool("eko.echo", "nope", {})).ok).toBe(false);
    setSkillEnabled("eko", "echo", false);
    expect(await invokeSkillTool("eko.echo", "say", { text: "hi" })).toEqual({
      ok: false,
      error: 'The skill "eko.echo" is switched off',
    });
  });

  it("asks before write tools, and refuses them without a confirmation hook", async () => {
    withSkills("eko", [echo]);
    expect((await invokeSkillTool("eko.echo", "shout", {})).ok).toBe(false);
    setWriteConfirmation(async () => true);
    expect(await invokeSkillTool("eko.echo", "shout", {})).toEqual({ ok: true, result: "ok" });
    setWriteConfirmation(async () => false);
    expect((await invokeSkillTool("eko.echo", "shout", {})).ok).toBe(false);
  });

  it("takes the caller's confirm over the hook, and never asks for read tools", async () => {
    withSkills("eko", [echo]);
    setWriteConfirmation(async () => false);
    const asked: string[] = [];
    const confirm = async ({ skill, tool, input }: { skill: { id: string }; tool: { name: string }; input: unknown }) => {
      asked.push(`${skill.id}/${tool.name}/${JSON.stringify(input)}`);
      return true;
    };
    expect(await invokeSkillTool("eko.echo", "shout", { a: 1 }, { confirm })).toEqual({ ok: true, result: "ok" });
    expect(asked).toEqual(['eko.echo/shout/{"a":1}']);
    expect(await invokeSkillTool("eko.echo", "say", { text: "hi" }, { confirm })).toEqual({ ok: true, result: { said: "hi" } });
    expect(asked).toHaveLength(1);
    expect((await invokeSkillTool("eko.echo", "shout", {}, { confirm: async () => false })).ok).toBe(false);
    // A confirm that throws counts as a no.
    expect((await invokeSkillTool("eko.echo", "shout", {}, { confirm: () => Promise.reject(new Error("x")) })).ok).toBe(false);
    setWriteConfirmation(null);
    expect((await invokeSkillTool("eko.echo", "shout", {})).ok).toBe(false);
  });

  it("does not run a write tool whose skill was switched off while the user was asked", async () => {
    withSkills("eko", [echo]);
    const confirm = async () => {
      setSkillEnabled("eko", "echo", false);
      return true;
    };
    expect(await invokeSkillTool("eko.echo", "shout", {}, { confirm })).toEqual({ ok: false, error: 'The skill "eko.echo" is switched off' });
  });

  it("turns failures and non-JSON results into errors", async () => {
    withSkills("eko", [echo]);
    expect(await invokeSkillTool("eko.echo", "fail", {})).toEqual({ ok: false, error: "nope" });
    expect((await invokeSkillTool("eko.echo", "weird", {})).ok).toBe(false);
  });
});
