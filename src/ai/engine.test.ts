import { afterEach, describe, expect, it } from "vitest";
import { useSettings } from "../settings/settings";
import { aiConfigured, providerConfig } from "./engine";

afterEach(() => useSettings.getState().resetSettings());

describe("aiConfigured", () => {
  it("is inert until a provider and model are chosen", () => {
    const { updateAi } = useSettings.getState();
    expect(aiConfigured()).toBe(false);
    updateAi({ provider: "openai" });
    expect(aiConfigured()).toBe(false);
    updateAi({ model: "some-model" });
    expect(aiConfigured()).toBe(true);
    updateAi({ suggestions: false });
    expect(aiConfigured()).toBe(false);
  });

  it("lets a CLI run with its default model, and needs a base URL for custom", () => {
    const { updateAi } = useSettings.getState();
    updateAi({ provider: "claude-code" });
    expect(aiConfigured()).toBe(true);
    updateAi({ provider: "custom", model: "m" });
    expect(aiConfigured()).toBe(false);
    updateAi({ baseUrl: "http://localhost:1234/v1" });
    expect(aiConfigured()).toBe(true);
  });
});

describe("providerConfig", () => {
  it("sends the base URL only for custom and the path only for CLIs", () => {
    const { updateAi } = useSettings.getState();
    updateAi({ provider: "openai", baseUrl: "http://evil.example", cliPaths: { openai: "/x", codex: "/opt/codex" } });
    expect(providerConfig()).toEqual({ id: "openai" });
    updateAi({ provider: "codex" });
    expect(providerConfig()).toEqual({ id: "codex", cliPath: "/opt/codex" });
    updateAi({ provider: "custom" });
    expect(providerConfig()).toEqual({ id: "custom", baseUrl: "http://evil.example" });
    updateAi({ provider: "nope" });
    expect(providerConfig()).toBeNull();
  });
});
