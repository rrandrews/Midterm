import { describe, expect, it, vi } from "vitest";
import { listMarketplaces, listPlugins, pluginArgs, runClaude, runMutation } from "./plugins";
import type { ExecFile } from "./plugins";

function fakeExec(stdout: string, stderr = "", error: Error | null = null) {
  const fn = vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
    cb(error, stdout, stderr);
  });
  return { fn, ctx: { claudePath: "/bin/claude", env: { A: "1" }, exec: fn as unknown as ExecFile } };
}

describe("plugins", () => {
  it("builds args per command", () => {
    expect(pluginArgs.install("a@b", "project")).toEqual(["plugin", "install", "--scope", "project", "--yes", "a@b"]);
    expect(pluginArgs.enable("a@b", "user")).toEqual(["plugin", "enable", "--scope", "user", "a@b"]);
    expect(pluginArgs.marketplaceUpdate()).toEqual(["plugin", "marketplace", "update"]);
    expect(pluginArgs.marketplaceUpdate("m")).toEqual(["plugin", "marketplace", "update", "m"]);
  });

  it("lists installed, with or without --available", async () => {
    const a = fakeExec('[{"id":"x@y","scope":"user","enabled":true}]');
    expect(await listPlugins(a.ctx, "/w", false)).toEqual({ installed: [{ id: "x@y", scope: "user", enabled: true }], available: [] });
    expect(a.fn.mock.calls[0].slice(0, 2)).toEqual(["/bin/claude", ["plugin", "list", "--json"]]);
    expect(a.fn.mock.calls[0][2]).toMatchObject({ cwd: "/w", env: { A: "1" }, timeout: 180_000 });
    const b = fakeExec('{"installed":[],"available":[{"pluginId":"p@m","name":"p","marketplaceName":"m"}]}');
    expect((await listPlugins(b.ctx, "/w", true)).available).toHaveLength(1);
    expect(b.fn.mock.calls[0][1]).toEqual(["plugin", "list", "--available", "--json"]);
  });

  it("lists marketplaces", async () => {
    const e = fakeExec('[{"name":"m"}]');
    expect(await listMarketplaces(e.ctx, "/w")).toEqual([{ name: "m" }]);
  });

  it("returns cleaned output of mutations", async () => {
    const e = fakeExec("\u001b[32mInstalled\u001b[0m\n", "warn\n");
    expect(await runMutation(e.ctx, "/w", ["plugin", "install", "x"])).toEqual({ output: "Installed\nwarn" });
  });

  it("fails with the last lines of output", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const e = fakeExec("", lines, new Error("exit 1"));
    await expect(runClaude(e.ctx, "/w", ["plugin"])).rejects.toThrow(/l19/);
    await expect(runClaude(e.ctx, "/w", ["plugin"])).rejects.not.toThrow(/l0\b/);
  });

  it("reports a missing claude", async () => {
    await expect(runClaude({ claudePath: undefined, env: {} }, "/w", [])).rejects.toMatchObject({ code: "notFound" });
  });
});
