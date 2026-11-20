import { describe, expect, it } from "vitest";
import { comboItems } from "./Combobox";

const MODELS = ["gpt-4o", "gpt-4o-mini", "o3-mini", "claude-sonnet-4-5"];

describe("comboItems", () => {
  it("lists every option for an empty query", () => {
    const { items, more } = comboItems("  ", MODELS);
    expect(items.map((item) => item.value)).toEqual(MODELS);
    expect(items.every((item) => item.kind === "option")).toBe(true);
    expect(more).toBe(0);
  });

  it("caps the unfiltered list and counts the rest", () => {
    const many = Array.from({ length: 250 }, (_, n) => `m-${n}`);
    const { items, more } = comboItems("", many);
    expect(items).toHaveLength(200);
    expect(more).toBe(50);
    // The current value is always listed.
    const withCurrent = comboItems("", many, "m-219");
    expect(withCurrent.items).toHaveLength(220);
    expect(withCurrent.more).toBe(30);
  });

  it("offers the typed text first unless it is exactly an option", () => {
    const { items } = comboItems("4o", MODELS);
    expect(items[0]).toEqual({ kind: "use", key: "use", value: "4o" });
    expect(items.slice(1).map((item) => item.value)).toEqual(expect.arrayContaining(["gpt-4o", "gpt-4o-mini"]));
    expect(items.slice(1).map((item) => item.value)).not.toContain("o3-mini-x");
    const exact = comboItems("gpt-4o", MODELS).items;
    expect(exact.some((item) => item.kind === "use")).toBe(false);
    expect(exact[0].value).toBe("gpt-4o");
  });

  it("marks the matched characters", () => {
    const item = comboItems("sonnet", MODELS).items.find((entry) => entry.value === "claude-sonnet-4-5");
    expect(item?.kind === "option" && item.highlight).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it("offers only the typed text when nothing matches", () => {
    const { items } = comboItems("zzz-model", MODELS);
    expect(items).toEqual([{ kind: "use", key: "use", value: "zzz-model" }]);
  });
});
