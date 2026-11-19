import { registerPlugin } from "../registry";
import { explorerPlugin } from "./explorer";
import { editorPlugin, viewerPlugin } from "./files";
import { terminalPlugin } from "./terminal";

/** The plugins that ship in the bundle, in the order they are listed. */
export const BUILTIN_PLUGINS = [terminalPlugin, explorerPlugin, editorPlugin, viewerPlugin];

export function registerBuiltinPlugins(): void {
  for (const plugin of BUILTIN_PLUGINS) registerPlugin(plugin, { type: "builtin" });
}
