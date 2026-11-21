import { Redo2, RotateCcw, Search, TriangleAlert, Undo2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { revealPane } from "../../actions";
import { registerPaneActions } from "../../commands/registry";
import { ColorPopover, Swatch } from "../../components/ui/ColorPicker";
import { Dot, Select } from "../../components/ui/Select";
import { Tip } from "../../components/ui/Tooltip";
import { FileIcon } from "../../icons/FileIcon";
import { activeIconSetId, allIconSets, knownIconSet, loadIconSet, useIconState } from "../../icons/state";
import { registerPaneFocuser } from "../../layout/dock";
import { enabledPlugins, getPlugin } from "../../plugins/registry";
import { BUTTON, BUTTON_PRIMARY, FIELD, ICON_BUTTON, NumberField, Segmented } from "../../settings/controls";
import { contrastRatio, resolveTheme } from "../resolve";
import { allThemes, findTheme, isBundled, useThemeState } from "../state";
import { type AnsiName, BUILTIN_PANES, type ResolvedTheme, TOKEN_GROUPS, type Theme, type TokenName } from "../types";
import {
  type BaseField,
  claimEditor,
  discardDraft,
  editDraft,
  isDraftDirty,
  mayEditAnother,
  redo,
  releaseEditor,
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

/*
 * The theme editor, a pane (the built-in `theme-editor` plugin) so edits
 * preview on the real terminals and files around it. Edits go to a draft
 * (./draft.ts) with undo and redo, shown live until saved or discarded.
 *
 * Four pages: Palette (the base colors and the 16 ANSI colors, with a
 * preview), Interface (every derived token, overridable), Panes (the pane
 * background gradients) and Icons (the theme's file icon set).
 */

/** Text tokens and the minimum contrast they should have against the window background (WCAG). */
const CONTRAST_TARGETS: Partial<Record<TokenName, number>> = {
  "fg-bright": 4.5,
  fg: 4.5,
  "fg-soft": 4.5,
  "fg-mid": 4.5,
  "fg-muted": 3,
  "fg-dim": 3,
  ok: 3,
  warn: 3,
  err: 3,
  info: 3,
  keyword: 3,
  string: 3,
  function: 3,
  type: 3,
  comment: 3,
  "terminal-fg": 4.5,
};

const GROUP_LABELS: Record<string, string> = {
  surfaces: "Surfaces",
  lines: "Lines",
  text: "Text",
  accent: "Accent",
  states: "States",
  status: "Status",
  syntax: "Syntax",
  terminal: "Terminal",
  tab: "Active tab",
};

/** What each token colors, in words. */
const TOKEN_LABELS: Partial<Record<TokenName, string>> = {
  app: "Window",
  field: "Inputs",
  popover: "Menus and dialogs",
  raised: "Raised controls",
  "terminal-solid": "Solid terminal background",
  line: "Hairlines",
  "line-menu": "Menu separators",
  "line-strong": "Outlines",
  "line-block": "Between blocks",
  "line-input": "Above the block input",
  "fg-bright": "Emphasized",
  fg: "Default",
  "fg-soft": "Soft",
  "fg-mid": "Secondary",
  "fg-muted": "Muted",
  "fg-dim": "Hints",
  "fg-faint": "Faint",
  accent: "Accent",
  "accent-soft": "Accent tint",
  "accent-fg": "Text on accent tint",
  hover: "Hover",
  selected: "Selected",
  scrim: "Modal backdrop",
  shadow: "Shadow",
  ok: "Success",
  warn: "Warning",
  err: "Error",
  info: "Info",
  keyword: "Keywords",
  comment: "Comments",
  string: "Strings",
  function: "Functions",
  type: "Types and numbers",
  punctuation: "Punctuation",
  "terminal-bg": "Background",
  "terminal-fg": "Text",
  "terminal-cursor": "Cursor",
  "terminal-cursor-accent": "Text under the cursor",
  "terminal-selection": "Selection",
  "terminal-selection-inactive": "Unfocused selection",
  "terminal-match": "Find matches",
  "terminal-match-active": "Current find match",
  "tab-active-from": "Top",
  "tab-active-to": "Bottom",
};

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

/** A page's heading. */
function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 px-0.5 pb-2">
      <h3 className="text-meta font-semibold text-fg-mid">{children}</h3>
      {aside && <span className="text-micro text-fg-faint">{aside}</span>}
    </div>
  );
}

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

function TokenRow({
  token,
  value,
  overridden,
  warning,
}: {
  token: TokenName;
  value: string;
  overridden: boolean;
  warning?: { ratio: number; target: number };
}) {
  const label = TOKEN_LABELS[token] ?? token;
  return (
    <div data-token={token} className="group/token flex h-8 items-center gap-2.5 px-2.5">
      <ColorPopover label={label} value={value} onChange={(color) => setToken(token, color)} alpha side="right" align="start" onReset={overridden ? () => setToken(token, undefined) : undefined} resetLabel="Back to derived">
        <button
          type="button"
          aria-label={`${label}: ${value}`}
          className="flex rounded-[5px] outline-none focus-visible:shadow-[0_0_0_2px_var(--color-app),0_0_0_3px_var(--color-accent)]"
        >
          <Swatch color={value} className="size-[18px] rounded-[5px]" />
        </button>
      </ColorPopover>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={`truncate text-ui ${overridden ? "text-fg-bright" : "text-fg-soft"}`}>{label}</span>
        <span className="truncate font-mono text-micro text-fg-faint">{token}</span>
      </span>
      {warning && (
        <Tip content={`Contrast ${warning.ratio.toFixed(1)}:1 against the window; aim for ${warning.target}:1.`}>
          <span className="flex flex-none items-center gap-1 rounded-[4px] bg-warn/12 px-1.5 py-px font-mono text-micro text-warn">
            <TriangleAlert size={10} />
            {warning.ratio.toFixed(1)}
          </span>
        </Tip>
      )}
      <span className="w-[68px] flex-none text-right font-mono text-micro text-fg-faint">{value}</span>
      {overridden ? (
        <button
          type="button"
          aria-label={`Reset ${token}`}
          title="Back to derived"
          onClick={() => setToken(token, undefined)}
          className={`${ICON_BUTTON} size-5!`}
        >
          <RotateCcw size={11} />
        </button>
      ) : (
        <span className="size-5 flex-none" />
      )}
    </div>
  );
}

function InterfacePage({ draft, t }: { draft: Theme; t: ResolvedTheme["tokens"] }) {
  const [filter, setFilter] = useState("");
  const overrides = draft.overrides ?? {};
  const query = filter.trim().toLowerCase();
  const matches = (token: TokenName) => !query || token.includes(query) || (TOKEN_LABELS[token] ?? "").toLowerCase().includes(query);
  const warningFor = (token: TokenName) => {
    const target = CONTRAST_TARGETS[token];
    if (!target) return undefined;
    const ratio = contrastRatio(t[token], t.app);
    return ratio < target ? { ratio, target } : undefined;
  };
  const groups = Object.entries(TOKEN_GROUPS).filter(([group]) => group !== "ansi");
  const count = Object.keys(overrides).length;
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
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <span className="flex-none text-micro text-fg-faint">{count ? `${count} set by hand` : "All derived"}</span>
      </div>
      {groups.map(([group, tokens]) => {
        const shown = (tokens as readonly TokenName[]).filter(matches);
        if (!shown.length) return null;
        return (
          <section key={group}>
            <Heading>{GROUP_LABELS[group] ?? group}</Heading>
            <div className="settings-group overflow-hidden rounded-lg bg-fg-bright/[0.025] shadow-[inset_0_0_0_1px_var(--color-line-strong)] [&>*+*]:border-t [&>*+*]:border-line">
              {shown.map((token) => (
                <TokenRow key={token} token={token} value={t[token]} overridden={token in overrides} warning={warningFor(token)} />
              ))}
            </div>
          </section>
        );
      })}
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

export function ThemeEditorPane({
  paneId,
  themeId,
  onPick,
  onSaved,
}: {
  paneId: string;
  themeId?: string;
  /** Another theme was picked (after confirming a dirty draft away). */
  onPick: (id: string) => void;
  /** The draft was saved as `id` (a bundled theme saves as a new one). */
  onSaved: (id: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { draft, sourceId, past, future, ownerPaneId } = useThemeDraft();
  useThemeState((state) => state.custom);
  const [page, setPage] = useState<Page>("palette");
  const owner = ownerPaneId === paneId;

  // One editor pane owns the draft; another one points to it.
  useEffect(() => {
    if (ownerPaneId === null) claimEditor(paneId);
  }, [ownerPaneId, paneId]);
  useEffect(() => () => releaseEditor(paneId), [paneId]);

  // The pane's theme, from its data: loaded when the data names another
  // one (its picker and the Edit command confirm a dirty draft first).
  const requested = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!owner) {
      requested.current = undefined;
      return;
    }
    if (themeId === requested.current) return;
    requested.current = themeId;
    if (themeId && findTheme(themeId) && themeId !== useThemeDraft.getState().sourceId) startEditing(themeId);
  }, [owner, themeId]);

  const save = () => {
    const saved = saveDraft();
    if (saved) {
      requested.current = saved.id;
      onSaved(saved.id);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => registerPaneFocuser(paneId, () => rootRef.current?.focus({ preventScroll: true })), [paneId]);
  useEffect(() => registerPaneActions(paneId, { save: () => saveRef.current(), undo, redo }), [paneId]);

  const resolved = useMemo(() => (draft ? resolveTheme(draft) : null), [draft]);
  if (!owner) {
    return (
      <div ref={rootRef} tabIndex={-1} className="flex h-full flex-col items-center justify-center gap-2 text-meta text-fg-dim outline-none">
        <span>The theme editor is open in another pane.</span>
        {ownerPaneId && (
          <button type="button" className={BUTTON} onClick={() => revealPane(ownerPaneId)}>
            Show it
          </button>
        )}
      </div>
    );
  }

  if (!draft || !resolved) {
    return (
      <div ref={rootRef} tabIndex={-1} className="flex h-full items-center justify-center text-meta text-fg-dim outline-none">
        Choose a theme to edit.
      </div>
    );
  }
  const dirty = isDraftDirty();
  const t = resolved.tokens;
  const bundled = !!sourceId && isBundled(sourceId);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex h-full flex-col outline-none"
      onKeyDown={(event) => {
        const mod = event.metaKey || event.ctrlKey;
        if (!mod || event.key.toLowerCase() !== "z") return;
        if ((event.target as HTMLElement).closest("input")) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) redo();
        else undo();
      }}
    >
      <header className="flex flex-none flex-col gap-2.5 border-b border-line px-4 pt-3">
        <div className="flex items-center gap-2 pr-14">
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
            onChange={(id) => void mayEditAnother(id).then((ok) => ok && onPick(id))}
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
          <Tip content={bundled ? "Built-in themes are saved as a new copy." : undefined}>
            <button type="button" className={BUTTON_PRIMARY} disabled={!dirty} onClick={save}>
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
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6">
        {page === "palette" && <PalettePage draft={draft} t={t} />}
        {page === "interface" && <InterfacePage draft={draft} t={t} />}
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
