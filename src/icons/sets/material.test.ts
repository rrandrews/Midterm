import manifest from "material-icon-theme/dist/material-icons.json";
import upstreamLicense from "material-icon-theme/LICENSE?raw";
import shippedLicense from "../../../public/licenses/material-icon-theme.txt?raw";
import { describe, expect, it } from "vitest";
import type { IconImage, IconQuery } from "../types";
import { createMaterialSet, materialUrls } from "./material";

const set = createMaterialSet();
const urlOf = (image: IconImage | null) => (image && "url" in image ? image.url : null);
const query = (name: string, extra: Partial<IconQuery> = {}): IconQuery => ({ name, kind: "file", expanded: false, light: false, ...extra });

describe("material icon set", () => {
  it("has an SVG for every icon in the manifest", () => {
    // Fails loudly if a version bump moves the files.
    expect(materialUrls().size).toBe(Object.keys(manifest.iconDefinitions).length);
  });

  it("maps common names", () => {
    expect(urlOf(set.icon(query("package.json")))).toMatch(/nodejs\.svg/);
    expect(urlOf(set.icon(query("Dockerfile")))).toMatch(/docker\.svg/);
    expect(urlOf(set.icon(query("lib.rs")))).toMatch(/rust\.svg/);
    expect(urlOf(set.icon(query("x.test.ts")))).toMatch(/test-ts\.svg/);
    expect(urlOf(set.icon(query("main.ts")))).toMatch(/typescript\.svg/);
    expect(urlOf(set.icon(query("src", { kind: "dir" })))).toMatch(/folder-src\.svg/);
    expect(urlOf(set.icon(query("src", { kind: "dir", expanded: true })))).toMatch(/folder-src-open\.svg/);
    expect(urlOf(set.icon(query("no-such-thing", { kind: "dir" })))).toMatch(/folder\.svg/);
    expect(urlOf(set.icon(query("no-such-thing")))).toMatch(/\/file\.svg/);
  });

  it("ships the package's license unchanged (public/licenses, copied into dist)", () => {
    expect(shippedLicense).toBe(upstreamLicense);
  });

  it("returns only name matches when asked", () => {
    expect(set.icon(query("no-such-thing"), true)).toBeNull();
  });
});
