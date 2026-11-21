import { describe, expect, it } from "vitest";
import { TypedLine } from "./typedLine";

const typed = (...chunks: string[]) => {
  const line = new TypedLine();
  for (const chunk of chunks) line.feed(chunk);
  return line.text;
};

describe("TypedLine", () => {
  it("follows plain typing and erasing", () => {
    expect(typed("ls", " -l")).toBe("ls -l");
    expect(typed("lss\x7f")).toBe("ls");
    expect(typed("ls\b\b\bcd")).toBe("cd");
    expect(typed("git commit  \x17")).toBe("git ");
    expect(typed("ls\x15pwd")).toBe("pwd");
    expect(typed("sleep 9\x03ls")).toBe("ls");
    expect(typed("ls ✓ é")).toBe("ls ✓ é");
  });

  it("starts over at Enter", () => {
    expect(typed("make\r")).toBe("");
    expect(typed("make\rls")).toBe("ls");
    expect(typed("a\nb")).toBe("b");
  });

  it("ignores escape sequences and other control keys", () => {
    expect(typed("l\x1b[Ds")).toBe("ls");
    expect(typed("\x1bOAls")).toBe("ls");
    expect(typed("\x1b[I\x1b[200~echo hi\x1b[201~")).toBe("echo hi");
    expect(typed("\x1b]11;rgb:0/0/0\x07ls")).toBe("ls");
    expect(typed("l\x01s\x05")).toBe("ls");
    expect(typed("\x1bbls")).toBe("ls");
  });
});
