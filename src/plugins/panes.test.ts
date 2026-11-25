import { afterEach, describe, expect, it } from "vitest";
import { useSettings } from "../settings/settings";
import type { MidtermApi } from "./api";
import { defaultKind, defaultTerminalKind, terminalPlugins } from "./panes";
import { installPluginHost, registerPlugin } from "./registry";
import type { PanePlugin } from "./types";

installPluginHost((pluginId) => ({ pluginId }) as unknown as MidtermApi);

function plugin(id: string, extra: Partial<PanePlugin> = {}): PanePlugin {
  return { id, name: id, pane: { mount: () => () => {} }, ...extra };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useSettings.getState().resetSettings();
  useSettings.getState().updateSettings({ plugins: {} });
});

describe("default terminal", () => {
  it("lists enabled plugins flagged as terminals", () => {
    cleanups.push(
      registerPlugin(plugin("terminal", { terminal: true, required: true })),
      registerPlugin(plugin("block-terminal", { terminal: true })),
      registerPlugin(plugin("off-term", { terminal: true })),
      registerPlugin(plugin("explorer")),
    );
    useSettings.getState().updatePluginEntry("off-term", { enabled: false });
    expect(terminalPlugins().map((p) => p.id)).toEqual(["terminal", "block-terminal"]);
  });

  it("follows the setting, falling back to the classic terminal", () => {
    cleanups.push(
      registerPlugin(plugin("terminal", { terminal: true, required: true })),
      registerPlugin(plugin("block-terminal", { terminal: true })),
      registerPlugin(plugin("explorer")),
    );
    expect(defaultTerminalKind()).toBe("terminal");
    useSettings.getState().updateSettings({ defaultTerminal: "block-terminal" });
    expect(defaultTerminalKind()).toBe("block-terminal");
    useSettings.getState().updatePluginEntry("block-terminal", { enabled: false });
    expect(defaultTerminalKind()).toBe("terminal");
    useSettings.getState().updateSettings({ defaultTerminal: "explorer" });
    expect(defaultTerminalKind()).toBe("terminal");
  });

  it("opens new tabs in a non-terminal default pane kind, else the default terminal", () => {
    cleanups.push(
      registerPlugin(plugin("terminal", { terminal: true, required: true })),
      registerPlugin(plugin("block-terminal", { terminal: true })),
      registerPlugin(plugin("explorer")),
    );
    useSettings.getState().updateSettings({ defaultTerminal: "block-terminal", defaultPaneKind: "terminal" });
    expect(defaultKind()).toBe("block-terminal");
    useSettings.getState().updateSettings({ defaultPaneKind: "explorer" });
    expect(defaultKind()).toBe("explorer");
    useSettings.getState().updateSettings({ defaultPaneKind: "missing" });
    expect(defaultKind()).toBe("block-terminal");
  });
});
