// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
  sizes: new Map<string, number>(),
  reads: [] as string[],
}));

vi.mock("../ipc/fs", () => ({
  fileVersion: async (path: string) => {
    const size = fs.sizes.get(path);
    return size === undefined ? null : { mtime: "0", size };
  },
  readTextFile: async (path: string) => {
    fs.reads.push(path);
    return {
      kind: "text",
      text: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h${fs.sizes.get(path) ?? 1}v1z"/></svg>`,
      version: { mtime: "0", size: 0 },
    };
  },
  writeTextFile: async () => ({ kind: "written" }),
}));

const { parseIconSetFile } = await import("./files");

const fileOf = (definitions: Record<string, unknown>) => JSON.stringify({ name: "Set", file: "a", definitions });

describe("parseIconSetFile", () => {
  beforeEach(() => {
    fs.sizes.clear();
    fs.reads.length = 0;
  });

  it("inlines path definitions relative to the file", async () => {
    fs.sizes.set("/sets/icons/a.svg", 100);
    const set = await parseIconSetFile("/sets/set.json", fileOf({ a: { path: "icons/a.svg", mono: true } }));
    expect(set.definitions.a.svg).toContain("<svg");
    expect(set.definitions.a.mono).toBe(true);
  });

  it("checks the icon count before reading anything", async () => {
    const definitions = Object.fromEntries(Array.from({ length: 4001 }, (_, i) => [`i${i}`, { path: `${i}.svg` }]));
    await expect(parseIconSetFile("/s/set.json", fileOf(definitions))).rejects.toThrow(/more than 4000/);
    expect(fs.reads).toEqual([]);
  });

  it("does not read an icon file over 64 KB", async () => {
    fs.sizes.set("/s/a.svg", 70_000);
    await expect(parseIconSetFile("/s/set.json", fileOf({ a: { path: "a.svg" } }))).rejects.toThrow(/larger than 64 KB/);
    expect(fs.reads).toEqual([]);
  });

  it("stops reading once the set would pass 4 MB", async () => {
    const definitions: Record<string, unknown> = {};
    for (let i = 0; i < 80; i += 1) {
      fs.sizes.set(`/s/${i}.svg`, 60_000);
      definitions[`i${i}`] = { path: `${i}.svg` };
    }
    await expect(parseIconSetFile("/s/set.json", fileOf(definitions))).rejects.toThrow(/larger than 4 MB/);
    expect(fs.reads.length).toBeLessThan(70);
  });

  it("refuses absolute paths and files that are not SVG", async () => {
    await expect(parseIconSetFile("/s/set.json", fileOf({ a: { path: "/etc/passwd.svg" } }))).rejects.toThrow(/relative path/);
    await expect(parseIconSetFile("/s/set.json", fileOf({ a: { path: "a.png" } }))).rejects.toThrow(/\.svg/);
  });
});
