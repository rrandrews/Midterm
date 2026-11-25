import { afterEach, describe, expect, it } from "vitest";
import type { MidtermApi } from "./api";
import { hiddenMenuItems } from "./paneMenu";
import { installPluginHost, registerPlugin } from "./registry";
import type { PaneContext, PanePlugin } from "./types";

installPluginHost((pluginId) => ({ pluginId }) as unknown as MidtermApi);

const plugin = (id: string, pane: Partial<PanePlugin["pane"]>): PanePlugin => ({ id, name: id, pane: { mount: () => () => {}, ...pane } });
const ctx = { paneId: "p1" } as PaneContext;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("hiddenMenuItems", () => {
  it("hides nothing for a plugin that does not ask, or an unknown kind", () => {
    cleanups.push(registerPlugin(plugin("plain", {})));
    expect(hiddenMenuItems("plain", ctx).size).toBe(0);
    expect(hiddenMenuItems("missing", ctx).size).toBe(0);
    expect(hiddenMenuItems(undefined, ctx).size).toBe(0);
  });

  it("takes a list and ignores names it does not know, including the items that cannot be hidden", () => {
    const hideMenuItems = ["splitRight", "agent", "close", "settings", "bogus"] as unknown as PanePlugin["pane"]["hideMenuItems"];
    cleanups.push(registerPlugin(plugin("listed", { hideMenuItems })));
    expect([...hiddenMenuItems("listed", ctx)].sort()).toEqual(["agent", "splitRight"]);
  });

  it("asks a function with the pane's context, and survives one that throws", () => {
    cleanups.push(
      registerPlugin(plugin("dynamic", { hideMenuItems: (context) => (context.paneId === "p1" ? ["maximize"] : []) })),
      registerPlugin(
        plugin("broken", {
          hideMenuItems: () => {
            throw new Error("nope");
          },
        }),
      ),
    );
    expect([...hiddenMenuItems("dynamic", ctx)]).toEqual(["maximize"]);
    expect(hiddenMenuItems("dynamic", undefined).size).toBe(0);
    const error = console.error;
    console.error = () => {};
    try {
      expect(hiddenMenuItems("broken", ctx).size).toBe(0);
    } finally {
      console.error = error;
    }
  });
});
