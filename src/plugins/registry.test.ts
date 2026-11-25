import { afterEach, describe, expect, it } from "vitest";
import { getCommand } from "../commands/registry";
import { useSettings } from "../settings/settings";
import type { MidtermApi } from "./api";
import { activePlugin, enabledPlugins, getPlugin, installPluginHost, isPluginEnabled, registerPlugin } from "./registry";
import { pluginSettings } from "./settings";
import type { PanePlugin } from "./types";

const fakeApi = (pluginId: string) => ({ pluginId }) as unknown as MidtermApi;
installPluginHost(fakeApi);

function plugin(id: string, extra: Partial<PanePlugin> = {}): PanePlugin {
  return { id, name: id, pane: { mount: () => () => {} }, ...extra };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useSettings.getState().resetSettings();
  useSettings.getState().updateSettings({ plugins: {} });
});

describe("plugin registry", () => {
  it("registers, looks up and unregisters", () => {
    const unregister = registerPlugin(plugin("alpha"));
    expect(getPlugin("alpha")?.plugin.name).toBe("alpha");
    expect(activePlugin("alpha")).toBeDefined();
    unregister();
    expect(getPlugin("alpha")).toBeUndefined();
  });

  it("rejects ids that are not pane kinds", () => {
    expect(() => registerPlugin(plugin("Bad Id"))).toThrow();
  });

  it("follows the enabled flag in the settings, except for required plugins", () => {
    cleanups.push(registerPlugin(plugin("beta")), registerPlugin(plugin("core", { required: true })));
    useSettings.getState().updatePluginEntry("beta", { enabled: false });
    useSettings.getState().updatePluginEntry("core", { enabled: false });
    expect(isPluginEnabled("beta")).toBe(false);
    expect(activePlugin("beta")).toBeUndefined();
    expect(isPluginEnabled("core")).toBe(true);
    expect(enabledPlugins().map((p) => p.id)).toContain("core");
  });

  it("activates while enabled: commands registered, activate called and cleaned up", () => {
    const calls: string[] = [];
    cleanups.push(
      registerPlugin(
        plugin("gamma", {
          commands: [{ id: "gamma.hello", title: "Hello", category: "Gamma", run: () => {} }],
          activate: (api) => {
            calls.push(`on:${api.pluginId}`);
            return () => calls.push("off");
          },
        }),
      ),
    );
    expect(calls).toEqual(["on:gamma"]);
    expect(getCommand("gamma.hello")).toBeDefined();
    useSettings.getState().updatePluginEntry("gamma", { enabled: false });
    expect(calls).toEqual(["on:gamma", "off"]);
    expect(getCommand("gamma.hello")).toBeUndefined();
    useSettings.getState().updatePluginEntry("gamma", { enabled: true });
    expect(calls).toEqual(["on:gamma", "off", "on:gamma"]);
  });

  it("does not let a plugin take over an existing command id", () => {
    cleanups.push(registerPlugin(plugin("owner", { commands: [{ id: "shared.cmd", title: "Original", category: "X", run: () => {} }] })));
    cleanups.push(registerPlugin(plugin("thief", { commands: [{ id: "shared.cmd", title: "Stolen", category: "X", run: () => {} }] })));
    expect(getCommand("shared.cmd")?.title).toBe("Original");
    useSettings.getState().updatePluginEntry("thief", { enabled: false });
    expect(getCommand("shared.cmd")?.title).toBe("Original");
  });

  it("never offers an imported plugin's stub for new panes", () => {
    cleanups.push(registerPlugin(plugin("stubby", { pane: {} }), { type: "imported", dir: "/x", stub: true }));
    expect(getPlugin("stubby")).toBeDefined();
    expect(activePlugin("stubby")).toBeUndefined();
    expect(enabledPlugins().map((p) => p.id)).not.toContain("stubby");
  });

  it("gives a stable settings object for a plugin without fields", () => {
    cleanups.push(registerPlugin(plugin("plain")));
    useSettings.getState().updatePluginSettings("plain", { a: 1 });
    expect(pluginSettings("plain")).toBe(pluginSettings("plain"));
    expect(pluginSettings("plain")).toEqual({ a: 1 });
  });

  it("records a failing activate instead of throwing", () => {
    cleanups.push(
      registerPlugin(
        plugin("delta", {
          activate: () => {
            throw new Error("boom");
          },
        }),
      ),
    );
    expect(getPlugin("delta")?.error).toBe("boom");
  });
});
