import { claudeCodePlugin } from "../../claude/plugin";
import { registerPlugin } from "../registry";
import { explorerPlugin } from "./explorer";
import { editorPlugin, viewerPlugin } from "./files";
import { blockTerminalPlugin, terminalPlugin } from "./terminal";

/** The plugins that ship in the bundle, in the order they are listed. */
export const BUILTIN_PLUGINS = [terminalPlugin, blockTerminalPlugin, explorerPlugin, editorPlugin, viewerPlugin, claudeCodePlugin];

export function registerBuiltinPlugins(): void {
  for (const plugin of BUILTIN_PLUGINS) registerPlugin(plugin, { type: "builtin" });
}
