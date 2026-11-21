import { describe, expect, it } from "vitest";
import { parseOsc7, parsePathReport } from "./osc";

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

  it("accepts kitty's scheme", () => {
    expect(parseOsc7("kitty-shell-cwd://box/srv/app")).toEqual({ host: "box", path: "/srv/app" });
  });

  it("rejects other schemes and garbage", () => {
    expect(parseOsc7("http://h/tmp")).toBeNull();
    expect(parseOsc7("/tmp")).toBeNull();
    expect(parseOsc7("file://h/%E0%A4%A")).toBeNull();
  });
});

describe("parsePathReport", () => {
  it("decodes the path and reads the aid", () => {
    expect(parsePathReport("path=/usr/bin%3A/my%20bin;aid=12.34")).toEqual({ path: "/usr/bin:/my bin", aid: "12.34" });
    expect(parsePathReport("path=/a:/b")).toEqual({ path: "/a:/b", aid: undefined });
    expect(parsePathReport("path=")).toEqual({ path: "", aid: undefined });
  });

  it("rejects anything else", () => {
    expect(parsePathReport("aid=1")).toBeNull();
    expect(parsePathReport("/usr/bin")).toBeNull();
    expect(parsePathReport("path=%E0%A4%A")).toBeNull();
  });
});
