import { activePaneId, addSubtab, newTab, openPaneBeside } from "../actions";
import { changePaneKind } from "../closing";
import { type Command, registerCommands } from "../commands/registry";
import { livePane } from "../actions";
import { enabledPlugins, subscribePlugins } from "./registry";

/*
 * Palette commands generated for every enabled pane plugin: open one beside
 * the active pane, as a subtab of it, or in a new tab, and change the
 * active pane to it. Their ids are stable (`pane.new.<kind>`,
 * `pane.newSubtab.<kind>`, `pane.newTab.<kind>`, `pane.changeTo.<kind>`),
 * so they can be rebound; they come and go as
 * plugins are enabled, imported or removed.
 */

export function paneCommandsFor(kind: string, name: string): Command[] {
  return [
    { id: `pane.new.${kind}`, title: `New ${name} pane`, category: "Pane", run: () => openPaneBeside(kind) },
    { id: `pane.newSubtab.${kind}`, title: `New ${name} subtab`, category: "Pane", run: () => addSubtab(kind) },
    { id: `pane.newTab.${kind}`, title: `New ${name} in new tab`, category: "Tab", run: () => newTab(kind) },
    {
      id: `pane.changeTo.${kind}`,
      title: `Change pane to ${name}`,
      category: "Pane",
      run: () => {
        const id = activePaneId();
        if (id) void changePaneKind(id, kind);
      },
      enabled: () => {
        const pane = livePane(activePaneId());
        return pane !== undefined && pane.data.kind !== kind;
      },
    },
  ];
}

let unregister: (() => void) | null = null;
let lastKey = "";

function sync(): void {
  const plugins = enabledPlugins();
  const key = plugins.map((plugin) => `${plugin.id}:${plugin.name}`).join("|");
  if (key === lastKey) return;
  lastKey = key;
  unregister?.();
  unregister = registerCommands(plugins.flatMap((plugin) => paneCommandsFor(plugin.id, plugin.name)));
}

/** Keeps the generated commands in step with the enabled plugins. */
export function installPaneCommands(): void {
  sync();
  subscribePlugins(sync);
}
