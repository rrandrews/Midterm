import { describe, expect, it } from "vitest";
import "./core";
import { menuSpecs } from "./nativeMenu";

describe("menuSpecs", () => {
  it("builds submenus from registered commands with ⌘ accelerators only", () => {
    const specs = menuSpecs();
    const pane = specs.find((spec) => spec.title === "Pane");
    expect(pane?.items[0]).toEqual({
      type: "command",
      id: "pane.splitRight",
      title: "Split right",
      accelerator: "CmdOrCtrl+D",
    });
    const edit = specs.find((spec) => spec.title === "Edit");
    const goToLine = edit?.items.find((item) => item.type === "command" && item.id === "pane.goToLine");
    // ⌃G must keep reaching terminals.
    expect(goToLine).toMatchObject({ accelerator: null });
  });

  it("leaves out unregistered commands without doubled separators", () => {
    for (const spec of menuSpecs()) {
      spec.items.forEach((item, index) => {
        if (item.type === "separator") {
          expect(index).toBeGreaterThan(0);
          expect(spec.items[index + 1]?.type).not.toBe("separator");
        }
      });
      expect(spec.items[spec.items.length - 1]?.type).not.toBe("separator");
    }
  });
});
