import { monoFontStack } from "./schema";
import { getSettings, useSettings } from "./settings";

/*
 * Applies settings that are plain CSS, as custom properties on <html>:
 * `--terminal-font` / `--terminal-font-size` for monospaced content drawn
 * outside xterm (blocks, the editor). Colors, the accent included, come
 * from the theme (src/theme/apply.ts).
 */

function apply(): void {
  const { fontFamily, fontSize } = getSettings();
  const style = document.documentElement.style;
  style.setProperty("--terminal-font", monoFontStack(fontFamily));
  style.setProperty("--terminal-font-size", `${fontSize}px`);
}

let installed = false;

/** Applies the current settings and keeps them applied. */
export function installSettingsStyles(): void {
  if (installed) return;
  installed = true;
  apply();
  const key = () => {
    const { fontFamily, fontSize } = getSettings();
    return `${fontFamily}|${fontSize}`;
  };
  let last = key();
  useSettings.subscribe(() => {
    if (key() === last) return;
    last = key();
    apply();
  });
}
