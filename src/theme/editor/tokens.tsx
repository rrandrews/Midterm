import { RotateCcw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { ColorPopover, Swatch } from "../../components/ui/ColorPicker";
import { Tip } from "../../components/ui/Tooltip";
import { ICON_BUTTON } from "../../settings/controls";
import { contrastRatio } from "../resolve";
import { type ResolvedTheme, TOKEN_GROUPS, type TokenGroup, type TokenName } from "../types";

/*
 * Token editing pieces, independent of the theme editor's draft: a row per
 * token (swatch with a color picker, value, reset to derived, contrast
 * chip) and a list of every token by group. The theme editor's Interface
 * page uses them with its draft; anything else that overrides tokens (a
 * plugin's own colors) can use them with its own state.
 */

export const GROUP_LABELS: Record<TokenGroup, string> = {
  surfaces: "Surfaces",
  lines: "Lines",
  text: "Text",
  accent: "Accent",
  states: "States",
  status: "Status",
  syntax: "Syntax",
  terminal: "Terminal",
  ansi: "Terminal colors",
  tab: "Active tab",
};

/** What each token colors, in words (the ANSI colors are named by `tokenLabel`). */
export const TOKEN_LABELS: Partial<Record<TokenName, string>> = {
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

/** A token's name in words: `fg-dim` → "Hints", `ansi-bright-red` → "Bright red". */
export function tokenLabel(token: TokenName): string {
  const label = TOKEN_LABELS[token];
  if (label) return label;
  if (token.startsWith("ansi-")) {
    const words = token.slice("ansi-".length).replace(/-/g, " ");
    return words[0].toUpperCase() + words.slice(1);
  }
  return token;
}

/** Text tokens and the minimum contrast they should have against the window background (WCAG). */
export const CONTRAST_TARGETS: Partial<Record<TokenName, number>> = {
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

/** The contrast of a text token against `background` when it is below the token's target; otherwise `undefined`. */
export function contrastWarning(token: TokenName, value: string, background: string): { ratio: number; target: number } | undefined {
  const target = CONTRAST_TARGETS[token];
  if (!target) return undefined;
  const ratio = contrastRatio(value, background);
  return ratio < target ? { ratio, target } : undefined;
}

/** Whether a token matches a filter query (its id or its name in words). */
export function tokenMatches(token: TokenName, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || token.includes(q) || tokenLabel(token).toLowerCase().includes(q);
}

/** A small heading over a group of rows. */
export function TokenHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 px-0.5 pb-2">
      <h3 className="text-meta font-semibold text-fg-mid">{children}</h3>
      {aside && <span className="text-micro text-fg-faint">{aside}</span>}
    </div>
  );
}

export type TokenRowProps = {
  token: TokenName;
  /** The color shown: the override when set, else the derived color. */
  value: string;
  /** The color without the override (shown on the reset), when known. */
  derived?: string;
  /** Whether the token is set by hand; shows it brighter, with a reset. */
  overridden: boolean;
  /** A new color, or `undefined` to go back to derived. */
  onChange: (value: string | undefined) => void;
  /** A background to check the token's contrast against (text tokens only); no chip without it. */
  contrastAgainst?: string;
};

/** One token: swatch (click for a picker with alpha and a hex field), name, contrast chip, value and reset. */
export function TokenRow({ token, value, derived, overridden, onChange, contrastAgainst }: TokenRowProps) {
  const label = tokenLabel(token);
  const warning = contrastAgainst ? contrastWarning(token, value, contrastAgainst) : undefined;
  const resetLabel = derived ? `Back to derived (${derived})` : "Back to derived";
  return (
    <div data-token={token} className="group/token flex h-8 items-center gap-2.5 px-2.5">
      <ColorPopover
        label={label}
        value={value}
        onChange={(color) => onChange(color)}
        alpha
        side="right"
        align="start"
        onReset={overridden ? () => onChange(undefined) : undefined}
        resetLabel={resetLabel}
      >
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
        <button type="button" aria-label={`Reset ${token}`} title={resetLabel} onClick={() => onChange(undefined)} className={`${ICON_BUTTON} size-5!`}>
          <RotateCcw size={11} />
        </button>
      ) : (
        <span className="size-5 flex-none" />
      )}
    </div>
  );
}

export type TokenListProps = {
  /** The theme the values come from (overrides applied); its window color is the contrast background. */
  resolved: ResolvedTheme;
  /** The tokens set by hand. */
  overrides: Partial<Record<TokenName, string>>;
  /** A token's new color, or `undefined` to go back to derived. */
  onChange: (token: TokenName, value: string | undefined) => void;
  /** Shows only tokens whose id or name contains this text. */
  filter?: string;
  /** The groups to show, in order; every group by default. */
  groups?: readonly TokenGroup[];
  /** Each overridden token's color without its override, for the reset. */
  derived?: Partial<Record<TokenName, string>>;
};

const ALL_GROUPS = Object.keys(TOKEN_GROUPS) as TokenGroup[];

/** Every token by group, with group headings, as rows of `TokenRow`. */
export function TokenList({ resolved, overrides, onChange, filter = "", groups = ALL_GROUPS, derived }: TokenListProps) {
  const t = resolved.tokens;
  const shownGroups = groups
    .map((group) => [group, (TOKEN_GROUPS[group] as readonly TokenName[]).filter((token) => tokenMatches(token, filter))] as const)
    .filter(([, tokens]) => tokens.length > 0);
  if (!shownGroups.length) return <div className="px-0.5 text-meta text-fg-dim">No colors match.</div>;
  return (
    <div className="flex flex-col gap-4">
      {shownGroups.map(([group, tokens]) => (
        <section key={group}>
          <TokenHeading>{GROUP_LABELS[group]}</TokenHeading>
          <div className="settings-group overflow-hidden rounded-lg bg-fg-bright/[0.025] shadow-[inset_0_0_0_1px_var(--color-line-strong)] [&>*+*]:border-t [&>*+*]:border-line">
            {tokens.map((token) => (
              <TokenRow
                key={token}
                token={token}
                value={t[token]}
                derived={derived?.[token]}
                overridden={overrides[token] !== undefined}
                onChange={(value) => onChange(token, value)}
                contrastAgainst={t.app}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
