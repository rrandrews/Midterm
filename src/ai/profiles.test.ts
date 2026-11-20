import { afterEach, describe, expect, it } from "vitest";
import type { AiProfile } from "../settings/schema";
import { getSettings, useSettings } from "../settings/settings";
import { aiConfigured } from "./engine";
import {
  deleteProfile,
  deleteWarning,
  duplicateProfile,
  featureProblem,
  featureReady,
  newProfileId,
  parseExtra,
  profileFor,
  profileReady,
  providerConfigOf,
  saveProfile,
  setDefaultProfile,
  setFeatureProfile,
  targetFor,
} from "./profiles";

afterEach(() => useSettings.getState().resetSettings());

const profile = (id: string, fields: Partial<AiProfile> = {}): AiProfile => ({
  id,
  name: id,
  provider: "openai",
  model: "gpt-4o",
  baseUrl: "",
  cliPath: "",
  ...fields,
});

describe("resolution", () => {
  it("uses the default profile unless a feature overrides it", () => {
    saveProfile(profile("a"));
    saveProfile(profile("b", { provider: "anthropic", model: "claude-x" }));
    // The first profile became the default.
    expect(getSettings().ai.defaultProfile).toBe("a");
    expect(profileFor("suggestions")?.id).toBe("a");
    expect(profileFor("cmd")?.id).toBe("a");
    setFeatureProfile("cmd", "b");
    expect(profileFor("cmd")?.id).toBe("b");
    expect(profileFor("suggestions")?.id).toBe("a");
    setDefaultProfile("b");
    expect(profileFor("suggestions")?.id).toBe("b");
    setFeatureProfile("cmd", null);
    expect(getSettings().ai.features).toEqual({});
    // An override to an unknown profile is dropped.
    setFeatureProfile("cmd", "nope");
    expect(getSettings().ai.features).toEqual({});
  });

  it("is inert without profiles", () => {
    expect(profileFor("suggestions")).toBeUndefined();
    expect(featureReady("suggestions")).toBe(false);
    expect(targetFor("cmd")).toBeNull();
    expect(featureProblem("cmd")).toBe("Add a model first.");
    expect(aiConfigured()).toBe(false);
  });
});

describe("readiness", () => {
  it("needs a model for APIs, a base URL for custom, and nothing more for CLIs", () => {
    expect(profileReady(profile("a"))).toBe(true);
    expect(profileReady(profile("a", { model: "" }))).toBe(false);
    expect(profileReady(profile("a", { provider: "claude-code", model: "" }))).toBe(true);
    expect(profileReady(profile("a", { provider: "custom", model: "m" }))).toBe(false);
    expect(profileReady(profile("a", { provider: "custom", model: "m", baseUrl: "http://localhost:1/v1" }))).toBe(true);
    expect(profileReady(profile("a", { provider: "future-provider" }))).toBe(false);
    expect(profileReady(profile("a", { provider: "" }))).toBe(false);
  });

  it("gates suggestions on the switch and the profile", () => {
    saveProfile(profile("a", { model: "" }));
    expect(aiConfigured()).toBe(false);
    expect(featureProblem("suggestions")).toBe("a: No model chosen.");
    saveProfile(profile("a"));
    expect(aiConfigured()).toBe(true);
    expect(featureProblem("suggestions")).toBeNull();
    useSettings.getState().updateAi({ suggestions: false });
    expect(aiConfigured()).toBe(false);
    // `/cmd` does not depend on the suggestions switch.
    expect(featureReady("cmd")).toBe(true);
  });
});

describe("targets", () => {
  it("sends the base URL only for custom and the path only for CLIs", () => {
    const evil = { baseUrl: "http://evil.example", cliPath: "/x" };
    expect(providerConfigOf(profile("a", evil))).toEqual({ id: "openai" });
    expect(providerConfigOf(profile("a", { ...evil, provider: "codex" }))).toEqual({ id: "codex", cliPath: "/x" });
    expect(providerConfigOf(profile("a", { ...evil, provider: "custom" }))).toEqual({ id: "custom", baseUrl: "http://evil.example" });
    expect(providerConfigOf(profile("a", { provider: "nope" }))).toBeNull();
  });

  it("carries effort and extra, and omits extra for CLIs", () => {
    saveProfile(profile("a", { effort: "high", extra: { user: "me" } }));
    expect(targetFor("suggestions")).toEqual({ provider: { id: "openai" }, model: "gpt-4o", effort: "high", extra: { user: "me" } });
    saveProfile(profile("a", { provider: "claude-code", model: "", effort: "low", extra: { user: "me" } }));
    expect(targetFor("suggestions")).toEqual({ provider: { id: "claude-code" }, model: "", effort: "low" });
  });
});

describe("mutations", () => {
  it("renames without breaking feature references", () => {
    saveProfile(profile("a"));
    saveProfile(profile("b"));
    setFeatureProfile("cmd", "b");
    saveProfile({ ...getSettings().ai.profiles[1], name: "Renamed" });
    expect(profileFor("cmd")?.name).toBe("Renamed");
  });

  it("deleting falls back to the default, or the first remaining profile", () => {
    saveProfile(profile("a"));
    saveProfile(profile("b"));
    saveProfile(profile("c"));
    setFeatureProfile("cmd", "b");
    expect(deleteWarning("b")).toBe("/cmd will use a instead.");
    deleteProfile("b");
    expect(getSettings().ai.features).toEqual({});
    expect(profileFor("cmd")?.id).toBe("a");
    expect(deleteWarning("a")).toBe("Next-command suggestions, /cmd will use c instead.");
    deleteProfile("a");
    expect(getSettings().ai.defaultProfile).toBe("c");
    expect(deleteWarning("c")).toBe("Next-command suggestions, /cmd will have no model.");
    deleteProfile("c");
    expect(getSettings().ai.defaultProfile).toBe("");
  });

  it("warns only when something uses the profile", () => {
    saveProfile(profile("a"));
    saveProfile(profile("b"));
    expect(deleteWarning("b")).toBeNull();
  });

  it("duplicates after the source with a new id and a unique name", () => {
    saveProfile(profile("a", { name: "Fast" }));
    saveProfile(profile("b"));
    const id = duplicateProfile("a");
    const { profiles } = getSettings().ai;
    expect(profiles.map((p) => p.id)).toEqual(["a", id, "b"]);
    expect(id).toMatch(/^p-[a-z0-9]{8}$/);
    expect(profiles[1].name).toBe("Fast copy");
    duplicateProfile("a");
    expect(getSettings().ai.profiles[1].name).toBe("Fast copy 2");
  });

  it("makes ids that are not taken", () => {
    const id = newProfileId([]);
    expect(id).toMatch(/^p-[a-z0-9]{8}$/);
    expect(newProfileId([id])).not.toBe(id);
  });
});

describe("parseExtra", () => {
  it("accepts nothing or a plain object", () => {
    expect(parseExtra("  ")).toEqual({ ok: true, value: undefined });
    expect(parseExtra("{}")).toEqual({ ok: true, value: undefined });
    expect(parseExtra('{ "provider": { "order": ["a"] }, "top_k": 3 }')).toEqual({ ok: true, value: { provider: { order: ["a"] }, top_k: 3 } });
  });

  it("rejects invalid JSON, non-objects, protected keys and large values", () => {
    expect(parseExtra("{ nope").ok).toBe(false);
    expect(parseExtra("[1]")).toMatchObject({ ok: false, error: "Must be a JSON object ({ … })." });
    expect(parseExtra("null").ok).toBe(false);
    expect(parseExtra("3").ok).toBe(false);
    for (const key of ["model", "messages", "system", "stream", "tools", "tool_choice", "functions", "function_call", "n"]) {
      const parsed = parseExtra(JSON.stringify({ [key]: 1 }));
      expect(parsed.ok, key).toBe(false);
    }
    expect(parseExtra(JSON.stringify({ x: "a".repeat(17_000) }))).toMatchObject({ ok: false });
  });
});
