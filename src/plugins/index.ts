import { setPaneDataValidator } from "../state/persist";
import { createApi } from "./api";
import { registerBuiltinPlugins } from "./builtin";
import { installPaneCommands } from "./paneCommands";
import { getPlugin, installPluginHost } from "./registry";
import "./skills";
import "./tabTitles";

/*
 * Starts the plugin layer: built-in plugins registered, saved pane data
 * validated by the plugin of each pane's kind, the generated pane
 * commands, then activation (which needs the app's actions through the
 * API). Imported plugins load later (`loadImportedPlugins`), after the
 * first render.
 */

let installed = false;

export function installPlugins(): void {
  if (installed) return;
  installed = true;
  setPaneDataValidator((kind, raw) => {
    const spec = getPlugin(kind)?.plugin.pane;
    if (!spec) return undefined;
    return spec.validateData ? spec.validateData(raw) : raw;
  });
  registerBuiltinPlugins();
  installPaneCommands();
  installPluginHost(createApi);
}
