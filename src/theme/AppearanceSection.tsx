import { Check, MoreHorizontal, Plus } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { ColorPopover } from "../components/ui/ColorPicker";
import { confirm } from "../components/ui/ConfirmDialog";
import { InlineEdit } from "../components/ui/InlineEdit";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../components/ui/Menu";
import { Tip } from "../components/ui/Tooltip";
import { exportIconSetInteractively, importIconSetInteractively } from "../icons/files";
import { allIconSets, deleteIconSet, knownIconSet, useIconState } from "../icons/state";
import { BUTTON, Block, CommitField, Group, ICON_BUTTON, NumberField, OverrideMark, ResetOverride, Row, Select, Toggle } from "../settings/controls";
import { useOverride } from "../settings/scope";
import { activeSettings } from "../settings/settings";
import { ACCENT_PRESETS, FONT_SIZE_RANGE, isHexColor } from "../settings/schema";
import { closeSettings } from "../settings/SettingsDialog";
import { useScopedActions, useScopedSettings, useSettingsScope } from "../settings/scope";
import { BUNDLED_THEMES } from "./bundled";
import { editTheme } from "./commands";
import { exportThemeInteractively, importThemeInteractively } from "./files";
import { cssVariables, resolveTheme } from "./resolve";
import { currentTheme, deleteTheme, findTheme, duplicateTheme, isBundled, renameTheme, scopeResolvedTheme, selectTheme, selectedThemeId, useThemeState } from "./state";
import type { Theme } from "./types";

/*
 * Settings → Appearance: a live preview of the current look, the theme
 * gallery (click to apply; when following the system, a click sets the
 * pick for that theme's kind), the terminal and editor font, the accent
 * override and the file icon set.
 */

/** Keeps focus inside the dialog when a menu closes (the default sends it to a pane). */
const stayInDialog = () => {};

/** The theme showing now (draft and palette preview included), re-rendering when it changes. */
function useShownTheme(): Theme {
  const { systemDark } = useThemeState();
  useThemeState((state) => state.draft ?? state.preview);
  const settings = useScopedSettings((state) => state);
  if (settings === activeSettings()) return currentTheme();
  return findTheme(selectedThemeId(settings, systemDark)) ?? currentTheme();
}

/**
 * The edited scope's theme, resolved. Another workspace's theme is not on
 * screen, so the preview sets its colors itself.
 */
function useScopeTheme() {
  const { systemDark } = useThemeState();
  useThemeState((state) => state.draft ?? state.preview);
  const settings = useScopedSettings((state) => state);
  return scopeResolvedTheme(settings, systemDark);
}

/** A few lines of a terminal in the edited scope's theme, font and accent. */
function Preview() {
  const fontFamily = useScopedSettings((state) => state.fontFamily);
  const fontSize = useScopedSettings((state) => state.fontSize);
  const resolved = useScopeTheme();
  const name = resolved.name;
  const font = fontFamily ? `${fontFamily}, var(--font-mono)` : "var(--font-mono)";
  return (
    <div
      aria-hidden="true"
      className="relative mb-5 overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
      style={{ ...(cssVariables(resolved) as CSSProperties), background: "var(--pane-terminal-active)" }}
    >
      <div className="absolute inset-y-0 left-0 w-[2px] bg-accent" />
      <pre
        className="m-0 overflow-hidden px-[18px] py-3 whitespace-pre text-terminal-fg"
        style={{ fontFamily: font, fontSize: `${fontSize}px`, lineHeight: 1.52 }}
      >
        <span className="text-ansi-blue">~/code/midterm</span> <span className="text-ansi-magenta">main</span>
        {"\n"}
        <span className="text-ansi-green">❯</span> git status --short{"\n"}
        <span className="text-ansi-yellow"> M</span> src/settings/controls.tsx{"\n"}
        <span className="text-ansi-green">A </span> src/components/ui/Select.tsx{"\n"}
        <span className="text-ansi-red">??</span> <span className="text-fg-dim">notes.md</span>
        {"\n"}
        <span className="text-ansi-green">❯</span> <span className="inline-block h-[1.1em] w-[0.6em] translate-y-[0.15em] bg-terminal-cursor" />
      </pre>
      <div className="absolute right-2.5 bottom-2 rounded-[4px] bg-popover/80 px-1.5 py-0.5 text-micro text-fg-dim backdrop-blur-sm">{name}</div>
    </div>
  );
}

function ThemeCard({
  theme,
  showing,
  pick,
  run,
}: {
  theme: Theme;
  /** The theme on screen now. */
  showing: boolean;
  /** Following the system: this is the light or dark pick. */
  pick: boolean;
  run: (task: Promise<unknown>) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const scope = useSettingsScope();
  const t = resolveTheme(theme);
  const tokens = t.tokens;
  const pane = t.panes.terminal;
  const bundled = isBundled(theme.id);
  const credit = [theme.author && `by ${theme.author}`, theme.license && `(${theme.license})`].filter(Boolean).join(" ");
  const ansi = ["ansi-red", "ansi-green", "ansi-yellow", "ansi-blue", "ansi-magenta", "ansi-cyan"] as const;
  const marked = showing || pick;
  return (
    <div className="group/card relative flex flex-col gap-1.5" data-theme-id={theme.id}>
      <button
        type="button"
        aria-pressed={marked}
        aria-label={theme.name}
        title={credit ? `${theme.name} ${credit}` : theme.name}
        onClick={() => selectTheme(theme.id, scope)}
        className={`relative flex h-[62px] flex-col justify-between overflow-hidden rounded-[7px] p-2 pl-2.5 text-left outline-none transition-shadow focus-visible:shadow-[0_0_0_2px_var(--color-popover),0_0_0_3px_var(--color-accent)] ${
          marked
            ? "shadow-[0_0_0_2px_var(--color-popover),0_0_0_3.5px_var(--color-accent)]"
            : "shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:shadow-[inset_0_0_0_1px_var(--color-fg-faint)]"
        }`}
        style={{ background: `linear-gradient(${pane.angle}deg, ${pane.from}, ${pane.to})` }}
      >
        <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: tokens.accent }} />
        <span className="flex items-center gap-1 font-mono text-[10px] leading-none" style={{ color: tokens["terminal-fg"] }}>
          <span style={{ color: tokens["ansi-green"] }}>❯</span>
          <span>ls</span>
          <span className="ml-0.5 inline-block h-[9px] w-[5px]" style={{ background: tokens["terminal-cursor"] }} />
        </span>
        <span className="flex gap-1.5 font-mono text-[9px] leading-none">
          <span style={{ color: tokens["ansi-blue"] }}>src</span>
          <span style={{ color: tokens["ansi-blue"] }}>docs</span>
          <span style={{ color: tokens["fg-dim"] }}>notes</span>
        </span>
        <span className="flex gap-[3px]">
          {ansi.map((name) => (
            <span key={name} className="h-[5px] flex-1 rounded-[1.5px]" style={{ background: tokens[name] }} />
          ))}
        </span>
      </button>
      <div className="flex h-4 min-w-0 items-center gap-1 px-0.5">
        {marked && <Check size={11} strokeWidth={2.5} className="flex-none text-accent" />}
        {renaming ? (
          <InlineEdit label="Theme name" value={theme.name} className="text-meta" onCommit={(name) => renameTheme(theme.id, name)} onDone={() => setRenaming(false)} />
        ) : (
          <span className={`min-w-0 truncate text-meta ${marked ? "text-fg-bright" : "text-fg-mid"}`}>{theme.name}</span>
        )}
      </div>
      <Menu modal={false}>
        <MenuTrigger
          aria-label={`${theme.name} actions`}
          className={`${ICON_BUTTON} absolute top-1 right-1 size-5! bg-popover/85 opacity-0 backdrop-blur-sm group-hover/card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100`}
        >
          <MoreHorizontal size={12} />
        </MenuTrigger>
        <MenuContent className="min-w-[168px]" onCloseAutoFocus={stayInDialog}>
          <MenuItem
            onSelect={() => {
              closeSettings();
              void editTheme(theme.id);
            }}
          >
            Edit colors…
          </MenuItem>
          <MenuItem onSelect={() => duplicateTheme(theme.id)}>Duplicate</MenuItem>
          {!bundled && <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem>}
          <MenuItem onSelect={() => run(exportThemeInteractively(theme.id))}>Export…</MenuItem>
          {!bundled && (
            <>
              <MenuSeparator />
              <MenuItem
                className="data-[highlighted]:text-err"
                onSelect={() =>
                  run(
                    confirm({ title: `Delete “${theme.name}”?`, message: "This cannot be undone.", action: "Delete" }).then(
                      (ok) => ok && deleteTheme(theme.id),
                    ),
                  )
                }
              >
                Delete
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
    </div>
  );
}

/** The gallery edits three settings; marked as one while a workspace overrides any of them. */
function useThemeOverride() {
  const theme = useOverride("theme");
  const light = useOverride("themeLight");
  const dark = useOverride("themeDark");
  const overridden = theme.overridden || light.overridden || dark.overridden;
  const reset = () => {
    theme.reset();
    light.reset();
    dark.reset();
  };
  return { overridden, reset };
}

function Gallery({ run }: { run: (task: Promise<unknown>) => void }) {
  const settings = useScopedSettings((state) => state);
  const { custom, systemDark } = useThemeState();
  const override = useThemeOverride();
  const showing = selectedThemeId(settings, systemDark);
  const themes = [...BUNDLED_THEMES, ...custom];
  const kinds = [
    { kind: "dark" as const, label: "Dark" },
    { kind: "light" as const, label: "Light" },
  ];
  return (
    <Block className="relative flex flex-col gap-3 pt-3 pb-3.5">
      {override.overridden && <OverrideMark />}
      {kinds.map(({ kind, label }, index) => (
        <div key={kind}>
          <div className="flex h-5 items-center pb-2 text-micro font-medium text-fg-dim">
            <span className="flex-1">{label}</span>
            {index === 0 && override.overridden && <ResetOverride onReset={override.reset} />}
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-x-3 gap-y-2.5">
            {themes
              .filter((theme) => theme.kind === kind)
              .map((theme) => (
                <ThemeCard
                  key={theme.id}
                  theme={theme}
                  showing={theme.id === showing}
                  pick={settings.themeFollowSystem && theme.id === (kind === "dark" ? settings.themeDark : settings.themeLight)}
                  run={run}
                />
              ))}
          </div>
        </div>
      ))}
    </Block>
  );
}

function AccentRow() {
  const accent = useScopedSettings((state) => state.accent);
  const { updateSettings: update } = useScopedActions();
  const themeAccent = resolveTheme(useShownTheme()).tokens.accent;
  const custom = accent !== "" && !ACCENT_PRESETS.some((preset) => preset.toLowerCase() === accent.toLowerCase());
  const DOT =
    "size-[18px] flex-none rounded-full outline-none transition-shadow focus-visible:shadow-[0_0_0_2px_var(--color-popover),0_0_0_3px_var(--color-accent)] aria-pressed:shadow-[0_0_0_2px_var(--color-popover),0_0_0_3.5px_var(--color-fg-mid)]";
  return (
    <Row label="Accent" help="Active pane, cursor, selection and drop targets." setting="accent">
      <Tip content="The theme’s own">
        <button
          type="button"
          aria-label="The theme’s accent"
          aria-pressed={accent === ""}
          onClick={() => update({ accent: "" })}
          className={`${DOT} relative overflow-hidden`}
          style={{ background: themeAccent.slice(0, 7) }}
        >
          <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-app">T</span>
        </button>
      </Tip>
      <span className="mx-0.5 h-3.5 w-px bg-line-strong" />
      {ACCENT_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          aria-label={`Accent ${preset}`}
          aria-pressed={accent.toLowerCase() === preset.toLowerCase()}
          onClick={() => update({ accent: preset })}
          className={DOT}
          style={{ background: preset }}
        />
      ))}
      <ColorPopover label="Custom accent" value={(accent || themeAccent).slice(0, 7).toLowerCase()} onChange={(color) => isHexColor(color) && update({ accent: color })} align="end">
        <button
          type="button"
          aria-label="Custom accent color"
          aria-pressed={custom}
          className={DOT}
          style={{ background: custom ? accent : "conic-gradient(from 90deg, #f87171, #fbbf24, #4ade80, #22d3ee, #818cf8, #e879f9, #f87171)" }}
        />
      </ColorPopover>
    </Row>
  );
}

/** The file icon set, and importing, exporting and deleting custom sets. */
function IconSetRow({ run }: { run: (task: Promise<unknown>) => void }) {
  const iconSet = useScopedSettings((state) => state.iconSet);
  const { updateSettings: update } = useScopedActions();
  useIconState((state) => state.custom);
  const sets = allIconSets();
  const chosen = sets.find((set) => set.id === iconSet) ?? sets[0];
  const themed = useShownTheme().icons?.set;
  const themedName = knownIconSet(themed) ? sets.find((set) => set.id === themed)?.name : undefined;
  return (
    <Row
      label="File icons"
      help="A theme with its own icon set uses that instead."
      setting="iconSet"
      hint={themedName ? `This theme uses ${themedName}` : undefined}
    >
      <Select
        label="File icon set"
        className="w-40"
        value={chosen.id}
        options={sets.map((set) => ({
          value: set.id,
          label: set.name,
          detail: set.bundled ? undefined : "imported",
        }))}
        onChange={(id) => update({ iconSet: id })}
      />
      <Menu modal={false}>
        <MenuTrigger aria-label="Icon set actions" className={ICON_BUTTON}>
          <MoreHorizontal size={13} />
        </MenuTrigger>
        <MenuContent className="min-w-[168px]" onCloseAutoFocus={stayInDialog}>
          <MenuItem onSelect={() => run(importIconSetInteractively().then((set) => set && update({ iconSet: set.id })))}>Import icon set…</MenuItem>
          {!chosen.bundled && (
            <>
              <MenuItem onSelect={() => run(exportIconSetInteractively(chosen.id))}>Export “{chosen.name}”…</MenuItem>
              <MenuSeparator />
              <MenuItem
                className="data-[highlighted]:text-err"
                onSelect={() =>
                  run(
                    confirm({ title: `Delete “${chosen.name}”?`, message: "Themes that use it fall back to your choice here.", action: "Delete" }).then(
                      (ok) => ok && deleteIconSet(chosen.id),
                    ),
                  )
                }
              >
                Delete “{chosen.name}”
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
    </Row>
  );
}

export function AppearanceSection() {
  const settings = useScopedSettings((state) => state);
  const scope = useSettingsScope();
  const { updateSettings: update } = useScopedActions();
  const [problem, setProblem] = useState<string | null>(null);
  const run = (task: Promise<unknown>) => {
    setProblem(null);
    task.catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
  };

  return (
    <>
      <Preview />
      <Group
        title="Theme"
        actions={
          <button type="button" className={BUTTON} onClick={() => run(importThemeInteractively(scope))}>
            <Plus size={11} /> Import
          </button>
        }
      >
        <Row label="Match system appearance" help="Pick one dark and one light theme; they switch with macOS." setting="themeFollowSystem">
          <Toggle
            label="Match system appearance"
            checked={settings.themeFollowSystem}
            onChange={(themeFollowSystem) => update({ themeFollowSystem })}
          />
        </Row>
        {problem && <Block className="text-meta text-err">{problem}</Block>}
        <Gallery run={run} />
      </Group>
      <Group title="Text">
        <Row label="Font" help="Terminals and the editor. Empty for the bundled JetBrains Mono." setting="fontFamily">
          <CommitField
            label="Font family"
            className="w-48"
            placeholder="JetBrains Mono"
            value={settings.fontFamily}
            style={settings.fontFamily ? { fontFamily: `${settings.fontFamily}, var(--font-mono)` } : undefined}
            onCommit={(fontFamily) => update({ fontFamily: fontFamily.trim() })}
          />
        </Row>
        <Row label="Size" setting="fontSize">
          <NumberField
            label="Font size"
            value={settings.fontSize}
            min={FONT_SIZE_RANGE.min}
            max={FONT_SIZE_RANGE.max}
            step={0.5}
            unit="px"
            onCommit={(fontSize) => update({ fontSize })}
          />
        </Row>
      </Group>
      <Group title="Interface">
        <AccentRow />
        <IconSetRow run={run} />
      </Group>
    </>
  );
}
