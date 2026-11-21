// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyEdit, emptyKill, lineEdit, type KillBuffer } from "./lineEdit";

const run = (key: "u" | "w" | "k" | "y", value: string, start: number, end = start, kill: KillBuffer = emptyKill) => {
  const result = lineEdit(key, value, start, end, kill);
  if (!result) return null;
  const { replaceFrom, replaceTo, insert } = result.edit;
  return { value: value.slice(0, replaceFrom) + insert + value.slice(replaceTo), ...result };
};

describe("lineEdit", () => {
  it("^U kills to the start of the caret's line", () => {
    expect(run("u", "ls -la", 3)?.value).toBe("-la");
    expect(run("u", "one\ntwo three", 9)?.value).toBe("one\nhree");
    expect(run("u", "abc", 0)).toBeNull();
    expect(run("u", "one\ntwo", 4)).toBeNull();
  });
  it("^W kills the word before the caret", () => {
    expect(run("w", "git commit -m", 13)?.value).toBe("git commit ");
    expect(run("w", "git commit   ", 13)?.value).toBe("git ");
    expect(run("w", "a/b c", 3)?.value).toBe(" c");
    expect(run("w", "abc", 0)).toBeNull();
  });
  it("^W at the start of a line joins the previous line", () => {
    expect(run("w", "one\ntwo", 4)?.value).toBe("onetwo");
  });
  it("^K kills to the end of the line", () => {
    expect(run("k", "ls -la", 2)?.value).toBe("ls");
    expect(run("k", "one two\nthree", 3)?.value).toBe("one\nthree");
    expect(run("k", "one\nthree", 3)?.value).toBe("onethree");
    expect(run("k", "abc", 3)).toBeNull();
  });
  it("a selection is killed as a whole", () => {
    for (const key of ["u", "w", "k"] as const) {
      const r = run(key, "hello world", 2, 7);
      expect(r?.value).toBe("heorld");
      expect(r?.kill.text).toBe("llo w");
    }
  });
  it("^Y yanks the last kill, replacing a selection", () => {
    const killed = run("w", "foo bar", 7)!;
    expect(killed.kill.text).toBe("bar");
    expect(run("y", "x", 1, 1, killed.kill)?.value).toBe("xbar");
    expect(run("y", "abc", 0, 3, killed.kill)?.value).toBe("bar");
    expect(run("y", "x", 1)).toBeNull();
  });
  it("consecutive kills accumulate in reading order", () => {
    const first = run("w", "one two three", 13)!;
    const second = run("w", first.value, first.edit.caret, first.edit.caret, first.kill)!;
    expect(second.kill.text).toBe("two three");
    const forward = run("k", "ab cd", 0, 0, run("k", "ab cd", 3)!.kill)!;
    expect(forward.kill.text).toBe("cdab cd");
    expect(run("k", "ab cd", 3, 3, { text: "old", chained: false })?.kill.text).toBe("cd");
  });
});

describe("applyEdit", () => {
  it("falls back to setting the value and fires an input event", () => {
    const input = document.createElement("textarea");
    document.body.append(input);
    input.value = "hello world";
    let seen = "";
    input.addEventListener("input", () => (seen = input.value));
    applyEdit(input, { replaceFrom: 5, replaceTo: 11, insert: "", caret: 5 });
    expect(seen).toBe("hello");
    expect(input.selectionStart).toBe(5);
    applyEdit(input, { replaceFrom: 5, replaceTo: 5, insert: "!", caret: 6 });
    expect(input.value).toBe("hello!");
  });
});

describe("⌃U at the very start", () => {
  it("changes nothing, even before a newline", () => {
    expect(lineEdit("u", "\necho hi", 0, 0, emptyKill)).toBeNull();
  });
});
