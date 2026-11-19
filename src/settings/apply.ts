import { getSettings, useSettings } from "./settings";

/*
 * Applies settings that are plain CSS: the accent color (and the text color
 * derived from it) as overrides of the design tokens on <html>.
 */

function apply(): void {
  const { accent } = getSettings();
  const style = document.documentElement.style;
  style.setProperty("--color-accent", accent);
  // A pale tint of the accent for text on `accent-soft` (#DDE2FF for the default).
  style.setProperty("--color-accent-fg", `color-mix(in srgb, ${accent} 30%, white)`);
}

let installed = false;

/** Applies the current settings and keeps them applied. */
export function installSettingsStyles(): void {
  if (installed) return;
  installed = true;
  apply();
  let last = getSettings().accent;
  useSettings.subscribe((state) => {
    if (state.accent === last) return;
    last = state.accent;
    apply();
  });
}
