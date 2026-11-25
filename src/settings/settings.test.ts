import { beforeEach, describe, expect, it } from "vitest";
import { deleteProfile } from "../ai/profiles";
import { DEFAULT_SETTINGS } from "./schema";
import { DEFAULT_SCOPE, getSettings, settingsFor, useSettings, workspaceSettings } from "./settings";

const store = () => useSettings.getState();

beforeEach(() => {
  useSettings.setState({ ...DEFAULT_SETTINGS, base: DEFAULT_SETTINGS, activeWorkspace: null });
});

describe("scoped settings", () => {
  it("writes a workspace's change as an override, seen only while it is active", () => {
    store().updateSettings({ fontSize: 16 }, "w1");
    expect(workspaceSettings("w1").overrides).toEqual({ fontSize: 16 });
    expect(getSettings().fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    store().setActiveWorkspace("w1");
    expect(getSettings().fontSize).toBe(16);
    expect(settingsFor(DEFAULT_SCOPE).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    store().setActiveWorkspace("w2");
    expect(getSettings().fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  it("without a scope, writes where the value comes from", () => {
    store().updateSettings({ fontSize: 16 }, "w1");
    store().setActiveWorkspace("w1");
    store().updateSettings({ fontSize: 18, accent: "#123456" });
    expect(workspaceSettings("w1").overrides).toEqual({ fontSize: 18 });
    expect(store().base.accent).toBe("#123456");
    expect(getSettings()).toMatchObject({ fontSize: 18, accent: "#123456" });
  });

  it("keeps shared settings shared, whatever the scope", () => {
    store().updateSettings({ keybindings: { "pane.close": [] } }, "w1");
    expect(store().base.keybindings).toEqual({ "pane.close": [] });
    expect(workspaceSettings("w1").overrides).toEqual({});
  });

  it("overrides single plugin settings and AI fields", () => {
    store().updatePluginSettings("terminal", { shell: "/bin/bash" }, "w1");
    store().updatePluginSettings("terminal", { bell: "off" }, DEFAULT_SCOPE);
    store().updateAi({ suggestions: false }, "w1");
    expect(settingsFor("w1").plugins.terminal.settings).toEqual({ shell: "/bin/bash", bell: "off" });
    expect(settingsFor("w1").ai.suggestions).toBe(false);
    expect(settingsFor(DEFAULT_SCOPE).ai.suggestions).toBe(true);
    store().clearOverride("w1", "plugins.terminal.settings.shell");
    expect(workspaceSettings("w1").overrides).toEqual({ ai: { suggestions: false } });
  });

  it("drops overrides that name a deleted model profile", () => {
    const profile = { id: "p-one", name: "One", provider: "openai", model: "m", baseUrl: "", cliPath: "" };
    store().updateAi({ profiles: [profile] });
    store().updateAi({ defaultProfile: "p-one" }, "w1");
    expect(workspaceSettings("w1").overrides.ai).toEqual({ defaultProfile: "p-one" });
    store().updateAi({ profiles: [] });
    expect(workspaceSettings("w1").overrides.ai).toBeUndefined();
  });

  it("deleting a workspace's model leaves the shared default alone", () => {
    const profile = (id: string) => ({ id, name: id, provider: "openai", model: "m", baseUrl: "", cliPath: "" });
    store().updateAi({ profiles: [profile("p-a"), profile("p-b"), profile("p-c")] });
    store().updateAi({ defaultProfile: "p-b" }, DEFAULT_SCOPE);
    store().updateAi({ defaultProfile: "p-c" }, "w1");
    store().setActiveWorkspace("w1");
    deleteProfile("p-c");
    expect(store().base.ai.defaultProfile).toBe("p-b");
    expect(getSettings().ai.defaultProfile).toBe("p-b");
    expect(workspaceSettings("w1").overrides.ai).toBeUndefined();
  });

  it("resets a workspace to the defaults but keeps its Python environment", () => {
    store().updateSettings({ fontSize: 16, python: { kind: "venv", target: "/v" } }, "w1");
    store().resetSettings("w1");
    expect(workspaceSettings("w1").overrides).toEqual({ python: { kind: "venv", target: "/v" } });
  });

  it("restoring all defaults keeps environment and workspaces", () => {
    store().updateEnvironment(DEFAULT_SCOPE, { env: [{ name: "A", value: "1" }], secrets: ["TOKEN"] });
    store().updateSettings({ fontSize: 20 });
    store().updateSettings({ accent: "#123456" }, "w1");
    store().resetSettings();
    expect(store().base.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(store().base.env).toEqual([{ name: "A", value: "1" }]);
    expect(store().base.secrets).toEqual(["TOKEN"]);
    expect(workspaceSettings("w1").overrides).toEqual({ accent: "#123456" });
  });

  it("keeps each workspace's environment and forgets a removed workspace", () => {
    store().updateEnvironment("w1", { env: [{ name: "A", value: "1" }, { name: "bad name", value: "" }] });
    expect(workspaceSettings("w1").env).toEqual([{ name: "A", value: "1" }]);
    expect(store().base.env).toEqual([]);
    store().removeWorkspaceSettings("w1");
    expect(store().base.workspaces).toEqual({});
  });

  it("gives React a stable object per scope", () => {
    store().updateSettings({ fontSize: 16 }, "w1");
    expect(settingsFor("w1")).toBe(settingsFor("w1"));
    expect(settingsFor(DEFAULT_SCOPE)).toBe(store().base);
  });
});
