import { describe, expect, it } from "vitest";
import { CMD_SYSTEM_PROMPT, buildCmdRequest, parseSlash, slashCompletion } from "./slash";

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
  it("replaces the next-command question with the task, redacted", () => {
    const request = buildCmdRequest(
      { system: "x", prompt: "OS: macOS\n\nNo commands have been run in this terminal yet.\n\nNext command:" },
      "log in with TOKEN=abc123secret",
    );
    expect(request.system).toBe(CMD_SYSTEM_PROMPT);
    expect(request.prompt).not.toContain("Next command:");
    expect(request.prompt).not.toContain("abc123secret");
    expect(request.prompt).toMatch(/Task: log in with TOKEN=\[redacted\]\n\nCommand:$/);
  });
});
