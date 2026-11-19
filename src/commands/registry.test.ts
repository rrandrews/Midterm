import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../settings/settings";
import { parseChord } from "./keys";
import { bindingsOf, commandForEvent, conflictsWith, registerCommands, runCommand, shortcutLabel } from "./registry";

const key = (code: string, mods: Partial<Record<"metaKey" | "shiftKey" | "altKey" | "ctrlKey", boolean>> = {}) =>
  ({ code, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...mods }) as KeyboardEvent;

describe("command registry", () => {
  let unregister = () => {};
  afterEach(() => {
    unregister();
    useSettings.getState().resetSettings();
  });

  it("matches events to enabled commands only", () => {
    const run = vi.fn();
    let enabled = false;
    unregister = registerCommands([
      { id: "t.a", title: "A", category: "App", keys: ["Cmd+Shift+K"], run, enabled: () => enabled },
    ]);
    expect(commandForEvent(key("KeyK", { metaKey: true, shiftKey: true }))).toBeUndefined();
    enabled = true;
    expect(commandForEvent(key("KeyK", { metaKey: true, shiftKey: true }))?.id).toBe("t.a");
    expect(commandForEvent(key("KeyK", { metaKey: true }))).toBeUndefined();
    expect(runCommand("t.a")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("applies overrides from the settings", () => {
    unregister = registerCommands([{ id: "t.b", title: "B", category: "App", keys: ["Cmd+J"], run: () => {} }]);
    expect(shortcutLabel("t.b")).toBe("⌘J");
    useSettings.getState().setKeybinding("t.b", ["Alt+Cmd+J"]);
    expect(bindingsOf("t.b")).toEqual(["Alt+Cmd+J"]);
    expect(commandForEvent(key("KeyJ", { metaKey: true }))).toBeUndefined();
    expect(commandForEvent(key("KeyJ", { metaKey: true, altKey: true }))?.id).toBe("t.b");
    useSettings.getState().setKeybinding("t.b", []);
    expect(shortcutLabel("t.b")).toBeUndefined();
  });

  it("reports conflicts", () => {
    unregister = registerCommands([
      { id: "t.c", title: "C", category: "App", keys: ["Cmd+Y"], run: () => {} },
      { id: "t.d", title: "D", category: "App", keys: ["Cmd+Y"], run: () => {} },
    ]);
    expect(conflictsWith(parseChord("Cmd+Y")!, "t.c").map((c) => c.id)).toEqual(["t.d"]);
  });
});
