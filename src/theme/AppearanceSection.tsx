import { useState } from "react";
import { confirm } from "../components/ui/ConfirmDialog";
import { exportIconSetInteractively, importIconSetInteractively } from "../icons/files";
import { allIconSets, deleteIconSet, knownIconSet, useIconState } from "../icons/state";
import { BUTTON, CommitField, Row, SectionHeading, Select, Toggle } from "../settings/controls";
import { ACCENT_PRESETS, isHexColor } from "../settings/schema";
import { useSettings } from "../settings/settings";
import { BUNDLED_THEMES } from "./bundled";
import { editTheme } from "./commands";
import { exportThemeInteractively, importThemeInteractively } from "./files";
import { resolveTheme } from "./resolve";
import {
  currentTheme,
  deleteTheme,
  duplicateTheme,
  findTheme,
  isBundled,
  renameTheme,
  selectTheme,
  selectedThemeId,
  useThemeState,
} from "./state";
import type { Theme } from "./types";

/*
 * Settings → Appearance: the theme gallery (click to apply), following the
 * system's light/dark appearance, the accent override, and managing custom
 * themes (duplicate, rename, delete, import, export, edit).
 */

function Swatch({ theme, selected, onSelect }: { theme: Theme; selected: boolean; onSelect: () => void }) {
  const resolved = resolveTheme(theme);
  const t = resolved.tokens;
  const ansi = ["ansi-red", "ansi-green", "ansi-yellow", "ansi-blue", "ansi-magenta", "ansi-cyan"] as const;
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={theme.author ? `${theme.name} — ${theme.author}` : theme.name}
      onClick={onSelect}
      data-theme-id={theme.id}
      className="group flex flex-col gap-1 rounded-[7px] p-1 text-left outline-none hover:bg-hover focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] aria-pressed:bg-selected"
    >
      <div
        className="flex h-[58px] flex-col justify-between overflow-hidden rounded-[5px] p-1.5 shadow-[inset_0_0_0_1px_var(--color-line)]"
        style={{ background: t.app }}
      >
        <div className="flex items-center gap-1 font-mono text-[11px] leading-none" style={{ color: t.fg }}>
          <span style={{ color: t["ansi-green"] }}>❯</span> Aa
          <span className="ml-auto size-2 rounded-full" style={{ background: t.accent }} />
        </div>
        <div className="h-1.5 w-3/4 rounded-sm" style={{ background: t["fg-faint"] }} />
        <div className="flex gap-0.5">
          {ansi.map((name) => (
            <span key={name} className="h-1.5 flex-1 rounded-[1px]" style={{ background: t[name] }} />
          ))}
        </div>
      </div>
      <div className="truncate px-0.5 text-meta text-fg-soft group-aria-pressed:text-fg-bright">{theme.name}</div>
    </button>
  );
}

function AccentRow() {
  const accent = useSettings((state) => state.accent);
  const update = useSettings((state) => state.updateSettings);
  const custom = accent !== "" && !ACCENT_PRESETS.some((preset) => preset.toLowerCase() === accent.toLowerCase());
  return (
    <Row label="Accent color" hint="Active pane, cursor, selection, drop targets; the theme’s own unless you pick one">
      <button
        type="button"
        aria-pressed={accent === ""}
        onClick={() => update({ accent: "" })}
        className={`${BUTTON} aria-pressed:bg-selected aria-pressed:text-fg-bright`}
      >
        Theme’s
      </button>
      {ACCENT_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          aria-label={`Accent ${preset}`}
          aria-pressed={accent.toLowerCase() === preset.toLowerCase()}
          onClick={() => update({ accent: preset })}
          className="size-4 rounded-full outline-offset-2 aria-pressed:outline aria-pressed:outline-1 aria-pressed:outline-fg-mid"
          style={{ background: preset }}
        />
      ))}
      <label
        className={`relative size-4 cursor-pointer overflow-hidden rounded-full outline-offset-2 ${custom ? "outline outline-1 outline-fg-mid" : ""}`}
        title="Custom color"
        style={{ background: custom ? accent : "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }}
      >
        <input
          type="color"
          aria-label="Custom accent color"
          className="absolute inset-0 opacity-0"
          value={(accent || "#8b9cff").toLowerCase()}
          onChange={(event) => isHexColor(event.target.value) && update({ accent: event.target.value })}
        />
      </label>
    </Row>
  );
}

/** The file icon set (docs/icons.md), and importing, exporting and deleting custom sets. */
function IconSetRow({ run }: { run: (task: Promise<unknown>) => void }) {
  const iconSet = useSettings((state) => state.iconSet);
  const update = useSettings((state) => state.updateSettings);
  useIconState((state) => state.custom);
  const sets = allIconSets();
  const chosen = sets.find((set) => set.id === iconSet) ?? sets[0];
  const themed = currentTheme().icons?.set;
  const themedName = knownIconSet(themed) ? sets.find((set) => set.id === themed)?.name : undefined;
  const credit = [chosen.author && `by ${chosen.author}`, chosen.license && `(${chosen.license})`].filter(Boolean).join(" ");
  return (
    <Row
      label="File icons"
      hint={
        themedName
          ? `The current theme uses its own set, “${themedName}”`
          : `${credit ? `${chosen.name} ${credit}. ` : ""}A theme with its own icon set uses that instead`
      }
    >
      <Select
        label="File icon set"
        value={chosen.id}
        options={sets.map((set) => set.id)}
        labels={Object.fromEntries(sets.map((set) => [set.id, set.name]))}
        onChange={(id) => update({ iconSet: id })}
      />
      <button type="button" className={BUTTON} onClick={() => run(importIconSetInteractively().then((set) => set && update({ iconSet: set.id })))}>
        Import…
      </button>
      {!chosen.bundled && (
        <>
          <button type="button" className={BUTTON} onClick={() => run(exportIconSetInteractively(chosen.id))}>
            Export…
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() =>
              run(
                confirm({ title: `Delete “${chosen.name}”?`, message: "Themes that use it fall back to your choice here.", action: "Delete" }).then(
                  (ok) => ok && deleteIconSet(chosen.id),
                ),
              )
            }
          >
            Delete
          </button>
        </>
      )}
    </Row>
  );
}

export function AppearanceSection() {
  const settings = useSettings();
  const { custom, systemDark } = useThemeState();
  const [problem, setProblem] = useState<string | null>(null);
  const selectedId = selectedThemeId(settings, systemDark);
  const selected = findTheme(selectedId);
  const run = (task: Promise<unknown>) => {
    setProblem(null);
    task.catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
  };
  const themes = [...BUNDLED_THEMES, ...custom];
  const options = (kind: "dark" | "light") => themes.filter((theme) => theme.kind === kind);

  return (
    <>
      <Row label="Follow the system" hint="Switch between a light and a dark theme with macOS’s appearance">
        <Toggle
          label="Follow the system appearance"
          checked={settings.themeFollowSystem}
          onChange={(themeFollowSystem) => settings.updateSettings({ themeFollowSystem })}
        />
      </Row>
      {settings.themeFollowSystem && (
        <Row label="Light and dark themes">
          <Select
            label="Light theme"
            value={settings.themeLight}
            options={options("light").map((theme) => theme.id)}
            labels={Object.fromEntries(themes.map((theme) => [theme.id, theme.name]))}
            onChange={(themeLight) => settings.updateSettings({ themeLight })}
          />
          <Select
            label="Dark theme"
            value={settings.themeDark}
            options={options("dark").map((theme) => theme.id)}
            labels={Object.fromEntries(themes.map((theme) => [theme.id, theme.name]))}
            onChange={(themeDark) => settings.updateSettings({ themeDark })}
          />
        </Row>
      )}
      <AccentRow />
      <IconSetRow run={run} />

      <SectionHeading>Themes</SectionHeading>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1 pb-2">
        {themes.map((theme) => (
          <Swatch key={theme.id} theme={theme} selected={theme.id === selectedId} onSelect={() => selectTheme(theme.id)} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pb-2">
        <button type="button" className={BUTTON} onClick={() => run(importThemeInteractively())}>
          Import…
        </button>
        <div className="flex-1" />
        {selected && (
          <>
            <button type="button" className={BUTTON} onClick={() => editTheme(selected.id)}>
              Edit
            </button>
            <button type="button" className={BUTTON} onClick={() => duplicateTheme(selected.id)}>
              Duplicate
            </button>
            <button type="button" className={BUTTON} onClick={() => run(exportThemeInteractively(selected.id))}>
              Export…
            </button>
            {!isBundled(selected.id) && (
              <button
                type="button"
                className={BUTTON}
                onClick={() =>
                  run(
                    confirm({ title: `Delete “${selected.name}”?`, message: "This cannot be undone.", action: "Delete" }).then(
                      (ok) => ok && deleteTheme(selected.id),
                    ),
                  )
                }
              >
                Delete
              </button>
            )}
          </>
        )}
      </div>
      {problem && <div className="pb-2 text-meta text-err">{problem}</div>}
      {selected && !isBundled(selected.id) && (
        <Row label="Name">
          <CommitField label="Theme name" value={selected.name} onCommit={(name) => renameTheme(selected.id, name)} />
        </Row>
      )}
      {selected && (selected.author || selected.source) && (
        <p className="pt-1 text-meta text-fg-dim">
          {selected.name}
          {selected.author && ` by ${selected.author}`}
          {selected.license && ` (${selected.license})`}
          {selected.source && <span className="block truncate text-fg-faint">{selected.source}</span>}
        </p>
      )}
    </>
  );
}
