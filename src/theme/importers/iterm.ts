import { chroma, p3FloatsToHex, rgbFloatsToHex } from "../color";
import { ANSI_NAMES, type AnsiPalette, type Theme } from "../types";
import { type ImportOptions, buildTheme } from "./common";

/*
 * iTerm2 `.itermcolors`: an XML property list whose top-level dict maps
 * "Ansi 0 Color" … "Ansi 15 Color", "Background Color", "Foreground Color",
 * "Cursor Color", "Cursor Text Color", "Selection Color" (and more, ignored)
 * to dicts of "Red/Green/Blue/Alpha Component" floats plus an optional
 * "Color Space". "P3" components are converted from Display P3; "sRGB",
 * "Calibrated" (generic RGB, close enough to sRGB for a palette) and a missing
 * color space (old files) are read as sRGB.
 */

type Plist = string | number | boolean | Plist[] | { [key: string]: Plist };

/** Parses an iTerm2 `.itermcolors` file. `options.name` names the theme (the format has no name field). */
export function importItermColors(text: string, options: ImportOptions = {}): Theme {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Not an iTerm2 color file: the XML is malformed");
  const root = doc.documentElement;
  if (root?.nodeName !== "plist") throw new Error("Not an iTerm2 color file: no <plist> root");
  const top = firstElement(root);
  const dict = top ? readValue(top) : undefined;
  if (!dict || typeof dict !== "object" || Array.isArray(dict)) {
    throw new Error("Not an iTerm2 color file: the plist has no top-level dict");
  }

  const color = (key: string): string | undefined => {
    const value = dict[key];
    return value && typeof value === "object" && !Array.isArray(value) ? toHex(value, key) : undefined;
  };

  const ansi: Partial<AnsiPalette> = {};
  ANSI_NAMES.forEach((name, i) => {
    ansi[name] = color(`Ansi ${i} Color`);
  });
  const background = color("Background Color");
  const foreground = color("Foreground Color");
  if (!background || !foreground) {
    throw new Error("Not an iTerm2 color file: no Background Color or Foreground Color");
  }
  const cursor = color("Cursor Color");
  // A colorful cursor is the theme's signature color; a gray one says nothing, so use blue.
  const accent = cursor && chroma(cursor) > 0.05 ? cursor : ansi.blue;

  return buildTheme({
    name: options.name ?? "Imported iTerm2 Theme",
    background,
    foreground,
    accent,
    cursor,
    selection: color("Selection Color"),
    ansi,
    overrides: { "terminal-cursor-accent": color("Cursor Text Color") },
  });
}

function toHex(dict: { [key: string]: Plist }, key: string): string {
  const component = (name: string, fallback?: number): number => {
    const value = dict[`${name} Component`];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`iTerm2 color file: "${key}" has no ${name} Component`);
  };
  const r = component("Red");
  const g = component("Green");
  const b = component("Blue");
  const alpha = component("Alpha", 1);
  const space = typeof dict["Color Space"] === "string" ? dict["Color Space"].toLowerCase() : "srgb";
  return space === "p3" ? p3FloatsToHex(r, g, b, alpha) : rgbFloatsToHex(r, g, b, alpha);
}

function firstElement(node: Element): Element | undefined {
  for (const child of Array.from(node.childNodes)) if (child.nodeType === 1) return child as Element;
  return undefined;
}

function elements(node: Element): Element[] {
  return Array.from(node.childNodes).filter((n): n is Element => n.nodeType === 1);
}

function readValue(el: Element): Plist {
  switch (el.nodeName) {
    case "dict": {
      const out: { [key: string]: Plist } = {};
      const children = elements(el);
      for (let i = 0; i < children.length; i++) {
        if (children[i].nodeName !== "key") continue;
        const value = children[i + 1];
        if (value && value.nodeName !== "key") {
          out[(children[i].textContent ?? "").trim()] = readValue(value);
          i++;
        }
      }
      return out;
    }
    case "array":
      return elements(el).map(readValue);
    case "real":
    case "integer":
      return Number((el.textContent ?? "").trim());
    case "true":
      return true;
    case "false":
      return false;
    default:
      return el.textContent ?? "";
  }
}
