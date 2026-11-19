import { RotateCcw, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState, useSyncExternalStore } from "react";
import { chordFromEvent, chordToString, formatBinding, parseChord } from "../commands/keys";
import {
  allCommands,
  bindingsOf,
  commandsVersion,
  conflictsWith,
  registerCommands,
  subscribeCommands,
} from "../commands/registry";
import { confirm } from "../components/ui/ConfirmDialog";
import { refocusPane } from "../layout/dock";
import { create } from "zustand";
import { allPlugins, enabledPlugins, usePluginsVersion } from "../plugins/registry";
import { CommitField, FIELD, Row, Select } from "./controls";
import { PluginSection, PluginsSection } from "./PluginSettings";
import { ACCENT_PRESETS, FONT_SIZE_RANGE, isHexColor } from "./schema";
import { registerSettingsSection, useSettingsSections } from "./sections";
import { useSettings } from "./settings";

/*
 * The settings dialog (⌘,). Every change applies and saves at once; there
 * is no OK button. Text fields commit on Enter or when they lose focus.
 */

const useSettingsDialog = create<{ open: boolean; section: string }>()(() => ({
  open: false,
  section: "general",
}));

/** Opens the dialog at a section: a registered section's id, or `plugin:<id>` for a plugin's own. */
export function openSettings(section = "general"): void {
  useSettingsDialog.setState({ open: true, section });
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

function General() {
  const settings = useSettings();
  const update = settings.updateSettings;
  usePluginsVersion();
  const kinds = enabledPlugins();
  const custom = !ACCENT_PRESETS.some((preset) => preset.toLowerCase() === settings.accent.toLowerCase());
  return (
    <>
      <Row label="Accent color" hint="Active pane, cursor, selection, drop targets">
        {ACCENT_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-label={`Accent ${preset}`}
            aria-pressed={settings.accent.toLowerCase() === preset.toLowerCase()}
            onClick={() => update({ accent: preset })}
            className="size-4 rounded-full outline-offset-2 aria-pressed:outline aria-pressed:outline-1 aria-pressed:outline-fg-mid"
            style={{ background: preset }}
          />
        ))}
        <label
          className={`relative size-4 cursor-pointer overflow-hidden rounded-full outline-offset-2 ${custom ? "outline outline-1 outline-fg-mid" : ""}`}
          title="Custom color"
          style={{ background: custom ? settings.accent : "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }}
        >
          <input
            type="color"
            aria-label="Custom accent color"
            className="absolute inset-0 opacity-0"
            value={settings.accent.toLowerCase()}
            onChange={(event) => isHexColor(event.target.value) && update({ accent: event.target.value })}
          />
        </label>
      </Row>
      <Row label="Font family" hint="Terminals and the editor; empty for the bundled JetBrains Mono">
        <CommitField
          label="Font family"
          placeholder="JetBrains Mono"
          value={settings.fontFamily}
          onCommit={(fontFamily) => update({ fontFamily })}
        />
      </Row>
      <Row label="Font size" hint={`${FONT_SIZE_RANGE.min}–${FONT_SIZE_RANGE.max} px`}>
        <CommitField
          label="Font size"
          type="number"
          className="w-20"
          value={String(settings.fontSize)}
          onCommit={(value) => {
            const fontSize = Number.parseFloat(value);
            if (Number.isFinite(fontSize)) update({ fontSize });
          }}
        />
      </Row>
      <Row label="New tabs and splits open" hint="Any pane can be changed to another type from its menu">
        <Select
          label="Default pane type"
          value={kinds.some((plugin) => plugin.id === settings.defaultPaneKind) ? settings.defaultPaneKind : "terminal"}
          options={kinds.map((plugin) => plugin.id)}
          labels={Object.fromEntries(kinds.map((plugin) => [plugin.id, plugin.name]))}
          onChange={(defaultPaneKind) => update({ defaultPaneKind })}
        />
      </Row>
    </>
  );
}

/** Records a chord: the next non-modifier key pressed. Escape cancels. */
function KeyRecorder({ onRecord, onCancel }: { onRecord: (binding: string) => void; onCancel: () => void }) {
  return (
    <input
      autoFocus
      readOnly
      aria-label="Press the new shortcut"
      data-key-recorder
      placeholder="Press keys…"
      className={`${FIELD} w-32 text-center font-mono text-micro`}
      onBlur={onCancel}
      onKeyDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape" && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) {
          onCancel();
          return;
        }
        const chord = chordFromEvent(event.nativeEvent);
        if (!chord) return;
        const spec = chordToString(chord);
        if (parseChord(spec)) onRecord(spec);
      }}
    />
  );
}

function Keyboard() {
  useSyncExternalStore(subscribeCommands, commandsVersion);
  const setKeybinding = useSettings((state) => state.setKeybinding);
  const overrides = useSettings((state) => state.keybindings);
  const [recording, setRecording] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const commands = allCommands().filter(
    (command) =>
      !filter ||
      `${command.category} ${command.title} ${command.id}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <>
      <div className="sticky top-0 z-10 bg-popover pb-2">
        <input
          aria-label="Filter commands"
          placeholder="Filter commands"
          className={`${FIELD} w-full`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      {commands.map((command) => {
        const bindings = bindingsOf(command.id);
        const conflicts = bindings.flatMap((spec) => {
          const chord = parseChord(spec);
          return chord ? conflictsWith(chord, command.id) : [];
        });
        const overridden = command.id in overrides;
        return (
          <Row
            key={command.id}
            label={command.title}
            hint={conflicts.length ? `Also bound to: ${conflicts.map((other) => other.title).join(", ")}` : command.category}
          >
            {recording === command.id ? (
              <KeyRecorder
                onRecord={(spec) => {
                  setKeybinding(command.id, [spec]);
                  setRecording(null);
                }}
                onCancel={() => setRecording(null)}
              />
            ) : (
              <button
                type="button"
                title="Click to change"
                onClick={() => setRecording(command.id)}
                className={`${FIELD} min-w-20 font-mono text-micro ${conflicts.length ? "text-warn" : "text-fg-mid"}`}
              >
                {bindings.length ? bindings.map(formatBinding).join("  ") : "—"}
              </button>
            )}
            <button
              type="button"
              aria-label={`Remove the shortcut for ${command.title}`}
              title="Remove shortcut"
              disabled={bindings.length === 0}
              onClick={() => setKeybinding(command.id, [])}
              className="flex p-0.5 text-fg-dim hover:text-fg disabled:opacity-30"
            >
              <X size={12} />
            </button>
            <button
              type="button"
              aria-label={`Restore the default shortcut for ${command.title}`}
              title="Restore default"
              disabled={!overridden}
              onClick={() => setKeybinding(command.id, null)}
              className="flex p-0.5 text-fg-dim hover:text-fg disabled:opacity-30"
            >
              <RotateCcw size={12} />
            </button>
          </Row>
        );
      })}
    </>
  );
}

registerSettingsSection({ id: "general", label: "General", order: 0, component: General });
registerSettingsSection({ id: "plugins", label: "Plugins", order: 800, component: PluginsSection });
registerSettingsSection({ id: "keyboard", label: "Keyboard", order: 900, component: Keyboard });

const NAV_ITEM =
  "flex h-7 flex-none items-center rounded-[5px] px-2.5 text-left text-menu text-fg-muted outline-none hover:text-fg-soft aria-[current=page]:bg-white/[0.06] aria-[current=page]:text-fg-bright";

/** Mounted once, in App. */
export function SettingsDialog() {
  const { open, section } = useSettingsDialog();
  const resetSettings = useSettings((state) => state.resetSettings);
  const sections = useSettingsSections();
  usePluginsVersion();
  const plugins = allPlugins();
  const pluginId = section.startsWith("plugin:") ? section.slice("plugin:".length) : null;
  const Current = sections.find((candidate) => candidate.id === section)?.component;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => useSettingsDialog.setState({ open: next })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35" />
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
          }}
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(560px,calc(100vh-64px))] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg bg-popover shadow-menu outline-none"
        >
          <nav className="flex w-40 flex-none flex-col gap-0.5 border-r border-line p-2" aria-label="Settings sections">
            <Dialog.Title className="px-2.5 pt-1 pb-2 text-menu font-medium text-fg-bright">Settings</Dialog.Title>
            {sections.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => useSettingsDialog.setState({ section: item.id })}
                className={NAV_ITEM}
              >
                {item.label}
              </button>
            ))}
            <div className="px-2.5 pt-3 pb-1 text-micro font-medium tracking-wide text-fg-faint uppercase">Panes</div>
            <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
              {plugins.map(({ plugin }) => (
                <button
                  key={plugin.id}
                  type="button"
                  aria-current={pluginId === plugin.id ? "page" : undefined}
                  onClick={() => useSettingsDialog.setState({ section: `plugin:${plugin.id}` })}
                  className={NAV_ITEM}
                >
                  <span className="truncate">{plugin.name}</span>
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <button
              type="button"
              onClick={async () => {
                const ok = await confirm({
                  title: "Restore all defaults?",
                  message: "Every setting and keyboard shortcut goes back to its default. Which plugins are enabled is kept.",
                  action: "Restore defaults",
                });
                if (ok) resetSettings();
              }}
              className="flex h-7 items-center rounded-[5px] px-2.5 text-left text-meta text-fg-dim outline-none hover:text-fg-soft"
            >
              Restore all defaults
            </button>
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto px-5 pt-8 pb-3">
            {pluginId ? <PluginSection pluginId={pluginId} /> : Current ? <Current /> : null}
          </div>
          <Dialog.Close
            aria-label="Close settings"
            className="absolute top-2 right-2 flex rounded-[5px] p-1 text-fg-dim outline-none hover:text-fg"
          >
            <X size={14} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
