/*
 * Declarative settings fields: plugins describe their settings as data and
 * the host renders them (src/settings/controls.tsx) and validates what is
 * loaded from disk. Pure; unit-tested.
 */

type FieldBase = {
  /** Key in the plugin's settings object. */
  key: string;
  label: string;
  hint?: string;
};

export type SelectOption = { value: string; label: string };

export type SettingField =
  | (FieldBase & { type: "toggle"; default: boolean })
  | (FieldBase & { type: "select"; options: readonly (string | SelectOption)[]; default: string })
  | (FieldBase & { type: "number"; default: number; min?: number; max?: number; integer?: boolean; unit?: string })
  | (FieldBase & { type: "text"; default: string; placeholder?: string })
  /** A list of strings, edited as one line with shell-style quoting. */
  | (FieldBase & { type: "list"; default: string[]; placeholder?: string })
  /**
   * Program names (`vim`, `codex`), edited as removable chips with
   * suggestions from the command history. Entries are trimmed, empty ones
   * dropped and duplicates (case-insensitive) removed.
   */
  | (FieldBase & { type: "programs"; default: string[]; placeholder?: string })
  /** `#rrggbb`. */
  | (FieldBase & { type: "color"; default: string });

export function optionsOf(field: Extract<SettingField, { type: "select" }>): SelectOption[] {
  return field.options.map((option) =>
    typeof option === "string" ? { value: option, label: option[0].toUpperCase() + option.slice(1) } : option,
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Program names trimmed, without empty entries or case-insensitive duplicates (first kept). */
export function normalizePrograms(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** `value` if it is valid for `field` (numbers clamped, text trimmed), else `undefined`. */
export function validateFieldValue(field: SettingField, value: unknown): unknown {
  switch (field.type) {
    case "toggle":
      return typeof value === "boolean" ? value : undefined;
    case "select":
      return typeof value === "string" && optionsOf(field).some((option) => option.value === value) ? value : undefined;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      let number = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, value));
      if (field.integer) number = Math.round(number);
      return number;
    }
    case "text":
      return typeof value === "string" ? value.trim() : undefined;
    case "list":
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
    case "programs":
      return Array.isArray(value) ? normalizePrograms(value.filter((item): item is string => typeof item === "string")) : undefined;
    case "color":
      return typeof value === "string" && HEX.test(value) ? value : undefined;
  }
}

/** Every field's value from untrusted `raw`: valid values kept, the rest defaulted. Unknown keys are dropped. */
export function resolveFields(fields: readonly SettingField[], raw: unknown): Record<string, unknown> {
  const data = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const resolved: Record<string, unknown> = {};
  for (const field of fields) {
    const value = validateFieldValue(field, data[field.key]);
    resolved[field.key] = value === undefined ? field.default : value;
  }
  return resolved;
}

/** Problems with a plugin's field declarations (for imported plugins); empty when fine. */
export function checkFields(fields: unknown): string[] {
  if (!Array.isArray(fields)) return ["settings.fields must be an array"];
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const [index, field] of fields.entries()) {
    const where = `settings.fields[${index}]`;
    if (typeof field !== "object" || field === null) {
      problems.push(`${where} is not an object`);
      continue;
    }
    const { key, label, type } = field as Record<string, unknown>;
    if (typeof key !== "string" || !key) problems.push(`${where}.key must be a non-empty string`);
    else if (key.startsWith("$")) problems.push(`${where}.key "${key}" is reserved (keys starting with $ belong to the host)`);
    else if (keys.has(key)) problems.push(`${where}.key "${key}" is used twice`);
    else keys.add(key);
    if (typeof label !== "string" || !label) problems.push(`${where}.label must be a non-empty string`);
    if (!["toggle", "select", "number", "text", "list", "programs", "color"].includes(type as string)) {
      problems.push(`${where}.type is not a known field type`);
      continue;
    }
    if (type === "select" && !Array.isArray((field as Record<string, unknown>).options)) {
      problems.push(`${where}.options must be an array`);
      continue;
    }
    const fallback = (field as Record<string, unknown>).default;
    const valid = validateFieldValue(field as SettingField, fallback);
    // A list default is used as is when nothing is saved, so every entry must be a string.
    const listWithJunk = (type === "list" || type === "programs") && Array.isArray(fallback) && fallback.some((item) => typeof item !== "string");
    if (valid === undefined || listWithJunk) problems.push(`${where}.default is not a valid value for the field`);
  }
  return problems;
}
