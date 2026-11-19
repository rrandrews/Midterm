import {
  type Oklab,
  type Oklch,
  type Rgb,
  clampChroma,
  converter,
  modeLrgb,
  modeOklab,
  modeOklch,
  modeP3,
  modeRgb,
  toGamut,
  useMode,
  wcagLuminance,
} from "culori/fn";

/*
 * Color helpers for theme resolution, on top of culori's tree-shakable
 * `culori/fn` build (only the modes registered here are bundled). Colors go in
 * and come out as lowercase hex: `#rrggbb`, or `#rrggbbaa` when translucent.
 */

useMode(modeRgb);
useMode(modeLrgb);
useMode(modeOklab);
useMode(modeOklch);
useMode(modeP3);

const toOklab = converter("oklab");
const toOklch = converter("oklch");
const toRgb = converter("rgb");
const rgbGamut = toGamut("rgb", "oklch");

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Normalizes `#rgb`, `#rrggbb` or `#rrggbbaa` to lowercase `#rrggbb` (an
 * opaque alpha byte is dropped) or `#rrggbbaa`. Anything else is null.
 */
export function normalizeHex(value: string): string | null {
  const v = value.trim();
  if (!HEX.test(v)) return null;
  let hex = v.toLowerCase();
  if (hex.length === 4) hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  if (hex.length === 9 && hex.endsWith("ff")) hex = hex.slice(0, 7);
  return hex;
}

/** Parses a normalized (or any accepted) hex color into culori's rgb. Throws on anything else. */
export function parseHex(value: string): Rgb {
  const hex = normalizeHex(value);
  if (!hex) throw new Error(`Not a hex color: ${value}`);
  const byte = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  const rgb: Rgb = { mode: "rgb", r: byte(1), g: byte(3), b: byte(5) };
  if (hex.length === 9) rgb.alpha = byte(7);
  return rgb;
}

const byteHex = (x: number) =>
  Math.round(Math.min(1, Math.max(0, x)) * 255)
    .toString(16)
    .padStart(2, "0");

/** Formats any culori color as lowercase hex, mapping it into sRGB first. */
export function toHex(color: Rgb | Oklab | Oklch): string {
  const rgb = toRgb(rgbGamut(color)) as Rgb;
  const base = `#${byteHex(rgb.r)}${byteHex(rgb.g)}${byteHex(rgb.b)}`;
  if (rgb.alpha === undefined || Math.round(rgb.alpha * 255) >= 255) return base;
  return base + byteHex(rgb.alpha);
}

/** `#rrggbb` of an sRGB color given as 0–1 floats (alpha optional). */
export function rgbFloatsToHex(r: number, g: number, b: number, alpha?: number): string {
  return toHex({ mode: "rgb", r, g, b, alpha });
}

/** `#rrggbb` of a Display P3 color given as 0–1 floats, gamut-mapped to sRGB. */
export function p3FloatsToHex(r: number, g: number, b: number, alpha?: number): string {
  return toHex(toOklch({ mode: "p3", r, g, b, alpha }) as Oklch);
}

/** The color with its alpha set to `alpha` (0–1). */
export function withAlpha(hex: string, alpha: number): string {
  return toHex({ ...parseHex(hex), alpha });
}

/** The color without its alpha. */
export function opaque(hex: string): string {
  return toHex({ ...parseHex(hex), alpha: undefined });
}

/**
 * Mixes `a` toward `b` by `t` (0 = a, 1 = b) in OKLab. A `t` outside 0–1
 * extrapolates (used for "brighter than the foreground"); the result is
 * gamut-mapped. Alpha is dropped.
 */
export function mix(a: string, b: string, t: number): string {
  const x = toOklab(parseHex(opaque(a))) as Oklab;
  const y = toOklab(parseHex(opaque(b))) as Oklab;
  return toHex({
    mode: "oklab",
    l: Math.min(1, Math.max(0, x.l + (y.l - x.l) * t)),
    a: x.a + (y.a - x.a) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

/**
 * Shifts OKLCH lightness by `dl` (negative darkens), scaling chroma by
 * `chroma` (1 = unchanged). Hue is kept, so a tinted background stays tinted.
 */
export function shiftLightness(hex: string, dl: number, chroma = 1): string {
  const c = toOklch(parseHex(opaque(hex))) as Oklch;
  return toHex(
    clampChroma({ ...c, l: Math.min(1, Math.max(0, c.l + dl)), c: c.c * Math.max(0, chroma) }, "oklch") as Oklch,
  );
}

/** OKLCH lightness, 0–1. */
export function lightness(hex: string): number {
  return (toOklch(parseHex(opaque(hex))) as Oklch).l;
}

/** OKLCH chroma. */
export function chroma(hex: string): number {
  return (toOklch(parseHex(opaque(hex))) as Oklch).c;
}

/** WCAG relative luminance of the opaque color. */
export function luminance(hex: string): number {
  return wcagLuminance(parseHex(opaque(hex)));
}

/** `fg` composited over the opaque `bg` (a no-op for an opaque `fg`). */
export function composite(fg: string, bg: string): string {
  const f = parseHex(fg);
  const b = parseHex(opaque(bg));
  const a = f.alpha ?? 1;
  return toHex({ mode: "rgb", r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a) });
}

/**
 * WCAG 2 contrast ratio (1–21) between two hex colors. A translucent `a` is
 * composited over `b` first; `b`'s own alpha is ignored.
 */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(composite(a, b));
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Moves `color` toward `toward` in small OKLab steps until it reaches
 * `ratio` contrast against `bg` (or `toward` itself).
 */
export function ensureContrast(color: string, bg: string, ratio: number, toward: string): string {
  let out = color;
  for (let t = 0.1; t <= 1.0001 && contrastRatio(out, bg) < ratio; t += 0.1) out = mix(color, toward, t);
  return out;
}
