import { getSettings } from "../settings/settings";
import { createPane, setDefaultPaneData } from "../state/layout";
import type { PaneData, PaneNode } from "../state/types";
import { activePlugin, enabledPlugins, paneSpec } from "./registry";
import type { PanePlugin } from "./types";
import { CLASSIC_TERMINAL } from "../terminal/kinds";

/*
 * Pane-level questions answered by plugins, for the app's actions: which
 * kind a new pane gets, its starting data, the directory a pane is in, and
 * which kinds can show a file.
 */

/** Enabled, loaded plugins flagged as terminals (offered as the default terminal). */
export function terminalPlugins(): PanePlugin[] {
  return enabledPlugins().filter((plugin) => plugin.terminal === true);
}

/** The kind new terminals open in: the `defaultTerminal` setting if that plugin is an active terminal, else the classic terminal. */
export function defaultTerminalKind(): string {
  const kind = getSettings().defaultTerminal;
  return activePlugin(kind)?.terminal ? kind : CLASSIC_TERMINAL;
}

/**
 * The kind new tabs and splits open: the `defaultPaneKind` setting if it
 * names an active plugin that is not a terminal, else the default terminal.
 */
export function defaultKind(): string {
  const kind = getSettings().defaultPaneKind;
  const plugin = activePlugin(kind);
  return plugin && !plugin.terminal ? kind : defaultTerminalKind();
}

function safely<T>(kind: string, what: string, run: () => T): T | undefined {
  try {
    return run();
  } catch (error) {
    console.error(`${what} of the ${kind} plugin failed:`, error);
    return undefined;
  }
}

/** Starting data for a new pane of `kind` opened from `from`. */
export function newPaneData(kind: string, from?: PaneNode): PaneData {
  const spec = paneSpec(kind);
  return { ...(safely(kind, "createData", () => spec?.createData?.(from)) ?? {}), kind };
}

/** A new pane of `kind` (the default kind if unset), opened from `from`. */
export function newPane(kind: string = defaultKind(), from?: PaneNode): PaneNode {
  const data = newPaneData(kind, from);
  return createPane(kind, data);
}

/** Data for `pane` changed to `kind`: the plugin converts it, or starts fresh (inheriting what `createData` takes from it). */
export function convertedData(pane: PaneNode, kind: string): PaneData {
  const spec = paneSpec(kind);
  const converted = spec?.convertData ? safely(kind, "convertData", () => spec.convertData?.(pane.data)) : undefined;
  return { ...(converted ?? newPaneData(kind, pane)), kind };
}

/** The directory a pane is "in" (a terminal's cwd, an explorer's root, a file's folder), if its plugin knows. */
export function directoryOf(pane: PaneNode): string | undefined {
  const spec = paneSpec(pane.data.kind);
  return spec?.directory ? safely(pane.data.kind, "directory", () => spec.directory?.(pane)) : undefined;
}

/**
 * Enabled plugins that can show `path`, best first: those that claim it by
 * default, then those that offer to. With `line`, only plugins that can
 * reveal a line.
 */
export function fileHandlers(path: string, { line = false } = {}): PanePlugin[] {
  const defaults: PanePlugin[] = [];
  const options: PanePlugin[] = [];
  for (const plugin of enabledPlugins()) {
    if (line && !plugin.pane.reveal) continue;
    const answer = plugin.pane.fileHandler ? safely(plugin.id, "fileHandler", () => plugin.pane.fileHandler?.(path)) : false;
    if (answer === "default") defaults.push(plugin);
    else if (answer === "option") options.push(plugin);
  }
  return [...defaults, ...options];
}

setDefaultPaneData(() => newPaneData(defaultKind()));
