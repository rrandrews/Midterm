import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../settings/settings";
import { saveProfile, setDefaultProfile } from "./profiles";
import { streamText } from "./stream";

// Outside Tauri, `aiStream` answers from the browser mock: 12 chunks, 40 ms apart.

beforeEach(() => {
  vi.useFakeTimers();
  saveProfile({ id: "p-test0001", name: "Test", provider: "openai", model: "gpt-4o", baseUrl: "", cliPath: "" });
  setDefaultProfile("p-test0001");
});

afterEach(() => {
  vi.useRealTimers();
  useSettings.getState().resetSettings();
});

describe("streamText", () => {
  it("shows text as it arrives, at most once per frame, then the full reply", async () => {
    const seen: string[] = [];
    const { result } = streamText("suggestions", { system: "", prompt: "p" }, (text) => seen.push(text));
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(4);
    for (let i = 1; i < seen.length; i++) expect(seen[i].startsWith(seen[i - 1])).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    const reply = await result;
    expect(reply.stop).toBe("end");
    expect(seen[seen.length - 1]).toBe(reply.text);
    expect(reply.text).toContain("browser mock");
  });

  it("stops on cancel and rejects as cancelled", async () => {
    const seen: string[] = [];
    const { result, cancel } = streamText("suggestions", { system: "", prompt: "p" }, (text) => seen.push(text));
    const settled = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    const count = seen.length;
    cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await settled).toMatchObject({ kind: "cancelled" });
    expect(seen.length).toBe(count);
  });

  it("rejects when the feature has no ready profile", async () => {
    useSettings.getState().resetSettings();
    const onText = vi.fn();
    await expect(streamText("cmd", { system: "", prompt: "p" }, onText).result).rejects.toMatchObject({ kind: "other" });
    expect(onText).not.toHaveBeenCalled();
  });
});
