import { describe, expect, it } from "vitest";
import {
  applyCandidate,
  applyPrefix,
  type Candidate,
  commonPrefix,
  completionContext,
  escapeText,
  filterCandidates,
  tokenize,
} from "./completion";
import { resolveDir } from "./completionSource";

/** Context at the end of `line`, or at `‸` if it has one. */
function at(text: string) {
  const caret = text.includes("‸") ? text.indexOf("‸") : text.length;
  const line = text.replace("‸", "");
  return { line, caret, context: completionContext(line, caret) };
}

const file = (name: string): Candidate => ({ name, dir: false });
const dir = (name: string): Candidate => ({ name, dir: true });

describe("tokenize", () => {
  it("splits words and operators", () => {
    const tokens = tokenize("ls -la|grep x && echo 'a b'>out");
    expect(tokens.map((t) => (t.kind === "op" ? `op:${t.op}` : t.value))).toEqual([
      "ls",
      "-la",
      "op:|",
      "grep",
      "x",
      "op:&&",
      "echo",
      "a b",
      "op:>",
      "out",
    ]);
  });

  it("removes quotes and escapes", () => {
    const [word] = tokenize(`a\\ b"c\\"d"'e\\f'`);
    expect(word).toMatchObject({ kind: "word", value: 'a bc"de\\f', quote: null, start: 0 });
  });

  it("records an open quote and where the word can be cut", () => {
    const [, word] = tokenize(`cat "my dir/fi`);
    expect(word).toMatchObject({ value: "my dir/fi", quote: '"', cut: { raw: 12, value: 7 } });
    const [, plain] = tokenize("cat src/comp");
    expect(plain).toMatchObject({ cut: { raw: 8, value: 4 } });
    const [, quoted] = tokenize("cat src/'my f");
    expect(quoted).toMatchObject({ value: "src/my f", quote: "'", cut: { raw: 9, value: 4 } });
  });

  it("keeps a file descriptor with its redirection", () => {
    expect(tokenize("2>/dev/null x").map((t) => (t.kind === "op" ? `op:${t.op}` : t.value))).toEqual([
      "op:>",
      "/dev/null",
      "x",
    ]);
    expect(tokenize("echo 2 >x").map((t) => (t.kind === "op" ? `op:${t.op}` : t.value))).toEqual(["echo", "2", "op:>", "x"]);
  });

  it("cuts after a closed quote", () => {
    const [, word] = tokenize(`cat "src/"`);
    expect(word).toMatchObject({ value: "src/", quote: null, cut: { raw: 10, value: 4 } });
  });

  it("flags expansions", () => {
    expect(tokenize("$HOME/x")[0]).toMatchObject({ expands: true });
    expect(tokenize(`"$HOME"`)[0]).toMatchObject({ expands: true });
    expect(tokenize("'$HOME'")[0]).toMatchObject({ expands: false });
  });
});

describe("completionContext", () => {
  it("completes command names in command position", () => {
    for (const text of ["gi", "ls | gr", "a; b && c || d", "(ech", "sudo gi", "sudo -E gi", "env A=1 gi", "time nohup gi", "FOO=1 gi"]) {
      expect(at(text).context?.kind, text).toBe("command");
    }
    expect(at("").context).toMatchObject({ kind: "command", prefix: "" });
    expect(at("gi").context).toMatchObject({ prefix: "gi", from: 0, kept: 0 });
    expect(at("sudo -u root gi").context?.kind).toBe("command");
    expect(at("2>/dev/null gi").context?.kind).toBe("command");
  });

  it("completes paths elsewhere, executables for a command with a slash", () => {
    expect(at("ls sr").context).toMatchObject({ kind: "path", dir: "", prefix: "sr", from: 3 });
    expect(at("ls ").context).toMatchObject({ kind: "path", prefix: "", from: 3 });
    expect(at("./scr").context).toMatchObject({ kind: "executable", dir: "./", prefix: "scr", from: 2 });
    expect(at("cat ~/Doc").context).toMatchObject({ kind: "path", dir: "~/", prefix: "Doc", from: 6 });
    expect(at("cat < in").context).toMatchObject({ kind: "path", prefix: "in" });
    expect(at("echo > ou").context).toMatchObject({ kind: "path" });
    expect(at("sort < in gr").context?.kind).toBe("path");
  });

  it("completes directories for cd, pushd and rmdir", () => {
    expect(at("cd sr").context?.kind).toBe("dir");
    expect(at("pushd ").context?.kind).toBe("dir");
    expect(at("rmdir a/b").context).toMatchObject({ kind: "dir", dir: "a/", prefix: "b" });
    expect(at("cd x && cd ").context?.kind).toBe("dir");
    expect(at("cd x; ls ").context?.kind).toBe("path");
  });

  it("looks only at the text before the caret", () => {
    expect(at("ls sr‸ -l").context).toMatchObject({ kind: "path", prefix: "sr" });
    expect(at("gi‸t status").context).toMatchObject({ kind: "command", prefix: "gi" });
  });

  it("treats an escaped trailing space as part of the word", () => {
    expect(at("ls my\\ ").context).toMatchObject({ prefix: "my ", from: 3 });
  });

  it("expands only an unquoted, unescaped ~", () => {
    expect(at("cat ~/x").context?.dir).toBe("~/");
    expect(at("cat \\~/x").context?.dir).toBe("./~/");
    expect(at("cat '~'/x").context?.dir).toBe("./~/");
  });

  it("does not complete expansions and ~user", () => {
    expect(at("ls $HO").context).toBeNull();
    expect(at("ls ~bob").context).toBeNull();
    expect(at("cat <<EO").context).toBeNull();
  });

  it("knows the quote the word is in", () => {
    expect(at(`ls "my f`).context).toMatchObject({ prefix: "my f", from: 4, kept: 0, word: { quote: '"' } });
    expect(at(`ls ab"c`).context).toMatchObject({ prefix: "abc", from: 6, kept: 2 });
  });
});

describe("escapeText", () => {
  it("backslashes shell characters outside quotes", () => {
    expect(escapeText("a b'c\"d$e`f\\g!h&i|j;k<l>m(n)o*p?q[r]s#t{u}v", null, false)).toBe(
      "a\\ b\\'c\\\"d\\$e\\`f\\\\g\\!h\\&i\\|j\\;k\\<l\\>m\\(n\\)o\\*p\\?q\\[r\\]s\\#t\\{u\\}v",
    );
  });

  it("escapes ~ only at the start of a word", () => {
    expect(escapeText("~x~", null, true)).toBe("\\~x~");
    expect(escapeText("~x", null, false)).toBe("~x");
  });

  it("keeps quotes working", () => {
    expect(escapeText("it's a $x", "'", false)).toBe("it'\\''s a $x");
    expect(escapeText('say "$x" `y` \\', '"', false)).toBe('say \\"\\$x\\" \\`y\\` \\\\');
  });
});

describe("commonPrefix", () => {
  it("finds the longest shared start", () => {
    expect(commonPrefix(["config", "configure", "conf"])).toBe("conf");
    expect(commonPrefix(["a", "b"])).toBe("");
    expect(commonPrefix([])).toBe("");
    expect(commonPrefix(["Readme", "README.md"], true)).toBe("Readme");
    expect(commonPrefix(["file😀", "file😁"])).toBe("file");
  });
});

describe("filterCandidates", () => {
  const all = [file("README.md"), file("readme.txt"), dir("src"), file(".env"), dir(".git"), file("src")];

  it("prefers case-sensitive matches", () => {
    expect(filterCandidates(all, "read").matches.map((c) => c.name)).toEqual(["readme.txt"]);
    expect(filterCandidates(all, "RE")).toEqual({ matches: [file("README.md")], ignoreCase: false });
  });

  it("falls back to case-insensitive", () => {
    expect(filterCandidates(all, "rEA")).toEqual({ matches: [file("README.md"), file("readme.txt")], ignoreCase: true });
  });

  it("hides dotfiles unless the prefix starts with a dot", () => {
    expect(filterCandidates(all, "").matches.map((c) => c.name)).toEqual(["README.md", "readme.txt", "src"]);
    expect(filterCandidates(all, ".").matches.map((c) => c.name)).toEqual([".env", ".git"]);
  });

  it("never offers names with control characters", () => {
    expect(filterCandidates([file("a\nb"), file("ab")], "a").matches.map((c) => c.name)).toEqual(["ab"]);
  });

  it("drops duplicate names", () => {
    expect(filterCandidates(all, "s").matches).toHaveLength(1);
  });
});

describe("applying a completion", () => {
  it("inserts a file with a space and a directory with a slash", () => {
    const { line, caret, context } = at("cat RE");
    expect(applyCandidate(line, caret, context!, file("README.md"))).toEqual({ value: "cat README.md ", caret: 14 });
    const cd = at("cd sr");
    expect(applyCandidate(cd.line, cd.caret, cd.context!, dir("src"))).toEqual({ value: "cd src/", caret: 7 });
  });

  it("escapes and keeps the directory as typed", () => {
    const { line, caret, context } = at("cat ~/my\\ d");
    expect(applyCandidate(line, caret, context!, dir("my docs"))).toEqual({ value: "cat ~/my\\ docs/", caret: 15 });
    const deeper = at("cat ~/my\\ docs/");
    expect(applyCandidate(deeper.line, deeper.caret, deeper.context!, file("a&b"))).toEqual({
      value: "cat ~/my\\ docs/a\\&b ",
      caret: 20,
    });
  });

  it("completes inside an open quote and closes it", () => {
    const { line, caret, context } = at(`cat "my f`);
    expect(applyCandidate(line, caret, context!, file("my file"))).toEqual({ value: `cat "my file" `, caret: 14 });
    const single = at(`cat 'it`);
    expect(applyCandidate(single.line, single.caret, single.context!, file("it's"))).toEqual({
      value: `cat 'it'\\''s' `,
      caret: 14,
    });
    const intoDir = at(`cd "my d`);
    expect(applyCandidate(intoDir.line, intoDir.caret, intoDir.context!, dir("my dir"))).toEqual({
      value: `cd "my dir/`,
      caret: 11,
    });
  });

  it("keeps the text after the caret, without doubling a space", () => {
    const { line, caret, context } = at("ls sr‸ -l");
    expect(applyCandidate(line, caret, context!, dir("src"))).toEqual({ value: "ls src/ -l", caret: 7 });
    const word = at("gi‸ status");
    expect(applyCandidate(word.line, word.caret, word.context!, file("git"))).toEqual({ value: "git status", caret: 4 });
    const inside = at("gi‸t status");
    expect(applyCandidate(inside.line, inside.caret, inside.context!, file("git"))).toEqual({ value: "git status", caret: 4 });
  });

  it("appends after a closed quote", () => {
    const { line, caret, context } = at(`cat "src/"no`);
    expect(applyCandidate(line, caret, context!, file("notes"))).toEqual({ value: `cat "src/"notes `, caret: 16 });
  });

  it("turns ~ into ~/", () => {
    const { line, caret, context } = at("ls ~");
    expect(applyCandidate(line, caret, context!, dir("~"))).toEqual({ value: "ls ~/", caret: 5 });
  });

  it("inserts the common prefix, or nothing when it adds nothing", () => {
    const { line, caret, context } = at("ls co");
    expect(applyPrefix(line, caret, context!, [file("config.ts"), file("configure")], false)).toEqual({
      value: "ls config",
      caret: 9,
    });
    const done = at("ls config");
    expect(applyPrefix(done.line, done.caret, done.context!, [file("config.ts"), file("configure")], false)).toBeNull();
  });

  it("fixes the case of a case-insensitive prefix", () => {
    const { line, caret, context } = at("cat read");
    expect(applyPrefix(line, caret, context!, [file("README.md"), file("READ.txt")], true)).toEqual({
      value: "cat READ",
      caret: 8,
    });
  });
});

describe("resolveDir", () => {
  const env = { cwd: "/work", home: "/Users/me" };
  it("resolves against the cwd and home", () => {
    expect(resolveDir("", env)).toBe("/work");
    expect(resolveDir("src/", env)).toBe("/work/src");
    expect(resolveDir("~/", env)).toBe("/Users/me");
    expect(resolveDir("~/a/", env)).toBe("/Users/me/a");
    expect(resolveDir("/", env)).toBe("/");
    expect(resolveDir("/etc/", env)).toBe("/etc");
    expect(resolveDir("x/", { cwd: undefined, home: undefined })).toBeUndefined();
  });
});
