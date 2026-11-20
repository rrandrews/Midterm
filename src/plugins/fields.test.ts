import { describe, expect, it } from "vitest";
import { checkFields, resolveFields, type SettingField } from "./fields";
import { parseSkillFile } from "./skillFiles";
import { checkPluginExport } from "./loader";

const fields: SettingField[] = [
  { key: "on", type: "toggle", label: "On", default: true },
  { key: "mode", type: "select", label: "Mode", options: ["a", { value: "b", label: "Bee" }], default: "a" },
  { key: "size", type: "number", label: "Size", min: 1, max: 10, integer: true, default: 4 },
  { key: "name", type: "text", label: "Name", default: "" },
  { key: "args", type: "list", label: "Args", default: [] },
  { key: "tint", type: "color", label: "Tint", default: "#112233" },
];

describe("resolveFields", () => {
  it("keeps valid values, repairs the rest and drops unknown keys", () => {
    expect(resolveFields(fields, { on: false, mode: "b", size: 99.6, name: "  x ", args: ["-l", 3], tint: "red", junk: 1 })).toEqual({
      on: false,
      mode: "b",
      size: 10,
      name: "x",
      args: ["-l"],
      tint: "#112233",
    });
    expect(resolveFields(fields, "nope")).toEqual({ on: true, mode: "a", size: 4, name: "", args: [], tint: "#112233" });
  });

  it("checks declarations from imported plugins", () => {
    expect(checkFields(fields)).toEqual([]);
    expect(checkFields([{ key: "a", type: "toggle", label: "A", default: "yes" }])).toHaveLength(1);
    expect(checkFields([{ key: "a", type: "slider", label: "A" }])).toHaveLength(1);
    expect(checkFields("x")).toHaveLength(1);
  });
});

describe("parseSkillFile", () => {
  it("reads front matter and instructions", () => {
    const skill = parseSkillFile("skills/notes/SKILL.md", '---\ntitle: Notes\ndescription: "When to read notes."\n---\n\nRead them.\n');
    expect(skill).toEqual({ id: "notes", title: "Notes", description: "When to read notes.", instructions: "Read them." });
  });

  it("explains what is wrong", () => {
    expect(parseSkillFile("README.md", "")).toMatch(/expected skills/);
    expect(parseSkillFile("skills/a/SKILL.md", "no front matter")).toMatch(/front matter/);
    expect(parseSkillFile("skills/a/SKILL.md", "---\ntitle: A\n---\n")).toMatch(/description/);
  });
});

describe("checkPluginExport", () => {
  it("requires a matching id, a name and something to render", () => {
    expect(checkPluginExport({ id: "x", name: "X", pane: { mount: () => {} } }, "x")).toEqual([]);
    expect(checkPluginExport({ id: "y", name: "X", pane: {} }, "x")).toHaveLength(2);
    expect(checkPluginExport(undefined, "x")).toHaveLength(1);
    expect(checkPluginExport({ id: "x", name: "X", pane: { mount: () => {} }, terminal: true }, "x")).toEqual([]);
    expect(checkPluginExport({ id: "x", name: "X", pane: { mount: () => {} }, terminal: "yes" }, "x")).toHaveLength(1);
  });
});
