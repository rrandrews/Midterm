import { Redo2, RotateCcw, Search, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ColorPopover, Swatch } from "../../components/ui/ColorPicker";
import { isConfirming } from "../../components/ui/ConfirmDialog";
import { Dot, Select } from "../../components/ui/Select";
import { Tip } from "../../components/ui/Tooltip";
import { FileIcon } from "../../icons/FileIcon";
import { activeIconSetId, allIconSets, knownIconSet, loadIconSet, useIconState } from "../../icons/state";
import { enabledPlugins, getPlugin } from "../../plugins/registry";
import { BUTTON, BUTTON_PRIMARY, FIELD, ICON_BUTTON, NumberField, Segmented } from "../../settings/controls";
import { guardSettingsLeave } from "../../settings/dialogState";
import { resolveTheme } from "../resolve";
import { allThemes, currentTheme, isBundled, useThemeState } from "../state";
import { type AnsiName, BUILTIN_PANES, type ResolvedTheme, TOKEN_GROUPS, type Theme, type TokenGroup, type TokenName } from "../types";
import {
  type BaseField,
  discardDraft,
  editDraft,
  isDraftDirty,
  mayEditAnother,
  mayLeaveEditor,
  redo,
  renameDraft,
  saveDraft,
  setAnsi,
  setBase,
  setIconSet,
  setKind,
  setPane,
  setToken,
  startEditing,
  undo,
  useThemeDraft,
} from "./draft";
import { TokenHeading as Heading, TokenList } from "./tokens";

/*
 * The theme editor, Settings → Theme editor. Edits go to a draft
 * (./draft.ts) with undo and redo, shown live on the app behind the
 * dialog until saved or discarded. Leaving the section with unsaved edits
 * asks first (the dialog's leave guard); leaving drops the draft.
 *
 * Four pages: Palette (the base colors and the 16 ANSI colors, with a
 * preview), Interface (every derived token, overridable), Panes (the pane
 * background gradients) and Icons (the theme's file icon set).
 */

const PANE_LABELS: Record<string, string> = {
  default: "Default",
  terminal: "Terminal",
  "terminal-active": "Focused terminal",
  explorer: "Explorer",
  editor: "Editor",
  viewer: "Viewer",
};

const ANSI_COLUMNS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

type Page = "palette" | "interface" | "panes" | "icons";

const PAGES: { value: Page; label: string }[] = [
  { value: "palette", label: "Palette" },
  { value: "interface", label: "Interface" },
  { value: "panes", label: "Panes" },
  { value: "icons", label: "Icons" },
];

/** A large color tile for a base color. */
function BaseTile({
  field,
  label,
  value,
  auto,
  onChange,
  onReset,
}: {
  field: BaseField;
  label: string;
  value: string;
  /** Not set: derived from the others. */
  auto?: boolean;
  onChange: (value: string) => void;
  onReset?: () => void;
}) {
  return (
    <ColorPopover label={label} value={value} onChange={onChange} alpha onReset={auto ? undefined : onReset} resetLabel="Derive from accent">
      <button
        type="button"
        data-base={field}
        aria-label={`${label}: ${value}${auto ? " (derived)" : ""}`}
        className="group flex min-w-0 flex-col gap-1.5 rounded-lg p-1 text-left outline-none hover:bg-hover focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] data-[state=open]:bg-hover"
      >
        <Swatch color={value} className="h-11 w-full rounded-[6px]" />
        <span className="flex min-w-0 flex-col px-0.5">
          <span className="truncate text-meta text-fg-soft">{label}</span>
          <span className="truncate font-mono text-micro text-fg-faint">{auto ? "auto" : value}</span>
        </span>
      </button>
    </ColorPopover>
  );
}

/** A terminal and a bit of code in the draft's colors. */
function Preview({ t }: { t: ResolvedTheme["tokens"] }) {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] overflow-hidden rounded-lg font-mono text-micro leading-[1.6] shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
      style={{ background: t.app, color: t["terminal-fg"] }}
    >
      <pre className="m-0 overflow-hidden px-3 py-2.5 whitespace-pre" style={{ background: t["terminal-solid"] }}>
        <span style={{ color: t["ansi-blue"] }}>~/midterm</span> <span style={{ color: t["ansi-magenta"] }}>main</span>
        {"\n"}
        <span style={{ color: t["ansi-green"] }}>❯</span> ls -a{"\n"}
        <span style={{ color: t["ansi-bright-blue"] }}>src</span> <span style={{ color: t["ansi-cyan"] }}>bin</span>{" "}
        <span style={{ color: t["ansi-bright-black"] }}>.git</span> <span style={{ color: t["ansi-yellow"] }}>build.sh</span>
        {"\n"}
        <span style={{ color: t["ansi-green"] }}>❯</span> <span style={{ background: t["terminal-selection"] }}>make test</span>
        {"\n"}
        <span style={{ color: t["ansi-red"] }}>✗ 1 failed</span> <span style={{ color: t["ansi-bright-green"] }}>✓ 41 passed</span>
        {"\n"}
        <span style={{ color: t["ansi-green"] }}>❯</span>{" "}
        <span className="inline-block h-[1.15em] w-[0.6em] translate-y-[0.2em]" style={{ background: t["terminal-cursor"] }} />
      </pre>
      <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5" style={{ background: t.field }}>
        <pre className="m-0 overflow-hidden whitespace-pre">
          <span style={{ color: t.comment }}>{"// greet"}</span>
          {"\n"}
          <span style={{ color: t.keyword }}>const</span> <span style={{ color: t.function }}>hi</span>
          <span style={{ color: t.punctuation }}> = (</span>n<span style={{ color: t.punctuation }}>: </span>
          <span style={{ color: t.type }}>string</span>
          <span style={{ color: t.punctuation }}>)</span>
          {"\n"}
          {"  "}
          <span style={{ color: t.punctuation }}>=&gt; </span>
          <span style={{ color: t.string }}>{'"hi "'}</span> + n<span style={{ color: t.punctuation }}>;</span>
        </pre>
        <div className="mt-auto flex flex-wrap items-center gap-1 font-sans">
          <span className="rounded-[4px] px-1.5 py-px" style={{ background: t.selected, color: t["fg-bright"] }}>
            selected
          </span>
          <span className="rounded-[4px] px-1.5 py-px" style={{ background: t["accent-soft"], color: t["accent-fg"] }}>
            accent
          </span>
          <span style={{ color: t.ok }}>ok</span>
          <span style={{ color: t.warn }}>warn</span>
          <span style={{ color: t.err }}>error</span>
          <span style={{ color: t["fg-dim"] }}>dim</span>
        </div>
      </div>
    </div>
  );
}

function PalettePage({ draft, t }: { draft: Theme; t: ResolvedTheme["tokens"] }) {
  const bases: { field: BaseField; label: string; value: string; auto?: boolean }[] = [
    { field: "background", label: "Background", value: draft.background },
    { field: "foreground", label: "Text", value: draft.foreground },
    { field: "accent", label: "Accent", value: draft.accent },
    { field: "cursor", label: "Cursor", value: draft.cursor ?? t["terminal-cursor"], auto: draft.cursor === undefined },
    { field: "selection", label: "Selection", value: draft.selection ?? t["terminal-selection"], auto: draft.selection === undefined },
  ];
  return (
    <div className="flex flex-col gap-5">
      <Preview t={t} />
      <section>
        <Heading aside="every other color derives from these">Base</Heading>
        <div className="grid grid-cols-5 gap-1">
          {bases.map((base) => (
            <BaseTile
              key={base.field}
              field={base.field}
              label={base.label}
              value={base.value}
              auto={base.auto}
              onChange={(color) => setBase(base.field, color)}
              onReset={base.field === "cursor" || base.field === "selection" ? () => setBase(base.field, undefined) : undefined}
            />
          ))}
        </div>
      </section>
      <section>
        <Heading>Terminal colors</Heading>
        <div className="grid grid-cols-[44px_repeat(8,minmax(0,1fr))] items-center gap-x-1 gap-y-1">
          <span />
          {ANSI_COLUMNS.map((name) => (
            <span key={name} className="truncate text-center text-micro text-fg-faint">
              {name}
            </span>
          ))}
          {(["normal", "bright"] as const).map((row) => (
            <AnsiRow key={row} row={row} draft={draft} />
          ))}
        </div>
      </section>
    </div>
  );
}

function AnsiRow({ row, draft }: { row: "normal" | "bright"; draft: Theme }) {
  return (
    <>
      <span className="text-micro text-fg-dim">{row === "normal" ? "Normal" : "Bright"}</span>
      {ANSI_COLUMNS.map((column) => {
        const name: AnsiName = row === "normal" ? column : (`bright${column[0].toUpperCase()}${column.slice(1)}` as AnsiName);
        const value = draft.ansi[name];
        return (
          <ColorPopover key={name} label={name} value={value} alpha onChange={(color) => setAnsi(name, color)}>
            <button
              type="button"
              data-ansi={name}
              aria-label={`${name}: ${value}`}
              title={`${name} ${value}`}
              className="h-8 rounded-[5px] outline-none transition-transform hover:scale-[1.06] focus-visible:shadow-[0_0_0_2px_var(--color-app),0_0_0_3px_var(--color-accent)] data-[state=open]:shadow-[0_0_0_2px_var(--color-app),0_0_0_3px_var(--color-accent)]"
              style={{ background: value, boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--color-fg-bright) 10%, transparent)" }}
            />
          </ColorPopover>
        );
      })}
    </>
  );
}

/** Every group but the ANSI colors, which the Palette page has. */
const INTERFACE_GROUPS = (Object.keys(TOKEN_GROUPS) as TokenGroup[]).filter((group) => group !== "ansi");

function InterfacePage({ draft, resolved }: { draft: Theme; resolved: ResolvedTheme }) {
  const [filter, setFilter] = useState("");
  const overrides = draft.overrides ?? {};
  const count = Object.keys(overrides).length;
  // What each overridden token would be without its override, for the reset.
  const derived = useMemo(() => {
    const values: Partial<Record<TokenName, string>> = {};
    for (const token of Object.keys(draft.overrides ?? {}) as TokenName[]) {
      const rest = { ...draft.overrides };
      delete rest[token];
      values[token] = resolveTheme({ ...draft, overrides: rest }).tokens[token];
    }
    return values;
  }, [draft]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-faint" />
          <input
            aria-label="Filter tokens"
            placeholder="Filter colors"
            spellCheck={false}
            className={`${FIELD} w-full pl-7`}
            value={filter}
            data-escape-local={filter ? "" : undefined}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter) setFilter("");
            }}
          />
        </div>
        <span className="flex-none text-micro text-fg-faint">{count ? `${count} set by hand` : "All derived"}</span>
      </div>
      <TokenList resolved={resolved} overrides={overrides} derived={derived} groups={INTERFACE_GROUPS} filter={filter} onChange={setToken} />
    </div>
  );
}

function PanesPage({ draft, resolved }: { draft: Theme; resolved: ResolvedTheme }) {
  const keys = [...new Set([...BUILTIN_PANES, ...enabledPlugins().map((plugin) => plugin.id), ...Object.keys(draft.panes ?? {})])];
  return (
    <div className="flex flex-col gap-1">
      <Heading aside="unset parts derive from the background">Pane backgrounds</Heading>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2.5">
        {keys.map((key) => {
          const pane = resolved.panes[key] ?? resolved.panes.default;
          const own = draft.panes?.[key] ?? {};
          const set = Object.keys(own).length > 0;
          const name = PANE_LABELS[key] ?? getPlugin(key)?.plugin.name ?? key;
          return (
            <div key={key} data-pane-background={key} className="flex flex-col gap-1.5">
              <div
                className="relative flex h-[72px] flex-col justify-between rounded-lg p-1.5 shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
                style={{ background: `linear-gradient(${pane.angle}deg, ${pane.from}, ${pane.to})` }}
              >
                {(["from", "to"] as const).map((part) => (
                  <ColorPopover
                    key={part}
                    label={`${name} ${part === "from" ? "top" : "bottom"}`}
                    value={pane[part]}
                    alpha
                    onChange={(color) => setPane(key, part, color)}
                    onReset={own[part] !== undefined ? () => setPane(key, part, undefined) : undefined}
                    resetLabel="Back to derived"
                  >
                    <button
                      type="button"
                      aria-label={`${name} ${part === "from" ? "top" : "bottom"}: ${pane[part]}`}
                      className="flex w-fit items-center gap-1 rounded-[5px] bg-popover/80 py-0.5 pr-1.5 pl-0.5 font-mono text-micro text-fg-mid outline-none backdrop-blur-sm hover:text-fg-bright focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
                    >
                      <Swatch color={pane[part]} className="size-3.5 rounded-[3px]" />
                      {part === "from" ? "top" : "bottom"}
                    </button>
                  </ColorPopover>
                ))}
              </div>
              <div className="flex h-6 items-center gap-1.5 px-0.5">
                <span className={`min-w-0 flex-1 truncate text-meta ${set ? "text-fg-bright" : "text-fg-mid"}`}>{name}</span>
                <NumberField
                  label={`${name} angle`}
                  className="w-[84px]"
                  value={pane.angle}
                  min={0}
                  max={360}
                  step={5}
                  integer
                  unit="°"
                  onCommit={(angle) => setPane(key, "angle", angle)}
                />
                {set && (
                  <button type="button" aria-label={`Reset ${name}`} title="Back to derived" className={`${ICON_BUTTON} size-5!`} onClick={() => editDraft((theme) => {
                    const panes = { ...theme.panes };
                    delete panes[key];
                    theme.panes = panes;
                  })}>
                    <RotateCcw size={11} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ICON_SAMPLES: { name: string; kind: "file" | "dir"; expanded?: boolean }[] = [
  { name: "src", kind: "dir", expanded: true },
  { name: "docs", kind: "dir" },
  { name: "package.json", kind: "file" },
  { name: "main.ts", kind: "file" },
  { name: "lib.rs", kind: "file" },
  { name: "README.md", kind: "file" },
  { name: "logo.png", kind: "file" },
  { name: "notes", kind: "file" },
];

/** The theme's file icon set ("From settings" when it has none), with sample files. */
function IconsPage({ theme, t }: { theme: Theme; t: ResolvedTheme["tokens"] }) {
  useIconState((state) => state.custom);
  const loaded = useIconState((state) => state.loaded);
  const sets = allIconSets();
  const value = theme.icons?.set ?? "";
  const shownId = knownIconSet(value) ? value : activeIconSetId();
  const shown = loaded.get(shownId) ?? null;
  useEffect(() => {
    if (!shown) void loadIconSet(shownId);
  }, [shown, shownId]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="flex-1 text-ui text-fg-soft">File icon set</span>
        <Select
          label="Theme icon set"
          className="w-48"
          value={value}
          options={[
            { value: "", label: "From settings" },
            ...sets.map((set) => ({ value: set.id, label: set.name })),
            ...(value && !knownIconSet(value) ? [{ value, label: value, detail: "missing" }] : []),
          ]}
          onChange={(id) => setIconSet(id || undefined)}
        />
      </div>
      <div className="grid grid-cols-2 gap-x-4 rounded-lg px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--color-line-strong)]" style={{ background: t.app }}>
        {ICON_SAMPLES.map((sample) => (
          <span key={sample.name} className="flex h-6 items-center gap-1.5 text-meta" style={{ color: t["fg-soft"] }}>
            <FileIcon set={shown} light={theme.kind === "light"} name={sample.name} kind={sample.kind} expanded={sample.expanded} />
            {sample.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Settings → Theme editor. Edits the draft's theme; with none, starts on the theme showing. */
export function ThemeEditor() {
  const rootRef = useRef<HTMLDivElement>(null);
  const { draft, sourceId, past, future } = useThemeDraft();
  useThemeState((state) => state.custom);
  const [page, setPage] = useState<Page>("palette");

  useEffect(() => {
    if (!useThemeDraft.getState().draft) startEditing(currentTheme().id);
  }, []);
  // Leaving the section (another section, scope, or closing) with unsaved edits asks first.
  useEffect(() => guardSettingsLeave(mayLeaveEditor), []);
  // Focus the editor so its keys work at once, unless the settings search is being typed in.
  useEffect(() => {
    if (!(document.activeElement instanceof HTMLInputElement)) rootRef.current?.focus({ preventScroll: true });
  }, []);
  // ⌘S saves while the section shows. The dialog owns the keyboard (app shortcuts are off), so this is local.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s" || isConfirming()) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      // A name being typed commits on blur, before saving.
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && rootRef.current?.contains(active)) active.blur();
      if (isDraftDirty()) saveDraft();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const resolved = useMemo(() => (draft ? resolveTheme(draft) : null), [draft]);
  if (!draft || !resolved) {
    return (
      <div ref={rootRef} tabIndex={-1} className="flex h-40 items-center justify-center text-meta text-fg-dim outline-none">
        Choose a theme to edit.
      </div>
    );
  }
  const dirty = isDraftDirty();
  const t = resolved.tokens;
  const bundled = !!sourceId && isBundled(sourceId);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: ⌘Z / ⇧⌘Z from anywhere inside the editor
    <div
      ref={rootRef}
      tabIndex={-1}
      data-theme-editor=""
      className="flex flex-col outline-none"
      onKeyDown={(event) => {
        const mod = event.metaKey || event.ctrlKey;
        if (!mod || event.key.toLowerCase() !== "z") return;
        if ((event.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) redo();
        else undo();
      }}
    >
      <header className="sticky top-0 z-10 -mx-6 flex flex-col gap-2.5 border-b border-line bg-popover px-6 pt-2">
        <div className="flex items-center gap-2">
          <Select
            label="Theme to edit"
            className="w-auto! max-w-[220px] min-w-[150px]"
            value={sourceId ?? ""}
            options={allThemes().map((theme) => {
              const tokens = theme.id === sourceId ? t : null;
              return {
                value: theme.id,
                label: theme.name,
                group: theme.kind === "dark" ? "Dark" : "Light",
                icon: <Dot color={tokens?.accent ?? theme.accent} ring={theme.background} />,
                detail: isBundled(theme.id) ? undefined : "custom",
              };
            })}
            onChange={(id) => void mayEditAnother(id).then((ok) => ok && startEditing(id))}
          />
          <Segmented
            label="Light or dark"
            value={draft.kind}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
            onChange={(kind) => setKind(kind)}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <NameField name={draft.name} />
          {dirty && <span className="size-1.5 flex-none rounded-full bg-warn" title="Unsaved changes" />}
          <div className="flex-1" />
          <button type="button" className={ICON_BUTTON} disabled={past.length === 0} onClick={undo} aria-label="Undo" title="Undo (⌘Z)">
            <Undo2 size={13} />
          </button>
          <button type="button" className={ICON_BUTTON} disabled={future.length === 0} onClick={redo} aria-label="Redo" title="Redo (⇧⌘Z)">
            <Redo2 size={13} />
          </button>
          <button type="button" className={BUTTON} disabled={!dirty} onClick={discardDraft}>
            Discard
          </button>
          <Tip content={bundled ? "Built-in themes are saved as a new copy." : "Save (⌘S)"}>
            <button type="button" className={BUTTON_PRIMARY} disabled={!dirty} onClick={() => saveDraft()}>
              {bundled ? "Save as new" : "Save"}
            </button>
          </Tip>
        </div>
        <div role="tablist" aria-label="Theme editor pages" className="-mb-px flex gap-4">
          {PAGES.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={page === item.value}
              onClick={() => setPage(item.value)}
              className="h-8 border-b-2 border-transparent text-meta font-medium text-fg-dim outline-none hover:text-fg-soft focus-visible:text-fg-bright aria-selected:border-accent aria-selected:text-fg-bright"
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>
      <div role="tabpanel" className="pt-4">
        {page === "palette" && <PalettePage draft={draft} t={t} />}
        {page === "interface" && <InterfacePage draft={draft} resolved={resolved} />}
        {page === "panes" && <PanesPage draft={draft} resolved={resolved} />}
        {page === "icons" && <IconsPage theme={draft} t={t} />}
      </div>
    </div>
  );
}

/** The theme's name as an editable title; commits on Enter or blur, Escape reverts. */
function NameField({ name }: { name: string }) {
  const [text, setText] = useState(name);
  // Escape blurs the field; this keeps that blur from committing.
  const cancelled = useRef(false);
  useEffect(() => setText(name), [name]);
  return (
    <input
      aria-label="Theme name"
      spellCheck={false}
      // Escape reverts the name rather than closing the settings.
      data-escape-local=""
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (!cancelled.current && text.trim() && text !== name) renameDraft(text);
        cancelled.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelled.current = true;
          setText(name);
          event.currentTarget.blur();
        }
      }}
      className="h-7 min-w-0 rounded-[5px] bg-transparent px-1.5 -ml-1.5 text-input font-semibold text-fg-bright outline-none [field-sizing:content] max-w-[60%] hover:bg-hover focus:bg-field focus:shadow-[inset_0_0_0_1px_var(--color-accent)]"
    />
  );
}
