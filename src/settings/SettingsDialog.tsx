import {
  Asterisk,
  Eye,
  FileCode,
  FolderTree,
  Keyboard,
  type LucideIcon,
  Palette,
  Puzzle,
  Search,
  Settings2,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { create } from "zustand";
import { registerCommands } from "../commands/registry";
import { refocusPane } from "../layout/dock";
import { type RegisteredPlugin, allPlugins, isPluginEnabled, usePluginsVersion } from "../plugins/registry";
import { GeneralSection } from "./GeneralSection";
import { KeyboardSection } from "./KeyboardSection";
import { PluginSection, PluginsSection } from "./PluginSettings";
import { registerSettingsSection, useSettingsSections } from "./sections";
import { useSettings } from "./settings";

/*
 * The settings dialog (⌘,). Every change applies and saves at once; there
 * is no OK button. Text fields commit on Enter or when they lose focus.
 * The list on the left has the app's sections, then one per plugin; its
 * search narrows both by section name and the names of their settings.
 */

const useSettingsDialog = create<{ open: boolean; section: string }>()(() => ({
  open: false,
  section: "general",
}));

/** Opens the dialog at a section: a registered section's id, or `plugin:<id>` for a plugin's own. */
export function openSettings(section = "general"): void {
  useSettingsDialog.setState({ open: true, section });
}

export function closeSettings(): void {
  useSettingsDialog.setState({ open: false });
}

registerCommands([
  { id: "settings.open", title: "Settings", category: "App", keys: ["Cmd+,"], run: () => openSettings() },
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
  id: "plugins",
  label: "Plugins",
  order: 800,
  icon: Puzzle,
  component: PluginsSection,
  keywords: ["import", "install", "enable", "disable"],
});
registerSettingsSection({
  id: "keyboard",
  label: "Keyboard",
  order: 900,
  icon: Keyboard,
  component: KeyboardSection,
  keywords: ["shortcuts", "keybindings", "keys", "hotkeys"],
});

/** Built-in plugins' lucide icon names. */
const PLUGIN_ICONS: Record<string, LucideIcon> = {
  "square-terminal": SquareTerminal,
  "file-code": FileCode,
  eye: Eye,
  "folder-tree": FolderTree,
  asterisk: Asterisk,
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

/** Mounted once, in App. */
export function SettingsDialog() {
  const { open, section } = useSettingsDialog();
  const sections = useSettingsSections();
  const pluginState = useSettings((state) => state);
  usePluginsVersion();
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const plugins = allPlugins();
  const pluginId = section.startsWith("plugin:") ? section.slice("plugin:".length) : null;
  const current = sections.find((candidate) => candidate.id === section);
  const Current = current?.component;
  const title = pluginId ? (plugins.find((entry) => entry.plugin.id === pluginId)?.plugin.name ?? "Plugin") : (current?.label ?? "");

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
                    <span className="truncate">{item.label}</span>
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
                    <span className="truncate">{plugin.name}</span>
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
              <h2 className="min-w-0 flex-1 truncate text-heading font-semibold tracking-[-0.01em] text-fg-bright">{title}</h2>
              <Dialog.Close
                aria-label="Close settings"
                className="flex size-6 items-center justify-center rounded-[5px] text-fg-dim outline-none hover:bg-hover hover:text-fg focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
              >
                <X size={14} />
              </Dialog.Close>
            </header>
            <div
              key={section}
              className="min-h-0 flex-1 overflow-y-auto px-6 pt-1 pb-6"
              onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
            >
              {pluginId ? <PluginSection pluginId={pluginId} /> : Current ? <Current /> : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
