import { describe, expect, it } from "vitest";
import {
  contextPercent,
  diffStats,
  diffTexts,
  flattenSelectOptions,
  formatCost,
  formatElapsed,
  formatTokens,
  levelOf,
  modeTone,
  relativeTo,
} from "./format";

describe("antigravity format helpers", () => {
  it("formats relative paths against cwd and home", () => {
    expect(relativeTo("/Users/me/app/src/a.ts", "/Users/me/app", "/Users/me")).toBe("src/a.ts");
    expect(relativeTo("/Users/me/app", "/Users/me/app", "/Users/me")).toBe(".");
    expect(relativeTo("/Users/me/other/x.ts", "/Users/me/app", "/Users/me")).toBe("~/other/x.ts");
    expect(relativeTo("/etc/hosts", "/Users/me/app", "/Users/me")).toBe("/etc/hosts");
  });

  it("formats elapsed durations, tokens, cost, and context percentages", () => {
    expect(formatElapsed(50)).toBe("");
    expect(formatElapsed(1250)).toBe("1.3s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatTokens(420)).toBe("420");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(1_000_000)).toBe("1.00M");
    expect(formatCost(0.42, "USD")).toBe("$0.42");
    expect(formatCost(1.5, "credits")).toBe("1.50 credits");
    expect(contextPercent(75_000, 100_000)).toBe(75);
    expect(levelOf(50)).toBe("accent");
    expect(levelOf(75)).toBe("warn");
    expect(levelOf(95)).toBe("err");
  });

  it("computes line diffs and stats", () => {
    const lines = diffTexts("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it("flattens grouped ACP select options and derives mode tones", () => {
    const flat = flattenSelectOptions({
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "m1",
      options: [
        {
          group: "g1",
          name: "Group",
          options: [
            { value: "m1", name: "Model 1" },
            { value: "m2", name: "Model 2" },
          ],
        },
      ],
    });
    expect(flat.map((o) => o.value)).toEqual(["m1", "m2"]);
    expect(modeTone("plan")).toBe("plan");
    expect(modeTone("accept-edits")).toBe("accept");
    expect(modeTone("bypassPermissions")).toBe("bypass");
    expect(modeTone("default")).toBe("default");
  });
});
