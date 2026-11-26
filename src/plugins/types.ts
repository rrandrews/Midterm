import type { ComponentType } from "react";
import type { Command } from "../commands/registry";
import type { PaneData, PaneNode } from "../state/types";
import type { MidtermApi } from "./api";
import type { SettingField } from "./fields";

/*
 * The pane plugin contract. Every pane kind, built in or imported, is a
 * `PanePlugin` registered with `src/plugins/registry.ts`; its `id` is the
 * pane kind saved in layouts. See docs/plugins.md.
 */

/**
 * An icon: a lucide icon name in kebab-case ("square-terminal"), or an
 * SVG/image URL. Every plugin should have one: it is drawn on its panes'
 * subtabs and in the settings.
 */
export type IconSpec = string;

/** Props given to a plugin's React component. */
export type PaneProps = {
  paneId: string;
  /** The pane's data as stored in the layout. */
  data: PaneData;
  /** Whether this pane is the active pane of its tab. */
  active: boolean;
  ctx: PaneContext;
};

/** What a pane can do to itself and the app, independent of any framework. */
export type PaneContext = {
  readonly paneId: string;
  /** The pane's current data. */
  data(): PaneData;
  /** Merges `patch` into the pane's data (saved with the layout). */
  updateData(patch: Partial<PaneData>): void;
  /** Says how to give the pane keyboard focus; called whenever it should take it. Returns an unregister function. */
  onFocusRequest(focus: () => void): () => void;
  /** Registers the pane actions it supports while mounted (find, save…). Returns an unregister function. */
  registerActions(actions: PaneActions): () => void;
  /** Moves keyboard focus to this pane. */
  focus(): void;
  /** Closes the pane (asking first if something would be lost). */
  close(): void;
  readonly api: MidtermApi;
};

/**
 * Actions a mounted pane supports; commands such as Find or Save forward to
 * the active pane's action of that name. Plugins may add their own names
 * (and commands that forward to them with `paneActionCommand`).
 */
export type PaneActions = {
  find?: () => void;
  findNext?: () => void;
  findPrevious?: () => void;
  save?: () => unknown;
  goToLine?: () => void;
  [action: string]: (() => unknown) | undefined;
};

/** A right-click menu entry, declared as data and rendered by the host. */
export type MenuItemSpec =
  | {
      type?: "item";
      label: string;
      /** Key hint; defaults to the first binding of `commandId`. */
      shortcut?: string;
      /** A command whose binding is shown as the shortcut. */
      commandId?: string;
      /** Shows a check mark (reserving its space when `false`). */
      checked?: boolean;
      disabled?: boolean;
      run: () => unknown;
      /**
       * Called with `true` when the item is highlighted (pointer or keys)
       * and `false` when that ends, including when the menu closes.
       */
      onHighlight?: (on: boolean) => void;
    }
  | { type: "separator" }
  | { type: "submenu"; label: string; items: MenuItemSpec[] };

/**
 * The items every pane's … and right-click menus have that a plugin may
 * leave out (`PaneSpec.hideMenuItems`). "Settings…" and "Close pane" are
 * always shown.
 */
export const HIDEABLE_PANE_MENU_ITEMS = ["splitRight", "splitDown", "newSubtab", "changeType", "agent", "maximize", "moveToTab"] as const;
export type HideablePaneMenuItem = (typeof HIDEABLE_PANE_MENU_ITEMS)[number];

/**
 * Size limits of a pane's frame, in CSS pixels. The host clamps them to
 * `PANE_SIZE_BOUNDS` (src/layout/paneSize.ts). A maximum only applies
 * while another pane in the same split can take the rest of the space.
 */
export type PaneSizeLimits = {
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
};

/** Something that makes closing a pane lose work. */
export type CloseBlocker =
  /** A program still running (its name). */
  | { type: "running"; name: string }
  /** A file with unsaved changes (its name). */
  | { type: "unsaved"; name: string }
  /** Anything else, as a short sentence ("An upload is in progress"). */
  | { type: "other"; name: string };

export type PaneSpec = {
  /** React component, for built-ins and plugins that use the host's React (`api.React`). */
  component?: ComponentType<PaneProps>;
  /**
   * Framework-free alternative to `component`: render into `el` and return
   * a function that cleans up. Called once per mount.
   */
  mount?(el: HTMLElement, ctx: PaneContext): () => void;
  /** Validates saved data on restore; `null` rejects it (the pane gets fresh data). */
  validateData?(raw: Record<string, unknown>): Omit<PaneData, "kind"> | null;
  /** Data for a new pane, opened beside `from` (e.g. to inherit its directory). */
  createData?(from?: PaneNode): Omit<PaneData, "kind">;
  /**
   * Data when a pane of another kind is changed to this one (editor ↔ viewer
   * keep `path`); `undefined` starts fresh, as without it (`createData`).
   */
  convertData?(previous: PaneData): Omit<PaneData, "kind"> | undefined;
  /**
   * Whether changing a pane of this kind to `kind` keeps what it is running
   * (classic ↔ block terminal keep the shell), so the change does not ask
   * like closing it would.
   */
  keepsStateOnChangeTo?(kind: string): boolean;
  /**
   * Whether the pane has unsaved work right now. `openFile` only gives a
   * pane another file when this says no; a plugin with `closeBlockers` but
   * no `isDirty` never has its panes reused.
   */
  isDirty?(paneId: string): boolean;
  /** What closing this pane would lose. */
  closeBlockers?(paneId: string): Promise<CloseBlocker[]>;
  /** The directory a pane is "in": the palette's project root, explorers following it. */
  directory?(pane: PaneNode): string | undefined;
  /**
   * Unpinned explorers in the tab follow this pane's `directory` when it
   * was the last of such panes to have focus (terminals do).
   */
  explorerFollows?: boolean;
  /** Title for a tab whose active pane this is (unless the user named the tab). */
  tabTitle?(pane: PaneNode): string | undefined;
  /** Right-click items, shown above the items every pane has. */
  menu?(ctx: PaneContext): MenuItemSpec[];
  /** Items for the pane's … (options) menu, shown above the items every pane has. */
  optionsMenu?(ctx: PaneContext): MenuItemSpec[];
  /**
   * Items every pane has to leave out of this kind's … and right-click
   * menus. "Settings…" and "Close pane" cannot be hidden.
   */
  hideMenuItems?: readonly HideablePaneMenuItem[] | ((ctx: PaneContext) => readonly HideablePaneMenuItem[]);
  /** Minimum and maximum size of the pane, in pixels (clamped by the host). */
  size?: PaneSizeLimits;
  /**
   * Whether panes of this kind can show a file: `"default"` to be picked
   * first, `"option"` to be offered, `false` (or no handler) not at all.
   */
  fileHandler?(path: string): "default" | "option" | false;
  /** Shows the pane's file at a line (after `fileHandler` accepted it). */
  reveal?(paneId: string, path: string, line: number, column?: number): void;
  /**
   * Whether new panes may be split off this one when opening files.
   * Explorers say no (it squeezes the tree).
   */
  splittable?: boolean;
  /**
   * Subtabs of this kind show only the plugin's icon (its name in a
   * tooltip) unless the user names them. By default a subtab shows the icon
   * and the pane's `tabTitle` (or the plugin's name).
   */
  subtabIconOnly?: boolean;
  /** CSS background of the pane; defaults to the generic pane background token. */
  background?: string;
  /** CSS background of the pane while active, if different. */
  activeBackground?: string;
  /** Whether a right-click inside the pane should be left to its content (e.g. a terminal program reading the mouse). */
  ownsContextMenu?(paneId: string, event: MouseEvent): boolean;
};

/** Something an AI agent can learn to do with a plugin: guidance, callable tools, or both. */
export type Skill = {
  /** Unique within the plugin; namespaced as `<plugin>.<id>` in the skill registry. */
  id: string;
  title: string;
  /** When to use it: what a model reads to pick a skill. */
  description: string;
  /** Markdown guidance, loaded only once the skill is picked. */
  instructions?: string;
  tools?: SkillTool[];
};

/** A JSON Schema (draft 2020-12) object. */
export type JsonSchema = Record<string, unknown>;

export type SkillContext = {
  /** The plugin's API. */
  api: MidtermApi;
  /** The pane the agent is working with, if any. */
  paneId?: string;
  signal?: AbortSignal;
};

export type SkillTool = {
  /** Unique within the skill: letters, digits, `_` and `-`. */
  name: string;
  description: string;
  /** Validated by the host before `run`. */
  inputSchema: JsonSchema;
  /** `write` tools will need the user's confirmation. */
  effect: "read" | "write";
  /** Returns a JSON-serializable result. */
  run(input: unknown, ctx: SkillContext): Promise<unknown>;
};

export type PluginSettings = {
  /** Declarative fields, rendered and validated by the host. */
  fields?: SettingField[];
  /** A custom section, rendered below the fields. */
  section?: ComponentType<{ pluginId: string }>;
};

export type PanePlugin = {
  /** The pane kind: lowercase letters, digits and `-`. */
  id: string;
  name: string;
  version?: string;
  description?: string;
  icon?: IconSpec;
  /** Cannot be disabled (the classic terminal). */
  required?: boolean;
  /**
   * A terminal: offered as Settings → General → Default terminal, and used
   * for new terminals when chosen there. Its panes should start in
   * `data.cwd` when set and implement `pane.directory`.
   */
  terminal?: boolean;
  pane: PaneSpec;
  commands?: Command[];
  settings?: PluginSettings;
  skills?: Skill[];
  /** Called when the plugin is enabled; returns a function called when it is disabled. */
  activate?(api: MidtermApi): (() => void) | void;
};

/** Where a registered plugin came from. */
export type PluginSource =
  | { type: "builtin" }
  | {
      type: "imported";
      /** Folder it is installed in. */
      dir: string;
      author?: string;
      /** Only the manifest is known: the module is not loaded (the plugin is disabled, or loading). */
      stub?: boolean;
    };

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
