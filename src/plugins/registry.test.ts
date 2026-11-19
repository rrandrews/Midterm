import { afterEach, describe, expect, it } from "vitest";
import { getCommand } from "../commands/registry";
import { useSettings } from "../settings/settings";
import type { MidtermApi } from "./api";
import { activePlugin, enabledPlugins, getPlugin, installPluginHost, isPluginEnabled, registerPlugin } from "./registry";
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
  useSettings.setState({ plugins: {} });
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
