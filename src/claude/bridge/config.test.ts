import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryFiles, readConfig, writeConfig } from "./config";

let root: string;
let cfg: string;
let cwd: string;
const saved = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridge-config-"));
  cfg = join(root, "home", ".claude");
  cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = cfg;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("config", () => {
  it("reports a missing file as empty", async () => {
    expect(await readConfig(cwd, "project")).toEqual({
      scope: "project",
      path: join(cwd, ".claude", "settings.json"),
      exists: false,
      text: "",
    });
  });

  it("writes only over the expected baseline, and refuses a changed file", async () => {
    const first = await writeConfig(cwd, "project", '{"a":1}', { exists: false, text: "" });
    expect(first.text).toBe('{"a":1}');
    // Someone else wrote meanwhile: a save against the old baseline is refused and leaves the file alone.
    await expect(writeConfig(cwd, "project", '{"b":2}', { exists: false, text: "" })).rejects.toMatchObject({ code: "conflict" });
    expect(readFileSync(first.path, "utf8")).toBe('{"a":1}');
    // Without a baseline it overwrites on purpose.
    await writeConfig(cwd, "project", '{"c":3}');
    expect(readFileSync(first.path, "utf8")).toBe('{"c":3}');
  });

  it("serializes concurrent saves of one file, so only one of two from the same baseline wins", async () => {
    const base = { exists: false, text: "" };
    const results = await Promise.allSettled([writeConfig(cwd, "local", '{"x":1}', base), writeConfig(cwd, "local", '{"y":2}', base)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(readFileSync(join(cwd, ".claude", "settings.local.json"), "utf8")).toBe('{"x":1}');
  });

  it("writes atomically, creating directories, and reads back", async () => {
    const text = '{\n  "model": "opus"\n}\n';
    const w = await writeConfig(cwd, "local", text);
    expect(w.path).toBe(join(cwd, ".claude", "settings.local.json"));
    expect(readFileSync(w.path, "utf8")).toBe(text);
    expect(readdirSync(join(cwd, ".claude"))).toEqual(["settings.local.json"]);
    expect((await readConfig(cwd, "local")).text).toBe(text);
    await writeConfig(cwd, "user", "{}");
    expect(readFileSync(join(cfg, "settings.json"), "utf8")).toBe("{}");
  });

  it("refuses text that is not a JSON object", async () => {
    await expect(writeConfig(cwd, "user", "{oops")).rejects.toMatchObject({ code: "invalid" });
    await expect(writeConfig(cwd, "user", "[1]")).rejects.toMatchObject({ code: "invalid" });
    await expect(writeConfig(cwd, "user", "null")).rejects.toMatchObject({ code: "invalid" });
  });

  it("lists memory files with existence", () => {
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "CLAUDE.md"), "x");
    writeFileSync(join(cwd, "CLAUDE.local.md"), "y");
    const files = memoryFiles(cwd).filter((f) => !f.label.startsWith("Parent memory"));
    expect(files.map((f) => [f.label, f.exists])).toEqual([
      ["User memory", true],
      ["Project memory", false],
      ["Project memory (.claude)", false],
      ["Local memory", true],
    ]);
  });

  it("keeps the mode of an existing file and writes through a symlink", async () => {
    const real = join(root, "real.json");
    writeFileSync(real, "{}");
    chmodSync(real, 0o600);
    mkdirSync(cfg, { recursive: true });
    symlinkSync(real, join(cfg, "settings.json"));
    await writeConfig(cwd, "user", '{"a":1}');
    expect(readFileSync(real, "utf8")).toBe('{"a":1}');
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(statSync(join(cfg, "settings.json")).isFile()).toBe(true);
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("includes parent folders' memory files, nearest last", () => {
    const nested = join(cwd, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(cwd, "CLAUDE.md"), "p");
    const files = memoryFiles(nested);
    const labels = files.map((f) => f.label);
    const parentIdx = files.findIndex((f) => f.path === join(cwd, "CLAUDE.md"));
    expect(parentIdx).toBeGreaterThan(0);
    expect(files[parentIdx].exists).toBe(true);
    expect(labels[parentIdx]).toMatch(/^Parent memory \(/);
    const aIdx = files.findIndex((f) => f.path === join(cwd, "a", "CLAUDE.md"));
    expect(aIdx).toBeGreaterThan(parentIdx);
    expect(labels.indexOf("Project memory")).toBeGreaterThan(aIdx);
    expect(files.some((f) => f.path === join(nested, "CLAUDE.md"))).toBe(true);
  });
});
