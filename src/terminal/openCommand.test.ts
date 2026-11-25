import { describe, expect, it } from "vitest";
import { parseOpenArgument, shellWord } from "./openCommand";

describe("parseOpenArgument", () => {
  it("takes the name as typed in a shell", () => {
    expect(parseOpenArgument("  README.md ")).toEqual({ whole: "README.md" });
    expect(parseOpenArgument("My\\ File.txt")).toEqual({ whole: "My File.txt" });
    expect(parseOpenArgument('"My File.txt"')).toEqual({ whole: "My File.txt" });
    expect(parseOpenArgument("'a b'")).toEqual({ whole: "a b" });
  });

  it("splits off a position as a fallback", () => {
    expect(parseOpenArgument("src/a.ts:12:5")).toEqual({
      whole: "src/a.ts:12:5",
      positioned: { name: "src/a.ts", line: 12, column: 5 },
    });
    expect(parseOpenArgument("a.ts:7")).toEqual({ whole: "a.ts:7", positioned: { name: "a.ts", line: 7 } });
  });

  it("needs a name", () => {
    expect(parseOpenArgument("")).toBeNull();
    expect(parseOpenArgument('""')).toBeNull();
  });
});

describe("shellWord", () => {
  it("reads quotes and escapes as a shell would", () => {
    expect(shellWord('"budget\\$2026.txt"')).toBe("budget$2026.txt");
    expect(shellWord("'a\\b'")).toBe("a\\b");
    expect(shellWord('"a\\b"')).toBe("a\\b");
    expect(shellWord("My\\ File.txt")).toBe("My File.txt");
    expect(shellWord('dir/"my file".txt')).toBe("dir/my file.txt");
    expect(shellWord("trailing\\")).toBe("trailing\\");
    expect(shellWord('"end\\')).toBe("end\\");
  });
});
