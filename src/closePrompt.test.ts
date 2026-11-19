import { describe, expect, it } from "vitest";
import { closePromptMessage } from "./closePrompt";

describe("closePromptMessage", () => {
  it("is null when nothing would be lost", () => {
    expect(closePromptMessage([], [])).toBeNull();
  });

  it("names running programs", () => {
    expect(closePromptMessage(["vim"], [])).toBe("“vim” is still running. Closing ends it.");
    expect(closePromptMessage(["vim", "htop", "top"], [])).toBe(
      "“vim”, “htop” and “top” are still running. Closing ends them.",
    );
  });

  it("names unsaved files", () => {
    expect(closePromptMessage([], ["App.tsx"])).toBe("“App.tsx” has unsaved changes. Closing discards them.");
    expect(closePromptMessage([], ["a.ts", "b.ts"])).toBe("“a.ts” and “b.ts” have unsaved changes. Closing discards them.");
  });

  it("combines both", () => {
    expect(closePromptMessage(["vim"], ["App.tsx"])).toBe(
      "“vim” is still running, and “App.tsx” has unsaved changes. Closing ends it and discards the changes.",
    );
  });
});
