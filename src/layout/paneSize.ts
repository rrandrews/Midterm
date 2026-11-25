import type { PaneSizeLimits } from "../plugins/types";
import type { Layout } from "../state/types";

/*
 * Pane size limits. A plugin may declare `pane.size` (pixels); the host
 * clamps it to `PANE_SIZE_BOUNDS` and writes it onto the frame (the
 * library's tabset `minWidth`, `minHeight`, `maxWidth`, `maxHeight`) of
 * every pane of that kind. Pure: the plugin lookup is passed in.
 */

/** The defaults every frame has (`tabsetMinWidth` / `tabsetMinHeight` in PaneLayout). */
export const DEFAULT_MIN_WIDTH = 96;
export const DEFAULT_MIN_HEIGHT = 56;

/** What a plugin may ask for: minimums within a range, maximums no smaller than a floor (or the minimum). */
export const PANE_SIZE_BOUNDS = {
  minWidth: { min: DEFAULT_MIN_WIDTH, max: 800 },
  minHeight: { min: DEFAULT_MIN_HEIGHT, max: 600 },
  maxWidth: { min: 160 },
  maxHeight: { min: 100 },
} as const;

/** The frame fields the library takes, as CSS pixel strings; unset means the default (no override, no maximum). */
export type FrameLimits = { minWidth?: string; minHeight?: string; maxWidth?: string; maxHeight?: string };

const LIMIT_KEYS = ["minWidth", "minHeight", "maxWidth", "maxHeight"] as const;

const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const px = (value: number | undefined) => (value === undefined ? undefined : `${Math.round(value)}px`);

/** A plugin's limits made safe: invalid values dropped, minimums clamped, maximums at least the floor and the minimum. */
export function clampSizeLimits(limits: PaneSizeLimits | undefined): FrameLimits {
  if (!limits || typeof limits !== "object") return {};
  const { minWidth, minHeight, maxWidth, maxHeight } = PANE_SIZE_BOUNDS;
  const clamp = (value: number, min: number, max = Number.POSITIVE_INFINITY) => Math.min(max, Math.max(min, value));
  const minW = valid(limits.minWidth) ? clamp(limits.minWidth, minWidth.min, minWidth.max) : undefined;
  const minH = valid(limits.minHeight) ? clamp(limits.minHeight, minHeight.min, minHeight.max) : undefined;
  const maxW = valid(limits.maxWidth) ? Math.max(limits.maxWidth, maxWidth.min, minW ?? 0) : undefined;
  const maxH = valid(limits.maxHeight) ? Math.max(limits.maxHeight, maxHeight.min, minH ?? 0) : undefined;
  return { minWidth: px(minW), minHeight: px(minH), maxWidth: px(maxW), maxHeight: px(maxH) };
}

type Frame = Extract<Layout["root"], { type: "tabset" }>;

/** The frame updates that make each frame's limits match its pane's kind (`limitsOf`). */
export function frameLimitUpdates(layout: Layout, limitsOf: (kind: string) => FrameLimits): { frameId: string; limits: FrameLimits }[] {
  const updates: { frameId: string; limits: FrameLimits }[] = [];
  const visit = (frame: Frame) => {
    const pane = frame.tabs.find((tab) => tab.id === frame.selectedId) ?? frame.tabs[0];
    const wanted = pane ? limitsOf(pane.data.kind) : {};
    if (LIMIT_KEYS.some((key) => frame[key] !== wanted[key])) {
      updates.push({ frameId: frame.id, limits: Object.fromEntries(LIMIT_KEYS.map((key) => [key, wanted[key]])) });
    }
  };
  const walk = (node: Layout["root"]) => {
    if (node.type === "tabset") visit(node);
    else node.children.forEach(walk);
  };
  walk(layout.root);
  for (const floating of layout.floating ?? []) visit(floating);
  return updates;
}

/** The layout with every frame's limits set from its pane's kind; the same object when nothing changes. */
export function withSizeLimits(layout: Layout, limitsOf: (kind: string) => FrameLimits): Layout {
  const updates = new Map(frameLimitUpdates(layout, limitsOf).map(({ frameId, limits }) => [frameId, limits]));
  if (updates.size === 0) return layout;
  const apply = (frame: Frame): Frame => {
    const limits = updates.get(frame.id);
    if (!limits) return frame;
    const next: Frame = { ...frame };
    for (const key of LIMIT_KEYS) {
      if (limits[key] === undefined) delete next[key];
      else next[key] = limits[key];
    }
    return next;
  };
  const walk = (node: Layout["root"]): Layout["root"] =>
    node.type === "tabset" ? apply(node) : { ...node, children: node.children.map(walk) as typeof node.children };
  return { ...layout, root: walk(layout.root), ...(layout.floating && { floating: layout.floating.map((frame) => apply(frame) as typeof frame) }) };
}
