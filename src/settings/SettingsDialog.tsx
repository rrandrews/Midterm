import { RotateCcw, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
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
import {
  ACCENT_PRESETS,
  BELL_MODES,
  CURSOR_STYLES,
  FONT_SIZE_RANGE,
  SCROLLBACK_RANGE,
  type Settings,
  TERMINAL_BACKGROUNDS,
  TERMINAL_MODES,
  isHexColor,
  joinArgs,
  splitArgs,
} from "./schema";
import { useSettings } from "./settings";

/*
 * The settings dialog (⌘,). Every change applies and saves at once; there
 * is no OK button. Text fields commit on Enter or when they lose focus.
 */

const useSettingsDialog = create<{ open: boolean; section: Section }>()(() => ({
  open: false,
  section: "general",
}));

type Section = "general" | "terminal" | "keyboard";

export function openSettings(section: Section = "general"): void {
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

const FIELD =
  "h-6 rounded-[5px] bg-field px-2 text-ui text-fg outline-none shadow-[inset_0_0_0_1px_var(--color-line)] focus:shadow-[inset_0_0_0_1px_var(--color-accent)]";

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-4 border-b border-line/60 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-ui text-fg-soft">{label}</div>
        {hint && <div className="text-meta text-fg-dim">{hint}</div>}
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}

function Select<T extends string>({
  value,
  options,
  labels,
  onChange,
  label,
}: {
  value: T;
  options: readonly T[];
  labels?: Partial<Record<T, string>>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <select aria-label={label} className={`${FIELD} pr-6`} value={value} onChange={(event) => onChange(event.target.value as T)}>
      {options.map((option) => (
        <option key={option} value={option}>
          {labels?.[option] ?? option[0].toUpperCase() + option.slice(1)}
        </option>
      ))}
    </select>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 rounded-full transition-colors ${checked ? "bg-accent" : "bg-raised"}`}
    >
      <span
        className={`absolute top-0.5 size-3 rounded-full bg-fg-bright transition-[left] ${checked ? "left-3.5" : "left-0.5"}`}
      />
    </button>
  );
}

/** A text field that commits on Enter or blur; Escape reverts. */
function CommitField({
  value,
  onCommit,
  label,
  placeholder,
  className = "w-56",
  type = "text",
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
  type?: "text" | "number";
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      aria-label={label}
      type={type}
      spellCheck={false}
      placeholder={placeholder}
      className={`${FIELD} ${className}`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit(draft);
        if (event.key === "Escape" && draft !== value) {
          event.stopPropagation();
          setDraft(value);
        }
      }}
    />
  );
}

function General({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => void }) {
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
    </>
  );
}

function TerminalSettings({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => void }) {
  return (
    <>
      <Row label="New terminals open in" hint="Each pane can be switched from its menu">
        <Select
          label="Default terminal mode"
          value={settings.terminalMode}
          options={TERMINAL_MODES}
          labels={{ classic: "Classic", blocks: "Blocks" }}
          onChange={(terminalMode) => update({ terminalMode })}
        />
      </Row>
      <Row label="Cursor">
        <Select label="Cursor style" value={settings.cursorStyle} options={CURSOR_STYLES} onChange={(cursorStyle) => update({ cursorStyle })} />
        <span className="text-meta text-fg-dim">Blink</span>
        <Toggle label="Cursor blinks" checked={settings.cursorBlink} onChange={(cursorBlink) => update({ cursorBlink })} />
      </Row>
      <Row label="Scrollback" hint={`Lines kept per terminal (up to ${SCROLLBACK_RANGE.max.toLocaleString()})`}>
        <CommitField
          label="Scrollback lines"
          type="number"
          className="w-28"
          value={String(settings.scrollback)}
          onCommit={(value) => {
            const scrollback = Number.parseInt(value, 10);
            if (Number.isFinite(scrollback)) update({ scrollback });
          }}
        />
      </Row>
      <Row label="Copy on select" hint="Selecting text copies it to the clipboard">
        <Toggle label="Copy on select" checked={settings.copyOnSelect} onChange={(copyOnSelect) => update({ copyOnSelect })} />
      </Row>
      <Row label="Bell">
        <Select
          label="Bell"
          value={settings.bell}
          options={BELL_MODES}
          labels={{ off: "Off", visual: "Flash the pane", sound: "Sound" }}
          onChange={(bell) => update({ bell })}
        />
      </Row>
      <Row label="Background" hint="Transparent shows the pane gradient; solid renders faster">
        <Select
          label="Terminal background"
          value={settings.terminalBackground}
          options={TERMINAL_BACKGROUNDS}
          onChange={(terminalBackground) => update({ terminalBackground })}
        />
      </Row>
      <Row label="Shell" hint="Empty for your login shell. A custom program runs without shell integration (no cwd tracking or blocks).">
        <CommitField label="Shell program" placeholder="/bin/zsh" value={settings.shell} onCommit={(shell) => update({ shell })} />
      </Row>
      <Row label="Shell arguments" hint="Used with a custom shell; quote arguments containing spaces">
        <CommitField
          label="Shell arguments"
          placeholder="-l"
          value={joinArgs(settings.shellArgs)}
          onCommit={(value) => update({ shellArgs: splitArgs(value) })}
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

const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "terminal", label: "Terminal" },
  { id: "keyboard", label: "Keyboard" },
];

/** Mounted once, in App. */
export function SettingsDialog() {
  const { open, section } = useSettingsDialog();
  const settings = useSettings();
  const update = settings.updateSettings;

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
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(560px,calc(100vh-64px))] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg bg-popover shadow-menu outline-none"
        >
          <nav className="flex w-40 flex-none flex-col gap-0.5 border-r border-line p-2" aria-label="Settings sections">
            <Dialog.Title className="px-2.5 pt-1 pb-2 text-menu font-medium text-fg-bright">Settings</Dialog.Title>
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => useSettingsDialog.setState({ section: item.id })}
                className="flex h-7 items-center rounded-[5px] px-2.5 text-left text-menu text-fg-muted outline-none hover:text-fg-soft aria-[current=page]:bg-white/[0.06] aria-[current=page]:text-fg-bright"
              >
                {item.label}
              </button>
            ))}
            <div className="flex-1" />
            <button
              type="button"
              onClick={async () => {
                const ok = await confirm({
                  title: "Restore all defaults?",
                  message: "Every setting and keyboard shortcut goes back to its default.",
                  action: "Restore defaults",
                });
                if (ok) settings.resetSettings();
              }}
              className="flex h-7 items-center rounded-[5px] px-2.5 text-left text-meta text-fg-dim outline-none hover:text-fg-soft"
            >
              Restore all defaults
            </button>
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto px-5 pt-8 pb-3">
            {section === "general" && <General settings={settings} update={update} />}
            {section === "terminal" && <TerminalSettings settings={settings} update={update} />}
            {section === "keyboard" && <Keyboard />}
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
