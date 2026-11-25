import { describe, expect, it } from "vitest";
import { splitAtLinks } from "./blockRender";

describe("splitAtLinks", () => {
  const text = (segments: ReturnType<typeof splitAtLinks>) =>
    segments.map((segment) => (segment.link ? `[${segment.runs.map((run) => run.text).join("|")}]` : segment.runs.map((run) => run.text).join("|")));

  it("wraps link ranges across runs, keeping their styles", () => {
    const runs = [{ text: "ab ", fg: "red" }, { text: "cd", bold: true }, { text: " ef" }];
    const segments = splitAtLinks(runs, [{ start: 3, end: 5 }, { start: 6, end: 8 }]);
    expect(text(segments)).toEqual(["ab ", "[cd]", " ", "[ef]"]);
    expect(segments[1].runs[0]).toMatchObject({ text: "cd", bold: true });
  });

  it("splits a run a link starts or ends inside", () => {
    const segments = splitAtLinks([{ text: "see src/a.ts now" }], [{ start: 4, end: 12 }]);
    expect(text(segments)).toEqual(["see ", "[src/a.ts]", " now"]);
  });

  it("joins a link's pieces from several runs", () => {
    const segments = splitAtLinks([{ text: "sr", fg: "blue" }, { text: "c/", fg: "green" }, { text: " x" }], [{ start: 0, end: 4 }]);
    expect(text(segments)).toEqual(["[sr|c/]", " x"]);
  });

  it("leaves a line without links whole", () => {
    expect(text(splitAtLinks([{ text: "plain" }], []))).toEqual(["plain"]);
  });
});
