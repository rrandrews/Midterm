import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
    const files = memoryFiles(cwd);
    expect(files.map((f) => [f.label, f.exists])).toEqual([
      ["User memory", true],
      ["Project memory", false],
      ["Project memory (.claude)", false],
      ["Local memory", true],
    ]);
  });
});
