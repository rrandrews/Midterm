import { afterEach, describe, expect, it } from "vitest";
import { changeSettingsDialog, closeSettings, guardSettingsLeave, openSettings, setSettingsScope, useSettingsDialog } from "./dialogState";

let unguard: (() => void) | undefined;

afterEach(() => {
  unguard?.();
  unguard = undefined;
  useSettingsDialog.setState({ open: false, section: "general", scope: "default" });
});

describe("leaving a guarded section", () => {
  it("asks before another section, another scope or closing, and stays when declined", async () => {
    openSettings("theme-editor");
    let asked = 0;
    unguard = guardSettingsLeave(() => {
      asked += 1;
      return Promise.resolve(false);
    });
    expect(await changeSettingsDialog({ section: "appearance" })).toBe(false);
    setSettingsScope("ws-1");
    closeSettings();
    await Promise.resolve();
    expect(asked).toBe(3);
    expect(useSettingsDialog.getState()).toMatchObject({ open: true, section: "theme-editor", scope: "default" });
  });

  it("goes when the guard agrees, and does not ask when staying", async () => {
    openSettings("theme-editor");
    let asked = 0;
    unguard = guardSettingsLeave(() => {
      asked += 1;
      return true;
    });
    openSettings("theme-editor");
    expect(asked).toBe(0);
    closeSettings();
    expect(asked).toBe(1);
    expect(useSettingsDialog.getState().open).toBe(false);
    // A closed dialog opens without asking.
    openSettings("general");
    expect(asked).toBe(1);
    expect(useSettingsDialog.getState()).toMatchObject({ open: true, section: "general" });
  });
});
