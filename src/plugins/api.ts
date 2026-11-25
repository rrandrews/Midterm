import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import { activePaneId, livePane, openFile, openPaneBeside, updatePaneData } from "../actions";
import { changePaneKind, closePane } from "../closing";
import { type Command, registerCommands, runCommand } from "../commands/registry";
import { confirm, type ConfirmRequest } from "../components/ui/ConfirmDialog";
import * as fs from "../ipc/fs";
import { openJsonFile } from "../ipc/jsonFile";
import { homeDirectory } from "../ipc/system";
import { focusPane } from "../layout/dock";
import { runInNewTerminal } from "../palette/state";
import { pluginSectionScope, useSettingsDialog } from "../settings/dialogState";
import { settingsFor, useSettings } from "../settings/settings";
import { findTabOfPane, selectAllPanes, useAppStore } from "../state/store";
import type { PaneData, PaneNode } from "../state/types";
import { peekSession } from "../terminal/sessions";
import { MenuItems } from "./MenuItems";
import { type PaneState, type PaneStateOptions, createPaneState } from "./paneState";
import { directoryOf } from "./panes";
import { pluginSettings } from "./settings";
import { refreshTabTitles } from "./tabTitles";
import { subscribeThemeApplied } from "../theme/state";

/*
 * The API a plugin is given (`activate(api)`, `ctx.api`, skill tools). One
 * instance per plugin: settings and storage are scoped to it. Versioned:
 * a plugin's manifest names the `apiVersion` it was written for, and this
 * object only grows within a version. See docs/plugins.md.
 */

export const API_VERSION = 1;

export type MidtermApi = {
  readonly apiVersion: typeof API_VERSION;
  /** The plugin this API belongs to. */
  readonly pluginId: string;

  /** The host's React, for plugins that render with it (`pane.component`), plus its JSX runtime and `createRoot`. */
  readonly react: {
    React: typeof React;
    jsxRuntime: typeof jsxRuntime;
    createRoot: typeof ReactDOMClient.createRoot;
  };

  panes: {
    /** The active pane of the active tab. */
    active(): string | undefined;
    /** A pane by id, wherever it is. */
    get(paneId: string): PaneNode | undefined;
    /** Every pane in every tab. */
    list(): PaneNode[];
    /** Opens a pane of `kind` beside a pane (the active one by default). */
    open(kind: string, options?: { beside?: string }): void;
    updateData(paneId: string, patch: Partial<PaneData>): void;
    /** Changes a pane's kind (asking first if work would be lost). */
    changeKind(paneId: string, kind: string): Promise<void>;
    close(paneId: string): Promise<void>;
    focus(paneId: string): void;
    /** The directory a pane is in, as its plugin says. */
    directory(paneId: string): string | undefined;
    /** Shows that a pane in a background tab has news (the tab's dot). */
    markActivity(paneId: string): void;
    /** Asks for tab titles to be recomputed (after something `tabTitle` reads changed). */
    refreshTitles(): void;
    /** Calls `listener` whenever any tab's layout or panes change. */
    subscribe(listener: () => void): () => void;
    /** Per-pane state kept outside the UI (see src/plugins/paneState.ts). */
    createState<T>(options: PaneStateOptions<T>): PaneState<T>;
  };

  commands: {
    /** Registers commands until the returned function is called (or the plugin is disabled, for `plugin.commands`). */
    register(commands: Command[]): () => void;
    run(id: string): boolean;
  };

  /** This plugin's settings (validated against its declared fields). */
  settings: {
    get(): Record<string, unknown>;
    set(patch: Record<string, unknown>): void;
    subscribe(listener: (settings: Record<string, unknown>) => void): () => void;
  };

  /** A JSON file of this plugin's own, in the app data directory. */
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };

  files: {
    /** Opens a file in a pane that can show it, from a pane (the active one by default). */
    open(path: string, options?: { fromPaneId?: string; line?: number; column?: number; newPane?: boolean }): void;
    readText(path: string): Promise<fs.TextFile>;
    writeText(path: string, text: string, expect?: fs.WriteExpect): Promise<fs.WriteResult>;
    list(path: string, options?: fs.ListOptions): Promise<fs.FsEntry[]>;
    stat(path: string): Promise<fs.FsEntry | null>;
    home(): string | undefined;
  };

  terminals: {
    /** A terminal pane's current working directory. */
    cwd(paneId: string): string | undefined;
    /** Runs a shell command in a new terminal pane beside the active one. */
    run(command: string): void;
  };

  theme: {
    /** The current value of a theme token, e.g. `color-accent` (the CSS variable `--color-accent`). */
    token(name: string): string;
    /** Calls `listener` when the theme changes. */
    onChange(listener: () => void): () => void;
  };

  ui: {
    confirm(request: ConfirmRequest): Promise<boolean>;
    /** Renders declarative menu items inside a host menu (for plugins using the host's React). */
    MenuItems: typeof MenuItems;
  };
};

export function createApi(pluginId: string): MidtermApi {
  let storage: ReturnType<typeof openJsonFile> | null = null;
  const store = () => (storage ??= openJsonFile(`plugin-${pluginId}.json`));
  return {
    apiVersion: API_VERSION,
    pluginId,
    react: { React, jsxRuntime, createRoot: ReactDOMClient.createRoot },
    panes: {
      active: activePaneId,
      get: livePane,
      list: () => selectAllPanes(useAppStore.getState()),
      open: (kind, options) => openPaneBeside(kind, options?.beside),
      updateData: updatePaneData,
      changeKind: changePaneKind,
      close: closePane,
      focus: focusPane,
      directory: (paneId) => {
        const pane = livePane(paneId);
        return pane && directoryOf(pane);
      },
      markActivity: (paneId) => {
        const state = useAppStore.getState();
        const tab = findTabOfPane(state, paneId);
        if (tab) state.markActivity(tab.id);
      },
      refreshTitles: refreshTabTitles,
      subscribe: (listener) => useAppStore.subscribe(() => listener()),
      createState: createPaneState,
    },
    commands: { register: registerCommands, run: runCommand },
    // While the settings dialog shows this plugin's section, its settings
    // are those of the scope the dialog edits (see `pluginSectionScope`).
    settings: {
      get: () => scopedPluginSettings(pluginId),
      set: (patch) => useSettings.getState().updatePluginSettings(pluginId, patch, pluginSectionScope(pluginId)),
      subscribe: (listener) => {
        let last = scopedPluginSettings(pluginId);
        const check = () => {
          const next = scopedPluginSettings(pluginId);
          if (next === last) return;
          last = next;
          listener(next);
        };
        const stops = [useSettings.subscribe(check), useSettingsDialog.subscribe(check)];
        return () => {
          for (const stop of stops) stop();
        };
      },
    },
    storage: {
      get: async (key) => (await store()).get(key),
      set: async (key, value) => (await store()).set(key, value),
    },
    files: {
      open: (path, options = {}) => {
        const fromPaneId = options.fromPaneId ?? activePaneId();
        if (fromPaneId) openFile(path, { ...options, fromPaneId });
      },
      readText: fs.readTextFile,
      writeText: (path, text, expect = { kind: "any" }) => fs.writeTextFile(path, text, expect),
      list: (path, options = { showHidden: false }) => fs.listDir(path, options),
      stat: fs.stat,
      home: homeDirectory,
    },
    terminals: {
      cwd: (paneId) => peekSession(paneId)?.cwd,
      run: runInNewTerminal,
    },
    theme: {
      token: (name) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim(),
      onChange: (listener) =>
        subscribeThemeApplied(() => {
          try {
            listener();
          } catch (error) {
            console.error(`A theme listener of ${pluginId} failed:`, error);
          }
        }),
    },
    ui: { confirm, MenuItems },
  };
}

function scopedPluginSettings(pluginId: string): Record<string, unknown> {
  const scope = pluginSectionScope(pluginId);
  return scope === undefined ? pluginSettings(pluginId) : pluginSettings(pluginId, undefined, settingsFor(scope));
}
