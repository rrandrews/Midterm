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
});
