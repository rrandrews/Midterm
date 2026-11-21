import { describe, expect, it } from "vitest";
import { InputQueue } from "./queue";

describe("InputQueue", () => {
  it("delivers items pushed before and after the reader waits", async () => {
    const q = new InputQueue<number>();
    q.push(1);
    const it = q[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: 1, done: false });
    const pending = it.next();
    q.push(2);
    expect(await pending).toEqual({ value: 2, done: false });
  });

  it("ends the iteration on close, even for a waiting reader", async () => {
    const q = new InputQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.close();
    expect((await pending).done).toBe(true);
    q.push(3); // ignored
    expect((await it.next()).done).toBe(true);
  });
});
