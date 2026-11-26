import { describe, expect, it } from "vitest";
import { OUTPUT_HEAD_LINES, OUTPUT_TAIL_LINES, buildContext, contextBody, parseSuggestion, redact, setSecretNames, trimOutput } from "./context";

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
    ['{"password": "ordinary-pass", "host": "db.local"}', '{"password": [redacted], "host": "db.local"}'],
    ["'api_key': 'plain-value'", "'api_key': [redacted]"],
    ["export DB_PASSWORD=abc,def", "export DB_PASSWORD=[redacted]"],
    ["export DB_PASSWORD=,leading", "export DB_PASSWORD=[redacted]"],
    ['"password": first,second', '"password": [redacted]'],
    ['"password": ,leading', '"password": [redacted]'],
    ["PASSWORD=ghp_abcdefghijklmnopqrstuvwxyz:second-factor", "PASSWORD=[redacted]"],
    ['PASSWORD="unclosed-secret-at-hunk-end', "PASSWORD=[redacted]"],
    ['PASSWORD="dangling-escape\\', "PASSWORD=[redacted]"],
    ['PASSWORD="line1\\\nline2"', "PASSWORD=[redacted]"],
    ["password: 'it''s-sensitive'", "password: [redacted]"],
    ['--password abc"def"', "--password [redacted]"],
  ])("%s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("masks YAML block-scalar secret lines (both indicator orders and sequence items) while keeping sibling keys", () => {
    const yaml = "db:\n  password: |2-\n    first-secret-line\n    second-secret-line\n  host: db.internal";
    const redacted = redact(yaml, { preserveLineCount: true });
    expect(redacted).not.toContain("first-secret-line");
    expect(redacted).not.toContain("second-secret-line");
    expect(redacted).toContain("  host: db.internal");
    expect(redacted.split("\n")).toHaveLength(yaml.split("\n").length);

    const seqYaml = "- password: |\n    seq-secret-line\n  host: db.internal";
    const seqRedacted = redact(seqYaml, { preserveLineCount: true });
    expect(seqRedacted).not.toContain("seq-secret-line");
    expect(seqRedacted).toContain("  host: db.internal");
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

  it("takes larger limits", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const out = trimOutput(lines.join("\n"), { head: 40, tail: 80, chars: 12000 }).split("\n");
    expect(out).toHaveLength(121);
    expect(out[39]).toBe("line 39");
    expect(out[40]).toBe("… (80 lines omitted)");
    expect(out[120]).toBe("line 199");
    expect(trimOutput(lines.join("\n"))).toContain("(160 lines omitted)");
  });

  it("redacts a private key whose header falls in the omitted middle", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const body = Array.from({ length: 40 }, (_, i) => `KEYBODY${i}abcdefghijklmnop`);
    const text = [...filler, "-----BEGIN RSA PRIVATE KEY-----", ...body, "-----END RSA PRIVATE KEY-----", "done"].join("\n");
    expect(trimOutput(text)).not.toContain("KEYBODY");
  });
});

describe("buildContext", () => {
  it("names the remote host instead of this machine's OS", () => {
    const { prompt } = buildContext({ os: "macOS", host: "box", cwd: "/srv", recentCommands: [], blocks: [] });
    expect(prompt).toContain("Remote host (over ssh): box");
    expect(prompt).not.toContain("OS: macOS");
    expect(prompt).toContain("Working directory: /srv");
  });

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
    expect(prompt).toContain("OS: macOS");
    expect(prompt).toContain("Earlier commands (oldest first):\nls\ncd proj\nexport API_KEY=[redacted]");
    expect(prompt).toContain("$ git status\nOn branch main\nChanges not staged\n[exit 0]");
    expect(prompt).not.toContain("abc123");
    expect(prompt.endsWith("Next command:")).toBe(true);
  });
});

describe("contextBody", () => {
  it("redacts commands before clipping them", () => {
    // The password runs past the 500-character cut, its `@` after it.
    const command = `curl https://user:${"a".repeat(475)}SECRETzzzzzz@example.com`;
    const body = contextBody({ recentCommands: [command], blocks: [{ command: command.replace("curl", "wget"), exitCode: 0, output: "" }] });
    expect(body).not.toContain("SECRET");
  });

  it("is the prompt without its question", () => {
    const input = { os: "macOS", cwd: "~", recentCommands: ["ls"], blocks: [] };
    const built = buildContext(input);
    expect(built.body).toBe(contextBody(input));
    expect(built.prompt).toBe(`${built.body}\n\nNext command:`);
    expect(built.body).not.toContain("Next command:");
  });

  it("speaks of commands before the block when it is for one", () => {
    expect(contextBody({ recentCommands: [], blocks: [], beforeBlock: true })).toContain("No commands were run before the one in question.");
    const body = contextBody({ recentCommands: [], blocks: [{ command: "ls", exitCode: 0, output: "a" }], beforeBlock: true });
    expect(body).toContain("Commands run before the one in question, with their output (oldest first):\n\n$ ls\na\n[exit 0]");
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

describe("secret names", () => {
  it("redacts values assigned to the user's secret names", () => {
    setSecretNames(["DEPLOY_PIN", "DB_URL"]);
    expect(redact("DEPLOY_PIN=739184 and DB_URL: 'postgres://x' but OTHER=1")).toBe(
      "DEPLOY_PIN=[redacted] and DB_URL: [redacted] but OTHER=1",
    );
    setSecretNames([]);
    expect(redact("DEPLOY_PIN=739184")).toBe("DEPLOY_PIN=739184");
  });
});
