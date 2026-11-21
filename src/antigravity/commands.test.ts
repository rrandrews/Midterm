import { describe, expect, it } from "vitest";
import { commandList, findPaneCommand, rememberCommands } from "./commands";

describe("antigravity commands", () => {
  it("resolves built-in commands and aliases", () => {
    expect(findPaneCommand("/new")?.command.name).toBe("new");
    expect(findPaneCommand("/clear")?.command.name).toBe("new");
    expect(findPaneCommand("/plan fix the tests")).toMatchObject({
      command: { name: "plan" },
      args: "fix the tests",
    });
    expect(findPaneCommand("/resume")?.command.name).toBe("history");
    expect(findPaneCommand("/unknown")).toBeUndefined();
  });

  it("merges agent commands without duplicating pane commands or showing internal __ commands", () => {
    rememberCommands("/repo-test", [
      { name: "review", description: "Review code" },
      { name: "plan", description: "Shadowed by pane /plan" },
      { name: "__internal", description: "Hidden" },
    ]);
    const list = commandList({ availableCommands: [], cwd: "/repo-test" });
    const names = list.map((c) => c.name);
    expect(names).toContain("new");
    expect(names).toContain("review");
    expect(names).not.toContain("__internal");
    expect(names.filter((n) => n === "plan")).toHaveLength(1);
  });
});
