import { describe, expect, it } from "vitest";
import { fitDimensions } from "./fit";

describe("fitDimensions", () => {
  const base = { width: 800, height: 380, paddingX: 0, paddingY: 0, cellWidth: 8, cellHeight: 19 };

  it("uses the whole width: no strip is kept for the scroll bar", () => {
    expect(fitDimensions(base)).toEqual({ cols: 100, rows: 20 });
  });

  it("subtracts padding and rounds down", () => {
    expect(fitDimensions({ ...base, width: 807, paddingX: 6, height: 400, paddingY: 4 })).toEqual({
      cols: 100,
      rows: 20,
    });
  });

  it("never goes below xterm's minimum", () => {
    expect(fitDimensions({ ...base, width: 3, height: 2 })).toEqual({ cols: 2, rows: 1 });
  });

  it("returns null before the cell size is known", () => {
    expect(fitDimensions({ ...base, cellWidth: 0 })).toBeNull();
  });
});
