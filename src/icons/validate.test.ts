// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { minimalSet } from "./sets/minimal";
import { createCustomSet } from "./state";
import type { IconQuery } from "./types";
import { exportIconSet, parseIconSet, validateIconSet } from "./validate";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>';
const BUNDLED = ["material", "minimal", "none"];

const base = {
  name: "My Icons",
  definitions: { ts: { svg: SVG }, doc: { svg: SVG, mono: true }, dir: { svg: SVG } },
  file: "doc",
  folder: "dir",
  fileExtensions: { ts: "ts" },
};

describe("validateIconSet", () => {
  it("accepts a set, derives its id and sanitizes icons", () => {
    const result = validateIconSet({ ...base, definitions: { ...base.definitions, ts: { svg: SVG.replace("<path", '<path onclick="x()"') } } }, BUNDLED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.set.id).toBe("my-icons");
    expect(result.set.definitions.ts.svg).not.toContain("onclick");
    expect(result.set.definitions.doc.mono).toBe(true);
  });

  it("reports mappings to unknown icons, bad ids and unknown bases", () => {
    const result = validateIconSet(
      { ...base, id: "Bad Id", extends: "nope", fileNames: { "a.txt": "missing" }, definitions: { ...base.definitions, "bad id": { svg: SVG } } },
      BUNDLED,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(/id: "Bad Id"/);
    expect(result.errors.join("\n")).toMatch(/extends: "nope"/);
    expect(result.errors.join("\n")).toMatch(/fileNames\.a\.txt: "missing"/);
    expect(result.errors.join("\n")).toMatch(/definitions\.bad id/);
  });

  it("rejects unsafe or oversized icons", () => {
    expect(validateIconSet({ ...base, definitions: { ts: { svg: "<div/>" } }, file: undefined, folder: undefined }, BUNDLED).ok).toBe(false);
    expect(validateIconSet({ ...base, definitions: { ts: { svg: "x".repeat(70_000) } } }, BUNDLED).ok).toBe(false);
  });

  it("keeps __proto__ keys as data", () => {
    const set = parseIconSet({ ...base, fileNames: { __proto__: "ts" } as unknown as Record<string, string> }, BUNDLED);
    expect(Object.getPrototypeOf(set)).toBe(Object.prototype);
  });

  it("round-trips through the file format", () => {
    const set = parseIconSet({ ...base, extends: "minimal", light: { fileExtensions: { ts: "doc" } } }, BUNDLED);
    const again = parseIconSet(JSON.parse(exportIconSet(set)), BUNDLED);
    expect(again).toEqual(set);
  });
});

describe("custom sets over a base", () => {
  const query = (name: string, extra: Partial<IconQuery> = {}): IconQuery => ({ name, kind: "file", expanded: false, light: false, ...extra });
  const set = parseIconSet({ ...base, extends: "minimal" }, BUNDLED);
  const loaded = createCustomSet(set, minimalSet);

  it("uses its own specific icons first", () => {
    const image = loaded.icon(query("a.ts"));
    expect(image && "url" in image && image.url.startsWith("data:image/svg+xml")).toBe(true);
  });

  it("lets the base's specific icons beat its own fallbacks", () => {
    const image = loaded.icon(query("notes.md"));
    expect(image && "lucide" in image).toBe(true);
  });

  it("uses its own fallbacks before the base's", () => {
    const image = loaded.icon(query("notes"));
    expect(image && "url" in image && image.mono).toBe(true);
  });
});
