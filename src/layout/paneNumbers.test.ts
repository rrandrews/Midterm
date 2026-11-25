// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ suspended: false, numbers: { a: "1", b: "2" } as Record<string, string> }));
vi.mock("../actions", () => ({ activePaneNumbers: () => state.numbers }));
vi.mock("../shortcuts", () => ({ shortcutsSuspended: () => state.suspended }));

import { SHOW_DELAY_MS, installPaneNumbers, usePaneNumbers } from "./paneNumbers";

function key(type: "keydown" | "keyup", init: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent(type, init));
}
const altDown = (init: KeyboardEventInit = {}) => key("keydown", { key: "Alt", code: "AltLeft", altKey: true, ...init });
const shown = () => Object.keys(usePaneNumbers.getState().numbers).length > 0;

describe("pane number overlay", () => {
  let uninstall: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    state.suspended = false;
    state.numbers = { a: "1", b: "2" };
    uninstall = installPaneNumbers();
  });
  afterEach(() => {
    uninstall();
    vi.useRealTimers();
  });

  it("appears after ⌥ is held alone for a moment, and hides on release", () => {
    altDown();
    vi.advanceTimersByTime(SHOW_DELAY_MS - 10);
    expect(shown()).toBe(false);
    vi.advanceTimersByTime(20);
    expect(shown()).toBe(true);
    key("keyup", { key: "Alt", code: "AltLeft" });
    expect(shown()).toBe(false);
  });

  it("does not flash for a quick chord or another modifier", () => {
    altDown();
    key("keydown", { key: "ArrowLeft", code: "ArrowLeft", altKey: true, metaKey: true });
    vi.advanceTimersByTime(SHOW_DELAY_MS * 2);
    expect(shown()).toBe(false);

    altDown({ metaKey: true });
    vi.advanceTimersByTime(SHOW_DELAY_MS * 2);
    expect(shown()).toBe(false);
  });

  it("hides when another modifier or a non-digit key goes down", () => {
    altDown();
    vi.advanceTimersByTime(SHOW_DELAY_MS + 1);
    key("keydown", { key: "Shift", code: "ShiftLeft", altKey: true, shiftKey: true });
    expect(shown()).toBe(false);

    altDown();
    vi.advanceTimersByTime(SHOW_DELAY_MS + 1);
    key("keydown", { key: "å", code: "KeyA", altKey: true });
    expect(shown()).toBe(false);
  });

  it("stays up through ⌥ plus a digit", () => {
    altDown();
    vi.advanceTimersByTime(SHOW_DELAY_MS + 1);
    key("keydown", { key: "¡", code: "Digit1", altKey: true });
    expect(shown()).toBe(true);
  });

  it("hides on blur and stays hidden with one pane or while shortcuts are suspended", () => {
    altDown();
    vi.advanceTimersByTime(SHOW_DELAY_MS + 1);
    window.dispatchEvent(new Event("blur"));
    expect(shown()).toBe(false);

    state.suspended = true;
    altDown();
    vi.advanceTimersByTime(SHOW_DELAY_MS + 1);
    expect(shown()).toBe(false);
    key("keyup", { key: "Alt", code: "AltLeft" });

    state.suspended = false;
    state.numbers = { a: "1" };
    altDown();
    vi.advanceTimersByTime(SHOW_DELAY_MS + 1);
    expect(shown()).toBe(false);
  });
});
