import { describe, expect, it } from "vitest";
import { resolveIcon } from "./loader";

describe("resolveIcon", () => {
  it("keeps lucide names and absolute URLs", () => {
    expect(resolveIcon("p", undefined, "notebook-pen")).toBe("notebook-pen");
    expect(resolveIcon("p", "https://example.com/i.svg", "x")).toBe("https://example.com/i.svg");
    expect(resolveIcon("p", "data:image/svg+xml,<svg/>")).toBe("data:image/svg+xml,<svg/>");
  });

  it("prefers the module's icon over the manifest's", () => {
    expect(resolveIcon("p", "star", "notebook-pen")).toBe("star");
    expect(resolveIcon("p", "", "notebook-pen")).toBe("notebook-pen");
    expect(resolveIcon("p", 5, "notebook-pen")).toBe("notebook-pen");
  });

  it("is undefined without an icon", () => {
    expect(resolveIcon("p", undefined, undefined)).toBeUndefined();
  });

  it("turns relative paths into plugin file URLs", () => {
    expect(resolveIcon("my-plugin", undefined, "assets/icon.svg", 3)).toBe("plugin://localhost/my-plugin@3/assets/icon.svg");
    expect(resolveIcon("my-plugin", undefined, "icon.png")).toBe("plugin://localhost/my-plugin/icon.png");
    expect(resolveIcon("my-plugin", "own.svg", "icon.png", 2)).toBe("plugin://localhost/my-plugin@2/own.svg");
    expect(resolveIcon("my-plugin", "/icons/pane.svg")).toBe("plugin://localhost/my-plugin/icons/pane.svg");
  });
});
