import { describe, expect, it } from "vitest";
import { type CommandPair, predictNext, tokenize } from "./predict";

describe("tokenize", () => {
  it("splits words, groups quotes and marks them", () => {
    expect(tokenize(`git commit -m "fix it" 'a b' c\\ d`)).toEqual([
      { text: "git", quoted: false },
      { text: "commit", quoted: false },
      { text: "-m", quoted: false },
      { text: "fix it", quoted: true },
      { text: "a b", quoted: true },
      { text: "c d", quoted: false },
    ]);
  });
});

describe("predictNext", () => {
  it("predicts from exact matches", () => {
    const pairs: CommandPair[] = [
      ["git add .", "git commit"],
      ["ls", "pwd"],
      ["git add .", "git commit"],
    ];
    expect(predictNext(pairs, "git add .")?.command).toBe("git commit");
  });

  it("needs enough support", () => {
    expect(predictNext([["git add .", "git commit"]], "git add .")).toBeNull();
  });

  it("needs a clear winner", () => {
    const pairs: CommandPair[] = [
      ["make", "ls"],
      ["make", "ls"],
      ["make", "pwd"],
      ["make", "pwd"],
      ["make", "git status"],
    ];
    expect(predictNext(pairs, "make")).toBeNull();
  });

  it("carries arguments over: mkdir foo → cd foo", () => {
    const pairs: CommandPair[] = [
      ["mkdir foo", "cd foo"],
      ["mkdir bar", "cd bar"],
    ];
    expect(predictNext(pairs, "mkdir baz")?.command).toBe("cd baz");
  });

  it("carries arguments into paths and quotes them when needed", () => {
    const pairs: CommandPair[] = [
      ["git clone url proj", "cd proj/src"],
      ["git clone url other", "cd other/src"],
    ];
    expect(predictNext(pairs, "git clone url my\\ dir")?.command).toBe("cd 'my dir/src'");
  });

  it("generalizes on the last argument across shapes", () => {
    const pairs: CommandPair[] = [
      ["mkdir -p a", "cd a"],
      ["mkdir -p b", "cd b"],
    ];
    expect(predictNext(pairs, "mkdir c")?.command).toBe("cd c");
  });

  it("ignores free text that differs", () => {
    const pairs: CommandPair[] = [
      ['git commit -m "one"', "git push"],
      ['git commit -m "two"', "git push"],
    ];
    expect(predictNext(pairs, 'git commit -m "three"')?.command).toBe("git push");
  });

  it("does not treat a different subcommand as an argument", () => {
    const pairs: CommandPair[] = [
      ["git status", "git diff"],
      ["git status", "git diff"],
    ];
    expect(predictNext(pairs, "git stash")).toBeNull();
  });

  it("prefers recent habits", () => {
    const old: CommandPair[] = Array.from({ length: 3 }, () => ["npm test", "npm run build"] as const);
    const recent: CommandPair[] = Array.from({ length: 3 }, () => ["npm test", "git push"] as const);
    expect(predictNext([...old, ...recent], "npm test", { halfLife: 2 })?.command).toBe("git push");
  });
});
