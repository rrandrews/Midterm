import {
  Asterisk,
  ChevronRight,
  ChevronsUpDown,
  Eye,
  FileCode,
  FolderTree,
  Globe,
  Keyboard,
  LayoutGrid,
  type LucideIcon,
  Orbit,
  Palette,
  Puzzle,
  Search,
  Settings2,
  Sparkles,
  SquareTerminal,
  Variable,
  X,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { registerCommands } from "../commands/registry";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../components/ui/Menu";
import { refocusPane } from "../layout/dock";
import { type RegisteredPlugin, allPlugins, isPluginEnabled, usePluginsVersion } from "../plugins/registry";
import { GeneralSection } from "./GeneralSection";
import { KeyboardSection } from "./KeyboardSection";
import { PluginSection, PluginsSection } from "./PluginSettings";
import { selectActiveWorkspace, useAppStore } from "../state/store";
import type { Workspace } from "../state/types";
import { EnvironmentSection } from "../workspaces/EnvironmentSection";
import { WorkspaceBadge } from "../workspaces/WorkspaceBadge";
import { WorkspaceSection, overrideEntries } from "../workspaces/WorkspaceSection";
import { openSettings, setSettingsScope, useSettingsDialog } from "./dialogState";
import { SettingsScopeProvider } from "./scope";
import { type SettingsSection, registerSettingsSection, useSettingsSections } from "./sections";
import { DEFAULT_SCOPE, useSettings, workspaceSettings } from "./settings";

export { closeSettings, openSettings } from "./dialogState";

/*
 * The settings dialog (⌘,). Every change applies and saves at once; there
 * is no OK button. Text fields commit on Enter or when they lose focus.
 * The list on the left has the app's sections, then one per plugin; its
 * search narrows both by section name and the names of their settings.
 *
 * The picker above the list chooses what is edited: the defaults (every
 * workspace) or one workspace, whose changes become overrides of the
 * defaults (docs/workspaces.md).
 */

registerCommands([
  { id: "settings.open", title: "Settings", category: "App", keys: ["Cmd+,"], run: () => openSettings() },
  {
    id: "workspace.settings",
    title: "Workspace settings",
    category: "Workspace",
    run: () => openSettings("workspace", selectActiveWorkspace(useAppStore.getState()).id),
  },
  {
    id: "settings.keyboard",
    title: "Keyboard shortcuts",
    category: "App",
    run: () => openSettings("keyboard"),
  },
]);

registerSettingsSection({
  id: "general",
  label: "General",
  order: 0,
  icon: Settings2,
  component: GeneralSection,
  keywords: ["default terminal", "new tabs", "splits", "pane type", "restore defaults", "reset"],
});
registerSettingsSection({
  id: "workspace",
  label: "Workspace",
  order: -10,
  icon: LayoutGrid,
  component: WorkspaceSection,
  scope: "workspace",
  keywords: ["name", "rename", "icon", "delete", "overrides"],
});
registerSettingsSection({
  id: "environment",
  label: "Environment",
  order: 20,
  icon: Variable,
  component: EnvironmentSection,
  keywords: ["environment variables", "env", "secrets", "keychain", "python", "virtualenv", "venv", "conda"],
});
registerSettingsSection({
  id: "plugins",
  label: "Plugins",
  order: 800,
  icon: Puzzle,
  component: PluginsSection,
  scope: "shared",
  keywords: ["import", "install", "enable", "disable"],
});
registerSettingsSection({
  id: "keyboard",
  label: "Keyboard",
  order: 900,
  icon: Keyboard,
  component: KeyboardSection,
  scope: "shared",
  keywords: ["shortcuts", "keybindings", "keys", "hotkeys"],
});

/** Built-in plugins' lucide icon names. */
const PLUGIN_ICONS: Record<string, LucideIcon> = {
  "square-terminal": SquareTerminal,
  "file-code": FileCode,
  eye: Eye,
  "folder-tree": FolderTree,
  asterisk: Asterisk,
  orbit: Orbit,
  palette: Palette,
  sparkles: Sparkles,
};

function PluginIcon({ icon }: { icon?: string }) {
  if (icon && /^(https?:|data:|\/|asset:)/.test(icon)) return <img src={icon} alt="" className="size-3.5 flex-none" />;
  const Icon = (icon && PLUGIN_ICONS[icon]) || Puzzle;
  return <Icon size={14} strokeWidth={1.75} className="flex-none" />;
}

const NAV_ITEM =
  "group flex h-7 w-full flex-none items-center gap-2 rounded-[6px] px-2 text-left text-menu text-fg-muted outline-none " +
  "hover:bg-hover hover:text-fg-soft focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] " +
  "aria-[current=page]:bg-selected aria-[current=page]:text-fg-bright";

function matches(query: string, ...texts: (string | undefined)[]): boolean {
  return texts.some((text) => text?.toLowerCase().includes(query));
}

function pluginMatches(query: string, { plugin }: RegisteredPlugin): boolean {
  const fields = plugin.settings?.fields ?? [];
  return matches(query, plugin.name, plugin.description, ...fields.map((field) => field.label));
}

/** Keeps focus inside the dialog when a menu closes (the default sends it to a pane). */
const stayInDialog = (event: Event) => event.preventDefault();

function DefaultBadge({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={`flex flex-none items-center justify-center bg-fg-bright/[0.08] text-fg-mid shadow-[inset_0_0_0_1px_var(--color-line-strong)] ${size === "lg" ? "size-7 rounded-[7px]" : "size-[18px] rounded-[5px]"}`}
    >
      <Globe size={size === "lg" ? 14 : 11} strokeWidth={2} />
    </span>
  );
}

/** How many settings a workspace overrides, said briefly. */
function useOverrideCount(workspaceId: string): number {
  return useSettings((state) => overrideEntries(workspaceSettings(workspaceId, state.base).overrides).length);
}

function overrideCaption(count: number): string {
  return count === 0 ? "Follows the defaults" : count === 1 ? "1 override" : `${count} overrides`;
}

function ScopeOption({ workspace, current, showing }: { workspace: Workspace; current: boolean; showing: boolean }) {
  const count = useOverrideCount(workspace.id);
  return (
    <MenuItem checked={current} onSelect={() => setSettingsScope(workspace.id)}>
      <span className="flex items-center gap-2">
        <WorkspaceBadge workspace={workspace} size="md" />
        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
        {showing && <span className="size-1.5 flex-none rounded-full bg-ok" title="Showing now" />}
        <span className="flex-none text-micro text-fg-dim tabular-nums">{count || ""}</span>
      </span>
    </MenuItem>
  );
}

/** What the dialog edits: the defaults or one workspace. */
function ScopePicker({ scope }: { scope: string }) {
  const workspaces = useAppStore((state) => state.workspaces);
  const activeId = useAppStore((state) => state.activeWorkspaceId);
  const edited = workspaces.find((workspace) => workspace.id === scope);
  const count = useOverrideCount(edited?.id ?? "");
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Editing settings for ${edited ? edited.name : "all workspaces"}`}
        className="flex h-11 w-full items-center gap-2.5 rounded-[8px] bg-fg-bright/[0.03] pr-2 pl-2 text-left outline-none shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-colors hover:bg-hover focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] data-[state=open]:bg-hover"
      >
        {edited ? <WorkspaceBadge workspace={edited} size="lg" className="size-7! rounded-[7px]! text-ui!" /> : <DefaultBadge size="lg" />}
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-ui font-medium text-fg-bright">{edited ? edited.name : "Default"}</span>
          <span className="truncate text-micro text-fg-dim">{edited ? overrideCaption(count) : "All workspaces"}</span>
        </span>
        <ChevronsUpDown size={12} className="flex-none text-fg-dim" aria-hidden="true" />
      </MenuTrigger>
      <MenuContent align="start" className="w-[238px]" onCloseAutoFocus={stayInDialog}>
        <MenuItem checked={!edited} onSelect={() => setSettingsScope(DEFAULT_SCOPE)}>
          <span className="flex items-center gap-2">
            <DefaultBadge />
            <span className="min-w-0 flex-1 truncate">Default</span>
            <span className="flex-none text-micro text-fg-dim">All workspaces</span>
          </span>
        </MenuItem>
        <MenuSeparator />
        <div className="px-2.5 pt-1 pb-1 text-micro font-medium text-fg-faint">Workspaces</div>
        {workspaces.map((workspace) => (
          <ScopeOption key={workspace.id} workspace={workspace} current={workspace.id === edited?.id} showing={workspace.id === activeId} />
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Whether a section is listed while `workspace` (or the defaults, `null`) is edited. */
function inScope(section: SettingsSection, workspace: string | null): boolean {
  return section.scope !== "workspace" || workspace !== null;
}

/** Shown atop a shared section while a workspace is edited. */
function SharedNote() {
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg bg-fg-bright/[0.03] px-3 py-2 text-meta text-fg-dim shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
      <Globe size={12} className="flex-none" aria-hidden="true" />
      Shared by every workspace: changes here apply to all of them.
    </div>
  );
}

/** Mounted once, in App. */
export function SettingsDialog() {
  const { open, section: requested, scope: requestedScope } = useSettingsDialog();
  const workspaceExists = useAppStore((state) => state.workspaces.some((workspace) => workspace.id === requestedScope));
  // A workspace deleted while it was being edited: back to the defaults.
  const scope = workspaceExists ? requestedScope : DEFAULT_SCOPE;
  const editedWorkspace = scope === DEFAULT_SCOPE ? null : scope;
  const editedName = useAppStore((state) => state.workspaces.find((workspace) => workspace.id === editedWorkspace)?.name);
  const overriddenSections = useSettings((state) =>
    editedWorkspace ? overrideEntries(workspaceSettings(editedWorkspace, state.base).overrides).map((entry) => entry.section).join("\n") : "",
  ).split("\n");
  const allSections = useSettingsSections();
  const sections = allSections.filter((item) => inScope(item, editedWorkspace));
  // A section only shown for workspaces, after switching to the defaults.
  const section = requested.startsWith("plugin:") || sections.some((item) => item.id === requested) ? requested : "general";
  const pluginState = useSettings((state) => state);
  usePluginsVersion();
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const plugins = allPlugins();
  const pluginId = section.startsWith("plugin:") ? section.slice("plugin:".length) : null;
  const current = sections.find((candidate) => candidate.id === section);
  const Current = current?.component;
  const title = pluginId ? (plugins.find((entry) => entry.plugin.id === pluginId)?.plugin.name ?? "Plugin") : (current?.label ?? "");
  const shared = !!editedWorkspace && current?.scope === "shared";

  const q = query.trim().toLowerCase();
  const shownSections = q ? sections.filter((item) => matches(q, item.label, ...(item.keywords ?? []))) : sections;
  const shownPlugins = q ? plugins.filter((entry) => pluginMatches(q, entry)) : plugins;
  const go = (next: string) => {
    useSettingsDialog.setState({ section: next });
    setScrolled(false);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        useSettingsDialog.setState({ open: next });
        if (!next) setQuery("");
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          data-owns-keyboard
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            refocusPane();
          }}
          onEscapeKeyDown={(event) => {
            // Escape cancels recording a shortcut, not the dialog.
            if (document.activeElement?.hasAttribute("data-key-recorder")) {
              event.preventDefault();
              (document.activeElement as HTMLElement).blur();
            }
            // A field that handles Escape itself (a combobox closing its list or reverting).
            if (document.activeElement?.hasAttribute("data-escape-local")) event.preventDefault();
          }}
          className="settings-dialog fixed top-1/2 left-1/2 z-50 flex h-[min(640px,calc(100vh-64px))] w-[min(860px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-popover shadow-menu outline-none"
        >
          <nav
            className="flex w-[200px] flex-none flex-col border-r border-line bg-app/45"
            aria-label="Settings sections"
          >
            <Dialog.Title className="sr-only">Settings</Dialog.Title>
            <div className="px-2.5 pt-2.5">
              <ScopePicker scope={scope} />
            </div>
            <div className="p-2.5 pb-2">
              <div className="relative">
                <Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-faint" />
                <input
                  aria-label="Search settings"
                  placeholder="Search"
                  spellCheck={false}
                  value={query}
                  data-escape-local={query ? "" : undefined}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query) {
                      event.stopPropagation();
                      setQuery("");
                    } else if (event.key === "Enter") {
                      const first = shownSections[0]?.id ?? (shownPlugins[0] && `plugin:${shownPlugins[0].plugin.id}`);
                      if (first) go(first);
                    }
                  }}
                  className="h-7 w-full rounded-[6px] bg-fg-bright/[0.04] pr-2 pl-7 text-ui text-fg outline-none placeholder:text-fg-faint shadow-[inset_0_0_0_1px_var(--color-line-strong)] focus:shadow-[inset_0_0_0_1px_var(--color-accent)]"
                />
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2.5 pb-2.5">
              {shownSections.map((item) => {
                const Icon = item.icon ?? Settings2;
                return (
                  <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined} onClick={() => go(item.id)} className={NAV_ITEM}>
                    <Icon size={14} strokeWidth={1.75} className="flex-none text-fg-dim group-aria-[current=page]:text-accent" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {overriddenSections.includes(item.id) && <OverrideDot />}
                    {editedWorkspace && item.scope === "shared" && <Globe size={10} className="flex-none text-fg-faint" aria-label="Shared by every workspace" />}
                  </button>
                );
              })}
              {shownPlugins.length > 0 && <div className="px-2 pt-4 pb-1 text-micro font-medium text-fg-faint">Panes</div>}
              {shownPlugins.map(({ plugin }) => {
                const enabled = isPluginEnabled(plugin.id, pluginState);
                return (
                  <button
                    key={plugin.id}
                    type="button"
                    aria-current={pluginId === plugin.id ? "page" : undefined}
                    onClick={() => go(`plugin:${plugin.id}`)}
                    className={`${NAV_ITEM} ${enabled ? "" : "opacity-50"}`}
                    title={enabled ? undefined : "Disabled"}
                  >
                    <span className="flex text-fg-dim group-aria-[current=page]:text-accent">
                      <PluginIcon icon={plugin.icon} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{plugin.name}</span>
                    {overriddenSections.includes(`plugin:${plugin.id}`) && <OverrideDot />}
                  </button>
                );
              })}
              {!shownSections.length && !shownPlugins.length && <div className="px-2 py-3 text-meta text-fg-dim">Nothing matches.</div>}
            </div>
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            <header
              className={`flex h-12 flex-none items-center gap-2 border-b pr-3 pl-6 transition-colors ${scrolled ? "border-line" : "border-transparent"}`}
            >
              <h2 className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-heading font-semibold tracking-[-0.01em] text-fg-bright">
                {editedName && (
                  <>
                    <span className="max-w-48 truncate font-medium text-fg-dim">{editedName}</span>
                    <ChevronRight size={13} strokeWidth={2} className="flex-none text-fg-faint" aria-hidden="true" />
                  </>
                )}
                <span className="truncate">{title}</span>
              </h2>
              <Dialog.Close
                aria-label="Close settings"
                className="flex size-6 items-center justify-center rounded-[5px] text-fg-dim outline-none hover:bg-hover hover:text-fg focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
              >
                <X size={14} />
              </Dialog.Close>
            </header>
            <div
              key={`${scope}:${section}`}
              className="min-h-0 flex-1 overflow-y-auto px-6 pt-1 pb-6"
              onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
            >
              <SettingsScopeProvider value={scope}>
                {shared && <SharedNote />}
                {pluginId ? <PluginSection pluginId={pluginId} /> : Current ? <Current /> : null}
              </SettingsScopeProvider>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** On a section in the list: the edited workspace overrides something in it. */
function OverrideDot() {
  return <span className="size-1.5 flex-none rounded-full bg-accent" title="This workspace overrides settings here" />;
}
