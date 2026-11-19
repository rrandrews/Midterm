import { Terminal } from "@xterm/headless";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDuration, renderRows, rowsText } from "./blockRender";
import { type BlockTerminal, BlockTracker, outputRows, parseOsc133 } from "./blocks";

const A = "\x1b]133;A\x07";
const B = "\x1b]133;B\x07";
const C = "\x1b]133;C\x07";
const D = (code: number) => `\x1b]133;D;${code}\x07`;
const PROMPT = `${A}~ ❯ ${B}`;

describe("parseOsc133", () => {
  it("reads the mark and the exit status", () => {
    expect(parseOsc133("A")).toEqual({ kind: "A" });
    expect(parseOsc133("B")).toEqual({ kind: "B" });
    expect(parseOsc133("C;cmdline=ls")).toEqual({ kind: "C" });
    expect(parseOsc133("D;0")).toEqual({ kind: "D", exitCode: 0 });
    expect(parseOsc133("D;130;aid=1")).toEqual({ kind: "D", exitCode: 130 });
    expect(parseOsc133("D")).toEqual({ kind: "D", exitCode: undefined });
    expect(parseOsc133("D;x")).toEqual({ kind: "D", exitCode: undefined });
    expect(parseOsc133("P;k=i")).toBeNull();
  });
});

function setup(options: { cols?: number; rows?: number; scrollback?: number } = {}) {
  const term = new Terminal({ cols: options.cols ?? 40, rows: options.rows ?? 10, scrollback: options.scrollback ?? 1000, allowProposedApi: true });
  let cwd = "/home/me";
  let clock = 0;
  const tracker = new BlockTracker(term as unknown as BlockTerminal, {
    cwd: () => cwd,
    branch: async (dir) => (dir === "/home/me" ? "main" : null),
    now: () => clock,
    integrationTimeoutMs: 50,
  });
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  const output = (index: number) => {
    const block = tracker.snapshot().blocks[index];
    const rows = outputRows(block, tracker.buffer);
    return rows ? rowsText(tracker.buffer, rows.from, rows.to, term.cols, rows.lastCells) : null;
  };
  return {
    term,
    tracker,
    write,
    output,
    setCwd: (dir: string) => (cwd = dir),
    tick: (ms: number) => (clock += ms),
  };
}

afterEach(() => vi.useRealTimers());

describe("BlockTracker", () => {
  it("cuts output into blocks with command, status and duration", async () => {
    const t = setup();
    await t.write(`welcome\r\n${PROMPT}`);
    expect(t.tracker.snapshot()).toMatchObject({ integration: "present", phase: "prompt", blocks: [] });

    expect(t.tracker.submit("ls")).toBe(true);
    expect(t.tracker.submit("again")).toBe(false);
    await t.write(`ls\r\n${C}`);
    expect(t.tracker.snapshot().phase).toBe("running");
    await t.write("a.txt\r\nb.txt\r\n");
    t.tick(40);
    await t.write(`${D(0)}${PROMPT}`);

    // Typed into the terminal rather than the editor: read back from the prompt.
    t.setCwd("/tmp");
    await t.write(`false\r\n${C}`);
    t.tick(5);
    await t.write(`${D(1)}${PROMPT}`);

    const { blocks, phase } = t.tracker.snapshot();
    expect(phase).toBe("prompt");
    expect(blocks.map((b) => [b.command, b.cwd, b.exitCode, (b.endedAt ?? 0) - b.startedAt])).toEqual([
      ["ls", "/home/me", 0, 40],
      ["false", "/tmp", 1, 5],
    ]);
    expect(t.output(0)).toBe("a.txt\nb.txt");
    expect(t.output(1)).toBe("");
    expect(t.tracker.commands).toEqual(["ls", "false"]);
    await Promise.resolve();
    expect(blocks[0].branch).toBe("main");
    expect(blocks[1].branch).toBeNull();
  });

  it("includes a last line without a newline, and joins wrapped rows", async () => {
    const t = setup({ cols: 10 });
    await t.write(`${PROMPT}x\r\n${C}${"y".repeat(15)}\r\nno newline`);
    await t.write(`${D(0)}\r\n${PROMPT}`);
    expect(t.output(0)).toBe(`${"y".repeat(15)}\nno newline`);
  });

  it("reads a typed command that wrapped across rows", async () => {
    const t = setup({ cols: 12 });
    await t.write(`${PROMPT}echo 0123456789\r\n${C}0123456789\r\n${D(0)}${PROMPT}`);
    expect(t.tracker.snapshot().blocks[0].command).toBe("echo 0123456789");
  });

  it("shows the running block's output up to the cursor", async () => {
    const t = setup();
    await t.write(`${PROMPT}sleep\r\n${C}working`);
    const [block] = t.tracker.snapshot().blocks;
    expect(block.end).toBeUndefined();
    expect(t.output(0)).toBe("working");
  });

  it("notifies output listeners only while a command runs", async () => {
    const t = setup();
    const listener = vi.fn();
    t.tracker.onOutput(listener);
    await t.write(`${PROMPT}`);
    listener.mockClear();
    await t.write(`x\r\n${C}out`);
    expect(listener).toHaveBeenCalled();
  });

  it("re-anchors the running block at the top of the screen when the screen is erased", async () => {
    const t = setup();
    await t.write(`${PROMPT}watch\r\n${C}old\r\n`);
    await t.write("\x1b[H\x1b[2Jnew");
    await Promise.resolve();
    const [block] = t.tracker.snapshot().blocks;
    expect(block.truncated).toBe(true);
    expect(t.output(0)).toBe("new");
  });

  it("keeps a command sent from the editor that the shell never marked", async () => {
    // bash prints no C (and so no D) for a line that is only a subshell.
    const t = setup();
    await t.write(PROMPT);
    expect(t.tracker.submit("(echo sub) ")).toBe(true);
    expect(t.tracker.snapshot().phase).toBe("running");
    await t.write("(echo sub) \r\nsub\r\n");
    expect(t.output(0)).toBe("sub");
    await t.write(PROMPT);
    const [block] = t.tracker.snapshot().blocks;
    // Kept exactly as sent (a trailing escaped space matters).
    expect(block.command).toBe("(echo sub) ");
    expect(block.exitCode).toBeUndefined();
    expect(t.output(0)).toBe("sub");
    expect(t.tracker.snapshot().phase).toBe("prompt");
  });

  it("stops the output where D was printed when the prompt follows on the same row", async () => {
    const t = setup();
    await t.write(`${PROMPT}printf x\r\n${C}x${D(0)}${PROMPT}`);
    expect(t.output(0)).toBe("x");
    const buffer = t.tracker.buffer;
    const rows = outputRows(t.tracker.snapshot().blocks[0], buffer);
    expect(rows && renderRows(buffer, rows.from, rows.to, { theme: {}, cols: 40, lastCells: rows.lastCells })).toEqual([[{ text: "x" }]]);
  });

  it("keeps blocks across reflow", async () => {
    const t = setup({ cols: 10 });
    await t.write(`${PROMPT}x\r\n${C}${"y".repeat(25)}${D(0)}\r\n${PROMPT}`);
    t.term.resize(40, 10);
    await t.write("");
    await Promise.resolve();
    expect(t.tracker.snapshot().blocks).toHaveLength(1);
    expect(t.output(0)).toBe("y".repeat(25));
    t.term.resize(8, 10);
    await t.write("");
    await Promise.resolve();
    expect(t.output(0)).toBe("y".repeat(25));
  });

  it("does not drop blocks when a program clears the alternate screen's scrollback", async () => {
    const t = setup();
    await t.write(`${PROMPT}ls\r\n${C}a\r\n${D(0)}${PROMPT}vim\r\n${C}\x1b[?1049h\x1b[3J\x1b[?1049l${D(0)}${PROMPT}`);
    expect(t.tracker.snapshot().blocks.map((b) => b.command)).toEqual(["ls", "vim"]);
  });

  it("tracks the alternate screen", async () => {
    const t = setup();
    await t.write(`${PROMPT}vim\r\n${C}\x1b[?1049h`);
    expect(t.tracker.snapshot().altScreen).toBe(true);
    await t.write("\x1b[?1049l");
    expect(t.tracker.snapshot().altScreen).toBe(false);
  });

  it("drops blocks on clear, including a running `clear` once it ends", async () => {
    const t = setup();
    await t.write(`${PROMPT}ls\r\n${C}a\r\n${D(0)}${PROMPT}clear\r\n${C}`);
    await t.write("\x1b[H\x1b[2J\x1b[3J");
    await Promise.resolve();
    expect(t.tracker.snapshot().blocks.map((b) => b.command)).toEqual(["clear"]);
    await t.write(`${D(0)}${PROMPT}`);
    expect(t.tracker.snapshot().blocks).toEqual([]);

    await t.write(`ls\r\n${C}a\r\n${D(0)}${PROMPT}`);
    t.tracker.clear();
    expect(t.tracker.snapshot().blocks).toEqual([]);
  });

  it("drops blocks that have left the scrollback", async () => {
    const t = setup({ rows: 5, scrollback: 5 });
    await t.write(`${PROMPT}one\r\n${C}1\r\n${D(0)}${PROMPT}two\r\n${C}`);
    for (let i = 0; i < 30; i++) await t.write(`line ${i}\r\n`);
    await t.write(`${D(0)}${PROMPT}`);
    await Promise.resolve();
    const { blocks } = t.tracker.snapshot();
    expect(blocks.map((b) => b.command)).toEqual(["two"]);
    // Its beginning is gone too: what is left starts at the top of the buffer.
    expect(blocks[0].truncated).toBe(true);
    expect(t.output(0)?.split("\n").pop()).toBe("line 29");
  });

  it("gives up waiting for marks from a shell without integration", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.term.write("plain prompt $ ");
    await vi.advanceTimersByTimeAsync(100);
    expect(t.tracker.snapshot().integration).toBe("absent");
    t.term.write(PROMPT);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.tracker.snapshot().integration).toBe("present");
  });
});

describe("renderRows", () => {
  it("styles runs from cell attributes and draws the cursor", async () => {
    const t = setup();
    await t.write("\x1b[31mred\x1b[0m \x1b[1;32mbold\x1b[0m \x1b[38;2;1;2;3mrgb\x1b[0m\r\nab");
    const buffer = t.tracker.buffer;
    const lines = renderRows(buffer, 0, 2, {
      theme: { red: "#ff0000", brightGreen: "#00ff00" },
      cols: 40,
      cursor: { row: 1, col: 2 },
    });
    expect(lines[0]).toEqual([
      { text: "red", fg: "#ff0000" },
      { text: " " },
      { text: "bold", fg: "#00ff00", bold: true },
      { text: " " },
      { text: "rgb", fg: "#010203" },
    ]);
    expect(lines[1]).toEqual([{ text: "ab" }, { text: " ", cursor: true }]);
  });
});

describe("formatDuration", () => {
  it("is short and precise enough for each range", () => {
    expect(formatDuration(40)).toBe("0.04s");
    expect(formatDuration(2300)).toBe("2.3s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(2 * 3600_000 + 3 * 60_000)).toBe("2h 03m");
  });
});
