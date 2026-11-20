import { describe, expect, it } from "vitest";
import { midtermDark } from "./bundled/midtermDark";
import { normalizeHex } from "./color";
import { parseTheme, slugify, validateTheme } from "./validate";

const json = () => JSON.parse(JSON.stringify(midtermDark)) as Record<string, unknown>;

describe("normalizeHex", () => {
  it("accepts #rgb, #rrggbb and #rrggbbaa, lowercased", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#A1B2C3")).toBe("#a1b2c3");
    expect(normalizeHex("#a1b2c380")).toBe("#a1b2c380");
    expect(normalizeHex("#a1b2c3ff")).toBe("#a1b2c3");
  });

  it("rejects everything else", () => {
    for (const bad of ["abc", "#abcd", "#12345", "rgb(0 0 0)", "red", "#gggggg", ""]) expect(normalizeHex(bad)).toBeNull();
  });
});

describe("validateTheme", () => {
  it("accepts a bundled theme unchanged", () => {
    expect(validateTheme(json())).toEqual({ ok: true, theme: midtermDark });
  });

  it("normalizes colors", () => {
    const data = json();
    data.background = "#ABC";
    (data.ansi as Record<string, string>).red = "#FF0000FF";
    (data.overrides as Record<string, string>).hover = "#FFFFFF10";
    const theme = parseTheme(data);
    expect(theme.background).toBe("#aabbcc");
    expect(theme.ansi.red).toBe("#ff0000");
    expect(theme.overrides?.hover).toBe("#ffffff10");
  });

  it("derives a missing id from the name", () => {
    const data = json();
    delete data.id;
    data.name = "Rosé Pine Dawn!";
    expect(parseTheme(data).id).toBe("rose-pine-dawn");
  });

  it("validates the icon set reference", () => {
    expect(parseTheme({ ...json(), icons: { set: "my-icons" } }).icons).toEqual({ set: "my-icons" });
    const bad = validateTheme({ ...json(), icons: { set: "Bad Id", size: 2 } });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors).toEqual(expect.arrayContaining(["icons.size: unknown field", expect.stringMatching(/^icons\.set:/)]));
    expect(validateTheme({ ...json(), icons: "material" }).ok).toBe(false);
  });

  it("ignores unknown top-level keys", () => {
    expect(validateTheme({ ...json(), midtermTheme: 1, extra: true }).ok).toBe(true);
  });

  it("lists every problem", () => {
    const data = json();
    data.kind = "dim";
    data.accent = "blue";
    delete (data.ansi as Record<string, string>).cyan;
    data.overrides = { "fg-brite": "#ffffff", fg: 12 };
    data.panes = { editor: { from: "#000", angle: "up", blur: 1 }, "Bad Key": {} };
    data.id = "Not An Id";
    const result = validateTheme(data);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("kind"),
        expect.stringContaining("accent"),
        "ansi.cyan: missing",
        "overrides.fg-brite: unknown token",
        expect.stringContaining("overrides.fg"),
        expect.stringContaining("panes.editor.angle"),
        "panes.editor.blur: unknown field",
        "panes.Bad Key: not a valid pane id",
        expect.stringContaining("id:"),
      ]),
    );
  });

  it("rejects non-objects", () => {
    expect(validateTheme(null).ok).toBe(false);
    expect(validateTheme([]).ok).toBe(false);
    expect(() => parseTheme("theme")).toThrow(/Invalid theme/);
  });
});

describe("slugify", () => {
  it("makes ids", () => {
    expect(slugify("Catppuccin Mocha")).toBe("catppuccin-mocha");
    expect(slugify("  --  ")).toBe("theme");
  });
});
