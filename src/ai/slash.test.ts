import { describe, expect, it } from "vitest";
import { CMD_SYSTEM_PROMPT, buildCmdRequest, parseSlash, slashCompletesPath, slashCompletion, writeCommand } from "./slash";

describe("parseSlash", () => {
  it("parses registered commands and their arguments", () => {
    expect(parseSlash("/cmd find big files")).toMatchObject({ command: { name: "cmd" }, args: "find big files" });
    expect(parseSlash("  /cmd  ")).toMatchObject({ command: { name: "cmd" }, args: "" });
  });

  it("leaves paths and unknown names to the shell", () => {
    expect(parseSlash("/usr/bin/ls -la")).toBeNull();
    expect(parseSlash("/bin")).toBeNull();
    expect(parseSlash("/cmdx foo")).toBeNull();
    expect(parseSlash("ls /cmd")).toBeNull();
  });
});

describe("slashCompletion", () => {
  it("completes a partial name only", () => {
    expect(slashCompletion("/")?.name).toBe("cmd");
    expect(slashCompletion("/cm")?.name).toBe("cmd");
    expect(slashCompletion("/u")).toBeUndefined();
    expect(slashCompletion("/cmd x")).toBeUndefined();
    expect(slashCompletion("ls")).toBeUndefined();
  });
});

describe("slashCompletesPath", () => {
  it("completes /open's argument, not its name or other commands", () => {
    expect(parseSlash("/open src/a.ts")).toMatchObject({ command: { name: "open" }, args: "src/a.ts" });
    expect(slashCompletion("/o")?.name).toBe("open");
    expect(slashCompletesPath("/open sr", 8)).toBe(true);
    expect(slashCompletesPath("/open ", 6)).toBe(true);
    expect(slashCompletesPath("/open sr", 3)).toBe(false);
    expect(slashCompletesPath("/open", 5)).toBe(false);
    expect(slashCompletesPath("/cmd list", 9)).toBe(false);
    expect(slashCompletesPath("/opener x", 9)).toBe(false);
  });
});

describe("buildCmdRequest", () => {
  it("puts the task after the context body, redacted", () => {
    const request = buildCmdRequest("OS: macOS\n\nNo commands have been run in this terminal yet.", "log in with TOKEN=abc123secret");
    expect(request.system).toBe(CMD_SYSTEM_PROMPT);
    expect(request.prompt).not.toContain("Next command:");
    expect(request.prompt).not.toContain("abc123secret");
    expect(request.prompt).toMatch(/Task: log in with TOKEN=\[redacted\]\n\nCommand:$/);
  });
});

describe("writeCommand", () => {
  it("asks for a model for /cmd when it has no ready profile", async () => {
    await expect(writeCommand("pane-1", "list files").result).rejects.toEqual({
      kind: "other",
      message: "Choose a model for /cmd in Settings → AI.",
    });
  });
});
