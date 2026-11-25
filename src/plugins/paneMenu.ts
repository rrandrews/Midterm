import { activePlugin } from "./registry";
import { HIDEABLE_PANE_MENU_ITEMS, type HideablePaneMenuItem, type PaneContext } from "./types";

/**
 * The built-in items a pane's plugin leaves out (`pane.hideMenuItems`).
 * Unknown names are ignored, and a failing plugin hides nothing.
 */
export function hiddenMenuItems(kind: string | undefined, ctx: PaneContext | undefined): Set<HideablePaneMenuItem> {
  const hide = kind ? activePlugin(kind)?.pane.hideMenuItems : undefined;
  if (!hide) return new Set();
  try {
    const names = typeof hide === "function" ? (ctx ? hide(ctx) : []) : hide;
    return new Set(Array.isArray(names) ? names.filter((name) => HIDEABLE_PANE_MENU_ITEMS.includes(name)) : []);
  } catch (error) {
    console.error(`The ${kind} plugin's hideMenuItems failed:`, error);
    return new Set();
  }
}
