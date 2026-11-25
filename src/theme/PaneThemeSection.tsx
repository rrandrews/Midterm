import { ChevronRight, RotateCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ColorPopover, Swatch } from "../components/ui/ColorPicker";
import { BUTTON, FIELD, Group, ICON_BUTTON, Row, Select } from "../settings/controls";
import { useScopedActions, useScopedSettings, useSettingsScope } from "../settings/scope";
import { TokenList } from "./editor/tokens";
import { PANE_THEME_KEY, type PaneTheme, paneBaseTheme, paneThemeOf, withPaneOverrides } from "./paneTheme";
import { composite, opaque } from "./color";
import { paneBackground as paneBackgroundOf, resolveTheme } from "./resolve";
import { allThemes, useThemeRevision, useThemeState } from "./state";
import type { TokenName } from "./types";

/*
 * Settings → a plugin → Theme: the theme its panes show (the app's by
 * default, or any other), the pane background, and any token set by hand
 * on top. Every plugin's section has it. Saved as the plugin setting
 * `$theme` (src/theme/paneTheme.ts), so a workspace can override it.
 */

const SAME_AS_APP = "";

export function PaneThemeSection({ pluginId }: { pluginId: string }) {
  const scope = useSettingsScope();
  const { updatePluginSettings } = useScopedActions();
  const settings = useScopedSettings((state) => state);
  const systemDark = useThemeState((state) => state.systemDark);
  useThemeState((state) => state.custom);
  const revision = useThemeRevision();
  const paneTheme = paneThemeOf(pluginId, settings);
  const [open, setOpen] = useState(() => !!paneTheme?.overrides);
  const [filter, setFilter] = useState("");

  const overrides = paneTheme?.overrides ?? {};
  const count = Object.keys(overrides).length;
  const base = paneBaseTheme(paneTheme, settings, systemDark);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` follows the app theme (draft, preview) that `base` may be.
  const { resolved, derived } = useMemo(() => {
    const resolved = resolveTheme(withPaneOverrides(base, overrides));
    // What each overridden token would be without its override, for the reset.
    const derived: Partial<Record<TokenName, string>> = {};
    for (const token of Object.keys(overrides) as TokenName[]) {
      const rest = { ...overrides };
      delete rest[token];
      derived[token] = resolveTheme(withPaneOverrides(base, rest)).tokens[token];
    }
    return { resolved, derived };
  }, [base, JSON.stringify(overrides), revision]);

  const write = (next: PaneTheme) => {
    const empty = !next.theme && !next.background && !Object.keys(next.overrides ?? {}).length;
    // A workspace saves an empty value as its override ("the app's theme here"); the defaults drop it.
    updatePluginSettings(pluginId, { [PANE_THEME_KEY]: empty ? (scope && scope !== "default" ? {} : undefined) : next });
  };
  const update = (patch: Partial<PaneTheme>) => write({ ...paneTheme, ...patch });
  const setToken = (token: TokenName, value: string | undefined) => {
    const next = { ...overrides };
    if (value === undefined) delete next[token];
    else next[token] = value;
    update({ overrides: Object.keys(next).length ? next : undefined });
  };
  const anything = !!(paneTheme?.theme || paneTheme?.background || count);

  const themes = allThemes();
  const options = [
    { value: SAME_AS_APP, label: "Same as the app" },
    ...themes.map((theme) => ({
      value: theme.id,
      label: theme.name,
      group: theme.kind === "dark" ? "Dark" : "Light",
      icon: <Swatch color={theme.background} className="size-3 rounded-[3px]" />,
    })),
  ];
  const themeValue = paneTheme?.theme && themes.some((theme) => theme.id === paneTheme.theme) ? paneTheme.theme : SAME_AS_APP;
  const paneBackground = paneBackgroundOf(resolved, pluginId);
  // Pane colors can be translucent over the window: show what is seen.
  const shownBackground = paneTheme?.background ?? opaque(composite(paneBackground.from, resolved.tokens.app));

  return (
    <Group
      title="Theme"
      help="Colors for these panes only. Anything not set here follows the app's theme."
      actions={
        anything && (
          <button type="button" className={BUTTON} onClick={() => write({})}>
            Reset
          </button>
        )
      }
    >
      <Row label="Theme" setting={`plugins.${pluginId}.settings.${PANE_THEME_KEY}`}>
        <Select
          label="Pane theme"
          value={themeValue}
          options={options}
          onChange={(id) => update({ theme: id || undefined })}
          className="w-56"
        />
      </Row>
      <Row label="Background" hint={paneTheme?.background ? undefined : "From the theme"}>
        <ColorPopover
          label="Pane background"
          value={shownBackground}
          onChange={(color) => update({ background: color })}
          align="end"
          onReset={paneTheme?.background ? () => update({ background: undefined }) : undefined}
          resetLabel="Back to the theme's"
        />
      </Row>
      <div className="settings-row">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-h-10 w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-fg-soft outline-none hover:bg-hover focus-visible:bg-hover"
        >
          <ChevronRight size={12} className={`flex-none text-fg-dim transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="flex-1">Colors</span>
          <span className="text-meta text-fg-dim">{count ? `${count} set by hand` : "From the theme"}</span>
        </button>
        {open && (
          <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-faint" />
                <input
                  aria-label="Filter colors"
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
              {count > 0 && (
                <button type="button" aria-label="Reset all colors" title="Reset all colors" className={ICON_BUTTON} onClick={() => update({ overrides: undefined })}>
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
            <TokenList resolved={resolved} overrides={overrides} derived={derived} filter={filter} onChange={setToken} />
          </div>
        )}
      </div>
    </Group>
  );
}
