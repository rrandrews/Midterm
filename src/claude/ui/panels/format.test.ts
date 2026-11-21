import { describe, expect, it } from "vitest";
import { formatAgo, formatCost, formatDuration, formatPercent, formatTokens, formatUntil, shortModel, tildePath, usageTone } from "./format";

describe("panel formatting", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(67_200)).toBe("67k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.25M");
  });

  it("formats costs and durations", () => {
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.42)).toBe("$0.42");
    expect(formatCost(12.3, "EUR")).toBe("12.30 EUR");
    expect(formatDuration(840)).toBe("840ms");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
  });

  it("formats relative times", () => {
    const now = Date.UTC(2026, 10, 21, 12);
    expect(formatUntil(now + (3 * 60 + 12) * 60_000, now)).toBe("3h 12m");
    expect(formatUntil(now + 30_000, now)).toBe("<1m");
    expect(formatUntil(now + 50 * 3_600_000, now)).toBe("2d 2h");
    expect(formatUntil(now - 1, now)).toBe("now");
    expect(formatAgo(now - 10_000, now)).toBe("just now");
    expect(formatAgo(now - 14 * 60_000, now)).toBe("14m ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatAgo(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(formatAgo(now - 4 * 86_400_000, now)).toBe("4d ago");
  });

  it("formats percentages, paths, models and tones", () => {
    expect(formatPercent(1, 400)).toBe("<1%");
    expect(formatPercent(67, 200)).toBe("34%");
    expect(tildePath("/Users/me/src", "/Users/me")).toBe("~/src");
    expect(tildePath("/Users/meg", "/Users/me")).toBe("/Users/meg");
    expect(shortModel("claude-opus-4-5-20251101")).toBe("opus-4-5");
    expect(usageTone(69)).toBe("accent");
    expect(usageTone(70)).toBe("warn");
    expect(usageTone(90)).toBe("err");
  });
});
