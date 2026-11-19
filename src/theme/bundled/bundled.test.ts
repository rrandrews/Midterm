import { describe, expect, it } from "vitest";
import { kindOf } from "../importers/common";
import { contrastRatio, resolveTheme } from "../resolve";
import { validateTheme } from "../validate";
import { BUNDLED_THEMES, bundledTheme } from ".";

describe("bundled themes", () => {
  it("has unique ids and the full list", () => {
    const ids = BUNDLED_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(16);
    expect(bundledTheme("nord")?.name).toBe("Nord");
  });

  for (const theme of BUNDLED_THEMES) {
    describe(theme.name, () => {
      it("is valid and already normalized", () => {
        expect(validateTheme(JSON.parse(JSON.stringify(theme)))).toEqual({ ok: true, theme });
      });

      it("credits its source", () => {
        expect(theme.author).toBeTruthy();
        if (!theme.id.startsWith("midterm-")) {
          expect(theme.source).toMatch(/^https:\/\//);
          expect(theme.license).toBeTruthy();
        }
      });

      it("has a kind that matches its background", () => {
        expect(kindOf(theme.background)).toBe(theme.kind);
      });

      it("resolves to readable text", () => {
        const { tokens } = resolveTheme(theme);
        // 4 rather than 4.5: Solarized Light's official base00 on base3 is 4.1.
        expect(contrastRatio(tokens.fg, tokens.app)).toBeGreaterThanOrEqual(4);
        expect(contrastRatio(tokens["fg-muted"], tokens.app)).toBeGreaterThanOrEqual(2.5);
        for (const name of ["ok", "warn", "err", "info", "keyword", "string", "function", "type"] as const) {
          expect([name, contrastRatio(tokens[name], tokens.app) >= 2.5]).toEqual([name, true]);
        }
      });
    });
  }
});
