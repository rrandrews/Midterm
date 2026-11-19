import { monoFontStack } from "./schema";
import { getSettings, useSettings } from "./settings";

/*
 * Applies settings that are plain CSS, as custom properties on <html>: the
 * accent color (and the text color derived from it) overriding the design
 * tokens, and `--terminal-font` / `--terminal-font-size` for monospaced
 * content drawn outside xterm (blocks, the editor).
 */

function apply(): void {
  const { accent, fontFamily, fontSize } = getSettings();
  const style = document.documentElement.style;
  style.setProperty("--terminal-font", monoFontStack(fontFamily));
  style.setProperty("--terminal-font-size", `${fontSize}px`);
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
  const key = () => {
    const { accent, fontFamily, fontSize } = getSettings();
    return `${accent}|${fontFamily}|${fontSize}`;
  };
  let last = key();
  useSettings.subscribe(() => {
    if (key() === last) return;
    last = key();
    apply();
  });
}
