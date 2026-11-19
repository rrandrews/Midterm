import { describe, expect, it } from "vitest";
import { OUTPUT_HEAD_LINES, OUTPUT_TAIL_LINES, buildContext, parseSuggestion, redact, trimOutput } from "./context";

describe("redact", () => {
  it.each([
    ["export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123", "export GITHUB_TOKEN=[redacted]"],
    ["AWS_SECRET_ACCESS_KEY='abc/def+ghi'", "AWS_SECRET_ACCESS_KEY=[redacted]"],
    ['DB_PASSWORD="hunter2 two"', "DB_PASSWORD=[redacted]"],
    ["curl -H 'Authorization: Bearer abcdef123456789'", "curl -H 'Authorization: Bearer [redacted]'"],
    ["mysql --password=hunter22 db", "mysql --password=[redacted] db"],
    ["git clone https://me:s3cret@github.com/x/y", "git clone https://me:[redacted]@github.com/x/y"],
    ["key sk-ant-api03-abcdefghijklmnopqrstuv", "key [redacted]"],
    ["id AKIAABCDEFGHIJKLMNOP", "id [redacted]"],
    ["jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f", "jwt [redacted]"],
  ])("%s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("removes a whole private key", () => {
    const text = "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\nafter";
    expect(redact(text)).toBe("before\n[redacted]\nafter");
  });

  it("leaves ordinary text alone", () => {
    const text = "git log --oneline\n2cdd4c3 Merge branch 'x'\nnpm run build -- --mode production";
    expect(redact(text)).toBe(text);
  });
});

describe("trimOutput", () => {
  it("keeps the head and tail of long output and strips escapes", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `\x1b[31mline ${i}\x1b[0m`);
    const out = trimOutput(lines.join("\n")).split("\n");
    expect(out).toHaveLength(OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES + 1);
    expect(out[0]).toBe("line 0");
    expect(out[OUTPUT_HEAD_LINES]).toBe("… (60 lines omitted)");
    expect(out[out.length - 1]).toBe("line 99");
  });

  it("redacts a private key whose header falls in the omitted middle", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const body = Array.from({ length: 40 }, (_, i) => `KEYBODY${i}abcdefghijklmnop`);
    const text = [...filler, "-----BEGIN RSA PRIVATE KEY-----", ...body, "-----END RSA PRIVATE KEY-----", "done"].join("\n");
    expect(trimOutput(text)).not.toContain("KEYBODY");
  });
});

describe("buildContext", () => {
  it("lists facts, earlier commands and blocks, redacted", () => {
    const { prompt, system } = buildContext({
      os: "macOS",
      shell: "zsh",
      cwd: "~/proj",
      branch: "main",
      recentCommands: ["ls", "cd proj", "export API_KEY=abc123", "git status"],
      blocks: [{ command: "git status", exitCode: 0, output: "On branch main\nChanges not staged" }],
    });
    expect(system).toContain("next command");
    expect(prompt).toContain("Shell: zsh");
    expect(prompt).toContain("Git branch: main");
    expect(prompt).toContain("Earlier commands (oldest first):\nls\ncd proj\nexport API_KEY=[redacted]");
    expect(prompt).toContain("$ git status\nOn branch main\nChanges not staged\n[exit 0]");
    expect(prompt).not.toContain("abc123");
    expect(prompt.endsWith("Next command:")).toBe(true);
  });
});

describe("parseSuggestion", () => {
  it.each([
    ["git push", "git push"],
    ["  `npm test`  ", "npm test"],
    ["```bash\nls -la\n```", "ls -la"],
    ["$ make build\nThis builds it.", "make build"],
    ["", null],
    ["   \n  ", null],
  ])("%j", (reply, expected) => {
    expect(parseSuggestion(reply)).toBe(expected);
  });
});
