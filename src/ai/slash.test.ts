import { describe, expect, it } from "vitest";
import { CMD_SYSTEM_PROMPT, buildCmdRequest, parseSlash, slashCompletion, writeCommand } from "./slash";

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
