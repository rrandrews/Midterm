import { Popover } from "radix-ui";
import { RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { HexAlphaColorPicker, HexColorInput } from "react-colorful";
import { registerPaneActions } from "../../commands/registry";
import { registerPaneFocuser } from "../../layout/dock";
import { enabledPlugins } from "../../plugins/registry";
import { BUTTON, CommitField, FIELD } from "../../settings/controls";
import { normalizeHex } from "../color";
import { contrastRatio, resolveTheme } from "../resolve";
import { allThemes, findTheme, isBundled, useThemeState } from "../state";
import { ANSI_NAMES, type AnsiName, BUILTIN_PANES, TOKEN_GROUPS, type Theme, type TokenName, ansiToken } from "../types";
import { revealPane } from "../../actions";
import {
  type BaseField,
  claimEditor,
  mayEditAnother,
  releaseEditor,
  discardDraft,
  isDraftDirty,
  redo,
  renameDraft,
  saveDraft,
  setAnsi,
  setBase,
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

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="relative size-4 flex-none overflow-hidden rounded-[4px] shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
      style={{ background: "repeating-conic-gradient(#8888 0% 25%, transparent 0% 50%) 50% / 8px 8px" }}
    >
      <span className="absolute inset-0" style={{ background: color }} />
    </span>
  );
}

/** A color with a picker in a popover (hex with alpha). */
function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`${label}: ${value}`}
        className="flex items-center gap-1.5 rounded-[4px] px-1 py-0.5 font-mono text-micro text-fg-mid outline-none hover:bg-hover focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
      >
        <Swatch color={value} />
        <span className="w-[68px] text-left">{value}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="left"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 flex flex-col gap-2 rounded-lg bg-popover p-2.5 shadow-menu outline-none"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <HexAlphaColorPicker color={value} onChange={(color) => onChange(normalizeHex(color) ?? color)} />
          <HexColorInput
            alpha
            prefixed
            aria-label={`${label} hex`}
            color={value}
            onChange={(color) => {
              const hex = normalizeHex(color);
              if (hex) onChange(hex);
            }}
            className={`${FIELD} w-full font-mono`}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({
  name,
  value,
  overridden,
  onChange,
  onReset,
  warning,
}: {
  name: string;
  value: string;
  overridden: boolean;
  onChange: (value: string) => void;
  onReset?: () => void;
  warning?: string;
}) {
  return (
    <div className="flex h-7 items-center gap-2 pr-1 pl-3" data-token={name}>
      <span className={`min-w-0 flex-1 truncate font-mono text-micro ${overridden ? "text-fg-soft" : "text-fg-dim"}`} title={name}>
        {name}
      </span>
      {warning && (
        <span className="flex-none text-micro text-warn" title={warning}>
          ⚠ {warning.split(" ")[0]}
        </span>
      )}
      <span className="w-14 flex-none text-right text-micro text-fg-faint">{overridden ? "set" : "derived"}</span>
      <ColorControl label={name} value={value} onChange={onChange} />
      <button
        type="button"
        aria-label={`Reset ${name}`}
        title={overridden ? "Back to derived" : undefined}
        disabled={!overridden || !onReset}
        onClick={onReset}
        className="flex flex-none p-0.5 text-fg-dim hover:text-fg disabled:opacity-0"
      >
        <RotateCcw size={11} />
      </button>
    </div>
  );
}

function Group({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group border-b border-line/60">
      <summary className="flex h-7 cursor-default items-center px-3 text-meta font-medium text-fg-mid select-none hover:text-fg-soft">
        {title}
      </summary>
      <div className="pb-1">{children}</div>
    </details>
  );
}

/** A strip showing the draft's colors in use: ANSI, code, UI states. */
function Samples({ theme }: { theme: Theme }) {
  const t = resolveTheme(theme).tokens;
  return (
    <div className="flex flex-col gap-2 border-b border-line/60 p-3" style={{ background: t.app, color: t.fg }}>
      <div className="grid grid-cols-8 gap-0.5 overflow-hidden rounded-[4px]">
        {ANSI_NAMES.map((name) => (
          <div key={name} title={name} className="h-4" style={{ background: t[ansiToken(name)] }} />
        ))}
      </div>
      <pre className="m-0 overflow-hidden rounded-[4px] px-2 py-1.5 font-mono text-micro leading-relaxed" style={{ background: t.field }}>
        <span style={{ color: t.comment }}>{"// a sample"}</span>
        {"\n"}
        <span style={{ color: t.keyword }}>const</span> <span style={{ color: t.function }}>greet</span>
        <span style={{ color: t.punctuation }}> = (</span>name<span style={{ color: t.punctuation }}>: </span>
        <span style={{ color: t.type }}>string</span>
        <span style={{ color: t.punctuation }}>) =&gt; </span>
        <span style={{ color: t.string }}>{'"hi "'}</span> + name<span style={{ color: t.punctuation }}>;</span>
      </pre>
      <div className="flex flex-wrap items-center gap-1.5 text-micro">
        <span className="rounded-[4px] px-1.5 py-0.5" style={{ background: t.hover }}>hover</span>
        <span className="rounded-[4px] px-1.5 py-0.5" style={{ background: t.selected, color: t["fg-bright"] }}>selected</span>
        <span className="rounded-[4px] px-1.5 py-0.5" style={{ background: t["accent-soft"], color: t["accent-fg"] }}>accent</span>
        <span style={{ color: t.ok }}>ok</span>
        <span style={{ color: t.warn }}>warn</span>
        <span style={{ color: t.err }}>error</span>
        <span style={{ color: t.info }}>info</span>
        <span style={{ color: t["fg-dim"] }}>dim</span>
        <span style={{ color: t["fg-faint"] }}>faint</span>
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
  const [filter, setFilter] = useState("");
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

  const resolved = useMemo(() => (draft ? resolveTheme(draft) : null), [draft]);
  if (!draft || !resolved) {
    return (
      <div ref={rootRef} tabIndex={-1} className="flex h-full items-center justify-center text-meta text-fg-dim outline-none">
        Choose a theme to edit.
      </div>
    );
  }
  const dirty = isDraftDirty();
  const t = resolved.tokens;
  const overrides = draft.overrides ?? {};
  const matches = (name: string) => !filter || name.toLowerCase().includes(filter.toLowerCase());
  const warningFor = (token: TokenName) => {
    const target = CONTRAST_TARGETS[token];
    if (!target) return undefined;
    const ratio = contrastRatio(t[token], t.app);
    return ratio < target ? `${ratio.toFixed(1)}:1 against the background (aim for ${target}:1)` : undefined;
  };
  const baseRows: [BaseField, string, string | undefined][] = [
    ["background", draft.background, undefined],
    ["foreground", draft.foreground, undefined],
    ["accent", draft.accent, undefined],
    ["cursor", draft.cursor ?? t["terminal-cursor"], draft.cursor],
    ["selection", draft.selection ?? t["terminal-selection"], draft.selection],
  ];
  const paneKeys = [...new Set([...BUILTIN_PANES, ...enabledPlugins().map((plugin) => plugin.id), ...Object.keys(draft.panes ?? {})])];

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
      <div className="flex flex-none flex-col gap-1.5 border-b border-line px-3 pt-2 pr-16 pb-2">
        <div className="flex items-center gap-1.5">
          <select
            aria-label="Theme to edit"
            className={`${FIELD} min-w-0 flex-1`}
            value={sourceId ?? ""}
            onChange={(event) => {
              const id = event.target.value;
              void mayEditAnother(id).then((ok) => ok && onPick(id));
            }}
          >
            {allThemes().map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
          <select aria-label="Light or dark" className={FIELD} value={draft.kind} onChange={(event) => setKind(event.target.value as Theme["kind"])}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <CommitField label="Theme name" className="min-w-0 flex-1" value={draft.name} onCommit={renameDraft} />
          <button type="button" className={BUTTON} disabled={past.length === 0} onClick={undo} title="Undo (⌘Z)">
            Undo
          </button>
          <button type="button" className={BUTTON} disabled={future.length === 0} onClick={redo} title="Redo (⇧⌘Z)">
            Redo
          </button>
          <button type="button" className={BUTTON} disabled={!dirty} onClick={discardDraft}>
            Discard
          </button>
          <button type="button" className={`${BUTTON} ${dirty ? "bg-accent-soft text-accent-fg" : ""}`} disabled={!dirty} onClick={save}>
            {sourceId && isBundled(sourceId) ? "Save as new" : "Save"}
          </button>
        </div>
        <input
          aria-label="Filter tokens"
          placeholder="Filter tokens"
          className={`${FIELD} w-full`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Samples theme={draft} />
        <Group title="Base palette">
          {baseRows
            .filter(([name]) => matches(name))
            .map(([name, value, optional]) => (
              <Row
                key={name}
                name={name}
                value={value}
                overridden={name === "cursor" || name === "selection" ? optional !== undefined : true}
                onChange={(color) => setBase(name, color)}
                onReset={name === "cursor" || name === "selection" ? () => setBase(name, undefined) : undefined}
              />
            ))}
        </Group>
        {Object.entries(TOKEN_GROUPS)
          .filter(([group]) => group !== "ansi")
          .map(([group, tokens]) => {
            const shown = (tokens as readonly TokenName[]).filter(matches);
            if (!shown.length) return null;
            return (
              <Group key={group} title={GROUP_LABELS[group] ?? group}>
                {shown.map((token) => (
                  <Row
                    key={token}
                    name={token}
                    value={t[token]}
                    overridden={token in overrides}
                    warning={warningFor(token)}
                    onChange={(color) => setToken(token, color)}
                    onReset={() => setToken(token, undefined)}
                  />
                ))}
              </Group>
            );
          })}
        <Group title="Terminal ANSI colors">
          {ANSI_NAMES.filter((name) => matches(name) || matches(ansiToken(name))).map((name: AnsiName) => (
            <Row key={name} name={name} value={draft.ansi[name]} overridden onChange={(color) => setAnsi(name, color)} />
          ))}
        </Group>
        <Group title="Pane backgrounds" open={false}>
          {paneKeys
            .filter((key) => matches(key) || matches("pane"))
            .flatMap((key) => {
              const pane = resolved.panes[key] ?? resolved.panes.default;
              const own = draft.panes?.[key] ?? {};
              return (["from", "to"] as const).map((part) => (
                <Row
                  key={`${key}:${part}`}
                  name={`${key} ${part === "from" ? "top" : "bottom"}`}
                  value={pane[part]}
                  overridden={own[part] !== undefined}
                  onChange={(color) => setPane(key, part, color)}
                  onReset={() => setPane(key, part, undefined)}
                />
              ));
            })}
        </Group>
      </div>
    </div>
  );
}
