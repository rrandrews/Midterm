import { describe, expect, it } from "vitest";
import {
  fallbackHostLabel,
  formatRemoteLocation,
  isAbsoluteLocation,
  isRemotePath,
  isRootLocation,
  isValidRemoteId,
  normalizeLocation,
  normalizePosixPath,
  parseLocation,
  posixPathOf,
  remoteIdOf,
  resolveLocation,
  sameHost,
} from "./location";

describe("location", () => {
  it("parses local and remote locations and rejects malformed ssh URIs", () => {
    expect(parseLocation("/Users/me/proj")).toEqual({ kind: "local", path: "/Users/me/proj" });
    expect(parseLocation("ssh://prod-0123456789ab/srv/app")).toEqual({
      kind: "remote",
      remoteId: "prod-0123456789ab",
      path: "/srv/app",
    });
    expect(parseLocation("ssh://prod-0123456789ab/")).toEqual({
      kind: "remote",
      remoteId: "prod-0123456789ab",
      path: "/",
    });
    expect(parseLocation("ssh://prod-0123456789ab/srv/app///")).toEqual({
      kind: "remote",
      remoteId: "prod-0123456789ab",
      path: "/srv/app",
    });
    expect(parseLocation("")).toBeNull();
    expect(parseLocation("ssh://prod")).toBeNull();
    expect(parseLocation("ssh:///etc/hosts")).toBeNull();
    expect(parseLocation("ssh://bad id/etc")).toBeNull();
    expect(parseLocation("ssh://../etc")).toBeNull();
    expect(parseLocation("ssh://prod/a\0b")).toBeNull();
  });

  it("formats, inspects, and compares hosts cleanly", () => {
    expect(formatRemoteLocation("box", "/")).toBe("ssh://box/");
    expect(formatRemoteLocation("box", "/home/dev/")).toBe("ssh://box/home/dev");
    expect(formatRemoteLocation("box", "home/dev")).toBe("ssh://box/home/dev");

    expect(isRemotePath("ssh://box/etc")).toBe(true);
    expect(isRemotePath("ssh://box")).toBe(false);
    expect(isRemotePath("/etc")).toBe(false);

    expect(remoteIdOf("ssh://box/etc")).toBe("box");
    expect(remoteIdOf("/etc")).toBeNull();

    expect(posixPathOf("ssh://box/srv/app")).toBe("/srv/app");
    expect(posixPathOf("ssh://box/")).toBe("/");
    expect(posixPathOf("/Users/me")).toBe("/Users/me");

    expect(isRootLocation("/")).toBe(true);
    expect(isRootLocation("ssh://box/")).toBe(true);
    expect(isRootLocation("ssh://box/tmp")).toBe(false);
    expect(isRootLocation("/tmp")).toBe(false);

    expect(isAbsoluteLocation("/tmp")).toBe(true);
    expect(isAbsoluteLocation("ssh://box/tmp")).toBe(true);
    expect(isAbsoluteLocation("rel/path")).toBe(false);

    expect(sameHost("/a", "/b")).toBe(true);
    expect(sameHost("ssh://box/a", "ssh://box/b")).toBe(true);
    expect(sameHost("ssh://box/a", "ssh://other/a")).toBe(false);
    expect(sameHost("ssh://box/a", "/a")).toBe(false);
  });

  it("normalizes and resolves relative/absolute paths preserving host", () => {
    expect(normalizePosixPath("/a/./b/../c")).toBe("/a/c");
    expect(normalizeLocation("ssh://box/a/./b/../c")).toBe("ssh://box/a/c");
    expect(normalizeLocation("ssh://box/../../etc")).toBe("ssh://box/etc");

    expect(resolveLocation("../src/app.ts", "ssh://box/repo/docs")).toBe("ssh://box/repo/src/app.ts");
    expect(resolveLocation("/etc/hosts", "ssh://box/repo/docs")).toBe("ssh://box/etc/hosts");
    expect(resolveLocation("../src/app.ts", "/repo/docs")).toBe("/repo/src/app.ts");
  });

  it("validates remote ids and derives readable fallback labels", () => {
    expect(isValidRemoteId("prod-0123456789ab")).toBe(true);
    expect(isValidRemoteId("user@host_1.local")).toBe(true);
    expect(isValidRemoteId("a".repeat(128))).toBe(true);
    expect(isValidRemoteId("a".repeat(129))).toBe(false);
    expect(isValidRemoteId("..")).toBe(false);
    expect(isValidRemoteId("a/b")).toBe(false);
    expect(sameHost("ssh://bad id/a", "/a")).toBe(false);
    expect(fallbackHostLabel("prod-0123456789ab")).toBe("prod");
    expect(fallbackHostLabel("custombox")).toBe("custombox");
  });
});
