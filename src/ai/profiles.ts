import { type AiTarget, type ProviderConfig, type ProviderId, PROTECTED_EXTRA_KEYS, providerInfo } from "../ipc/ai";
import {
  AI_EXTRA_MAX_BYTES,
  AI_PROFILE_LIMIT,
  AI_PROFILE_NAME_MAX,
  type AiFeature,
  type AiProfile,
  type AiSettings,
  type Settings,
  clip,
  uniqueName,
} from "../settings/schema";
import { getSettings, useSettings } from "../settings/settings";

/*
 * Model profiles (see docs/ai.md): which profile a feature uses, whether it
 * is ready, the target a request goes to, and the mutations Settings → AI
 * makes. Pure apart from reading and updating the settings store; no React.
 */

/** The features listed under Settings → AI → Features. Later phases append theirs. */
export const FEATURES: readonly { id: AiFeature; label: string; hint: string }[] = [
  { id: "suggestions", label: "Next-command suggestions", hint: "Ghost text at an empty prompt of the block terminal." },
  { id: "cmd", label: "/cmd", hint: "Writes a command for a task described in the blocks editor." },
];

const featureLabel = (feature: AiFeature) => FEATURES.find((f) => f.id === feature)?.label ?? feature;

/** The profile `feature` uses: its override, else the default profile. */
export function profileFor(feature: AiFeature, settings: Settings = getSettings()): AiProfile | undefined {
  const { profiles, defaultProfile, features } = settings.ai;
  const id = features[feature] ?? defaultProfile;
  return profiles.find((profile) => profile.id === id);
}

/** The provider config the backend expects for a profile; null for an unknown provider. */
export function providerConfigOf(profile: AiProfile): ProviderConfig | null {
  const info = providerInfo(profile.provider);
  if (!info) return null;
  const config: ProviderConfig = { id: profile.provider as ProviderId };
  if (info.id === "custom" && profile.baseUrl) config.baseUrl = profile.baseUrl;
  if (info.type === "cli" && profile.cliPath) config.cliPath = profile.cliPath;
  return config;
}

/** Why a profile cannot send requests yet, or null when it can (a key is checked by the backend). */
export function profileProblem(profile: AiProfile): string | null {
  const info = providerInfo(profile.provider);
  if (!info) return profile.provider ? `Unknown provider “${profile.provider}”` : "No provider chosen";
  if (info.id === "custom" && !profile.baseUrl) return "No base URL";
  if (info.type === "api" && !profile.model) return "No model chosen";
  return null;
}

/** Whether a profile has what a request needs: a known provider, a model (APIs), a base URL (`custom`). */
export function profileReady(profile: AiProfile): boolean {
  return profileProblem(profile) === null;
}

/** Whether `feature` resolves to a ready profile (its own switches aside). */
export function featureReady(feature: AiFeature, settings: Settings = getSettings()): boolean {
  const profile = profileFor(feature, settings);
  return !!profile && profileReady(profile);
}

/** Why `feature` cannot send requests, for hints; null when it can. */
export function featureProblem(feature: AiFeature, settings: Settings = getSettings()): string | null {
  const profile = profileFor(feature, settings);
  if (!profile) return settings.ai.profiles.length ? "No model chosen." : "Add a model first.";
  const problem = profileProblem(profile);
  return problem ? `${profile.name}: ${problem}.` : null;
}

/** The target a request for `profile` goes to; extra JSON only for API providers. */
export function targetOf(profile: AiProfile): AiTarget | null {
  const provider = providerConfigOf(profile);
  if (!provider) return null;
  const target: AiTarget = { provider, model: profile.model };
  if (profile.effort !== undefined) target.effort = profile.effort;
  if (profile.extra && providerInfo(profile.provider)?.type === "api") target.extra = profile.extra;
  return target;
}

/** The target for `feature`, or null when it has no ready profile. */
export function targetFor(feature: AiFeature, settings: Settings = getSettings()): AiTarget | null {
  const profile = profileFor(feature, settings);
  return profile && profileReady(profile) ? targetOf(profile) : null;
}

/** Features that use `id`, through an override or as the default. */
export function featuresUsing(id: string, settings: Settings = getSettings()): AiFeature[] {
  return FEATURES.map((f) => f.id).filter((feature) => profileFor(feature, settings)?.id === id);
}

export type ParsedExtra = { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string };

/** Extra request JSON from the editor's text: empty means none; else a plain object, no protected key, within 16 KB. */
export function parseExtra(text: string): ParsedExtra {
  if (!text.trim()) return { ok: true, value: undefined };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "Must be a JSON object ({ … })." };
  const record = value as Record<string, unknown>;
  const protectedKey = PROTECTED_EXTRA_KEYS.find((key) => key in record);
  if (protectedKey) return { ok: false, error: `“${protectedKey}” is set by Midterm and cannot be overridden.` };
  const size = new TextEncoder().encode(JSON.stringify(record)).length;
  if (size > AI_EXTRA_MAX_BYTES) return { ok: false, error: `Too large (${size} bytes; the limit is ${AI_EXTRA_MAX_BYTES}).` };
  return { ok: true, value: Object.keys(record).length ? record : undefined };
}

/** Extra JSON as the editor shows it. */
export function formatExtra(extra: Record<string, unknown> | undefined): string {
  return extra ? JSON.stringify(extra, null, 2) : "";
}

/* ---- Mutations ---- */

/** A new profile id: `p-` and 8 base36 characters, not in use. */
export function newProfileId(taken: Iterable<string> = getSettings().ai.profiles.map((p) => p.id)): string {
  const used = new Set(taken);
  for (;;) {
    let id = "p-";
    for (let i = 0; i < 8; i++) id += Math.floor(Math.random() * 36).toString(36);
    if (!used.has(id)) return id;
  }
}

/** A blank profile to start the editor with (not saved). */
export function blankProfile(settings: Settings = getSettings()): AiProfile {
  const { profiles } = settings.ai;
  return {
    id: newProfileId(profiles.map((p) => p.id)),
    name: uniqueName(`Model ${profiles.length + 1}`, profiles.map((p) => p.name)),
    provider: "",
    model: "",
    baseUrl: "",
    cliPath: "",
  };
}

/** Whether `name` is free for profile `id` (names are unique case-insensitively). */
export function nameTaken(name: string, id: string, settings: Settings = getSettings()): boolean {
  const lower = name.trim().toLowerCase();
  return settings.ai.profiles.some((p) => p.id !== id && p.name.toLowerCase() === lower);
}

function update(patch: Partial<AiSettings>): void {
  useSettings.getState().updateAi(patch);
}

/** Saves `profile`: replaces the one with its id, or appends it. The first profile becomes the default. */
export function saveProfile(profile: AiProfile): void {
  const { profiles } = getSettings().ai;
  const at = profiles.findIndex((p) => p.id === profile.id);
  if (at < 0 && profiles.length >= AI_PROFILE_LIMIT) return;
  const next = at < 0 ? [...profiles, profile] : profiles.map((p) => (p.id === profile.id ? profile : p));
  update({ profiles: next });
}

/**
 * Removes a profile. Features overriding to it fall back to the default;
 * if it was the default, the first remaining profile becomes the default
 * (or none).
 */
export function deleteProfile(id: string): void {
  const { profiles, defaultProfile, features } = getSettings().ai;
  const rest = profiles.filter((p) => p.id !== id);
  const kept: Partial<Record<AiFeature, string>> = {};
  for (const [feature, target] of Object.entries(features) as [AiFeature, string][]) if (target !== id) kept[feature] = target;
  update({ profiles: rest, features: kept, defaultProfile: defaultProfile === id ? (rest[0]?.id ?? "") : defaultProfile });
}

/** A copy of a profile under a new id and name, placed after it. Returns the copy's id. */
export function duplicateProfile(id: string): string | null {
  const { profiles } = getSettings().ai;
  const at = profiles.findIndex((p) => p.id === id);
  if (at < 0 || profiles.length >= AI_PROFILE_LIMIT) return null;
  const source = profiles[at];
  const copy: AiProfile = {
    ...source,
    id: newProfileId(profiles.map((p) => p.id)),
    name: uniqueName(clip(`${source.name} copy`, AI_PROFILE_NAME_MAX), profiles.map((p) => p.name)),
  };
  update({ profiles: [...profiles.slice(0, at + 1), copy, ...profiles.slice(at + 1)] });
  return copy.id;
}

export function setDefaultProfile(id: string): void {
  update({ defaultProfile: id });
}

/** Points `feature` at a profile; null makes it use the default. */
export function setFeatureProfile(feature: AiFeature, id: string | null): void {
  const features = { ...getSettings().ai.features };
  if (id) features[feature] = id;
  else delete features[feature];
  update({ features });
}

/** What deleting a profile does to the features, for the confirmation (empty when nothing uses it). */
export function deleteWarning(id: string, settings: Settings = getSettings()): string | null {
  const users = featuresUsing(id, settings);
  if (!users.length) return null;
  const { profiles, defaultProfile } = settings.ai;
  const rest = profiles.filter((p) => p.id !== id);
  const fallback = defaultProfile === id ? rest[0] : profiles.find((p) => p.id === defaultProfile);
  const names = users.map(featureLabel).join(", ");
  return fallback ? `${names} will use ${fallback.name} instead.` : `${names} will have no model.`;
}
