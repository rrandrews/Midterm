import { describe, expect, it } from "vitest";
import { parseOsc7 } from "./osc";

describe("parseOsc7", () => {
  it("parses host and path", () => {
    expect(parseOsc7("file://mac.local/Users/ron/Code")).toEqual({
      host: "mac.local",
      path: "/Users/ron/Code",
    });
  });

  it("decodes percent-encoding", () => {
    expect(parseOsc7("file://h/tmp/a%20b/%C3%A9t%C3%A9")?.path).toBe("/tmp/a b/été");
  });

  it("allows an empty host and the root directory", () => {
    expect(parseOsc7("file:///")).toEqual({ host: "", path: "/" });
  });

  it("drops a trailing slash", () => {
    expect(parseOsc7("file://h/tmp/")?.path).toBe("/tmp");
  });

  it("rejects other schemes and garbage", () => {
    expect(parseOsc7("http://h/tmp")).toBeNull();
    expect(parseOsc7("/tmp")).toBeNull();
    expect(parseOsc7("file://h/%E0%A4%A")).toBeNull();
  });
});
