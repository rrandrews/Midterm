import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/schema";
import { DEFAULT_SCOPE, useSettings } from "../settings/settings";
import { terminalEnvironment } from "./settings";

const store = () => useSettings.getState();

beforeEach(() => {
  useSettings.setState({ ...DEFAULT_SETTINGS, base: DEFAULT_SETTINGS, activeWorkspace: null });
});

describe("terminalEnvironment", () => {
  it("adds a workspace's variables and secrets to the defaults'", () => {
    store().updateEnvironment(DEFAULT_SCOPE, {
      env: [
        { name: "A", value: "default" },
        { name: "B", value: "default" },
        { name: "TOKEN", value: "plain" },
      ],
      secrets: ["KEY"],
    });
    store().updateEnvironment("w1", { env: [{ name: "B", value: "w1" }], secrets: ["KEY", "TOKEN"] });
    expect(terminalEnvironment("w1")).toEqual({
      env: [
        { name: "A", value: "default" },
        { name: "B", value: "w1" },
      ],
      secrets: [
        { name: "KEY", account: "secret/w1/KEY" },
        { name: "TOKEN", account: "secret/w1/TOKEN" },
      ],
      python: null,
    });
    expect(terminalEnvironment("w2").secrets).toEqual([{ name: "KEY", account: "secret/default/KEY" }]);
  });

  it("uses the workspace's Python environment, or the defaults'", () => {
    store().updateSettings({ python: { kind: "conda", target: "base" } }, DEFAULT_SCOPE);
    store().updateSettings({ python: { kind: "venv", target: "/p/.venv" } }, "w1");
    store().updateSettings({ python: { kind: "none", target: "" } }, "w2");
    expect(terminalEnvironment("w1").python).toEqual({ kind: "venv", target: "/p/.venv" });
    expect(terminalEnvironment("w2").python).toBeNull();
    expect(terminalEnvironment("w3").python).toEqual({ kind: "conda", target: "base" });
  });
});
