import { describe, expect, it } from "vitest";
import { terminalTitle } from "./titles";

const shell = { pid: 1, name: "zsh", isShell: true };
const vim = { pid: 2, name: "vim", isShell: false };

describe("terminalTitle", () => {
  it("names the running program", () => {
    expect(terminalTitle(vim, "/Users/me/src", "/Users/me")).toBe("vim");
  });

  it("names the directory while the shell waits", () => {
    expect(terminalTitle(shell, "/Users/me/src/app", "/Users/me")).toBe("app");
    expect(terminalTitle(shell, "/Users/me", "/Users/me/")).toBe("~");
    expect(terminalTitle(shell, "/", "/Users/me")).toBe("/");
  });

  it("falls back to the shell's name, then to nothing", () => {
    expect(terminalTitle(shell, undefined, "/Users/me")).toBe("zsh");
    expect(terminalTitle(null, undefined, undefined)).toBeUndefined();
    expect(terminalTitle({ ...vim, name: "" }, "/tmp", undefined)).toBe("tmp");
  });

  it("formats remote SSH locations with host label and remote home", () => {
    const rHome = "ssh://prod-0123456789ab/home/deploy";
    expect(terminalTitle(shell, "ssh://prod-0123456789ab/home/deploy/api", rHome, "prod")).toBe("prod:api");
    expect(terminalTitle(shell, "ssh://prod-0123456789ab/home/deploy", rHome, "prod")).toBe("prod:~");
    expect(terminalTitle(shell, "ssh://prod-0123456789ab/", rHome, "prod")).toBe("prod:/");
    expect(terminalTitle(vim, "ssh://prod-0123456789ab/home/deploy/api", rHome, "prod")).toBe("prod: vim");
    // Local home must never shorten a remote location.
    expect(terminalTitle(shell, "ssh://prod-0123456789ab/Users/me", "/Users/me", "prod")).toBe("prod:me");
  });
});
