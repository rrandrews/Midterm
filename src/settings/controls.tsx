import { type ReactNode, useEffect, useState } from "react";
import { type SettingField, optionsOf } from "../plugins/fields";
import { isHexColor, joinArgs, splitArgs } from "./schema";

/*
 * Controls for the settings dialog, shared by its sections and used to
 * render plugins' declarative fields.
 */

export const FIELD =
  "h-6 rounded-[5px] bg-field px-2 text-ui text-fg outline-none shadow-[inset_0_0_0_1px_var(--color-line)] focus:shadow-[inset_0_0_0_1px_var(--color-accent)]";

export const BUTTON =
  "h-6 flex-none rounded-[5px] bg-raised px-2.5 text-meta text-fg-soft outline-none hover:text-fg-bright focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] disabled:opacity-40";

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-4 border-b border-line/60 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-ui text-fg-soft">{label}</div>
        {hint && <div className="text-meta text-fg-dim">{hint}</div>}
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}

/** A heading between groups of rows. */
export function SectionHeading({ children }: { children: ReactNode }) {
  return <div className="pt-4 pb-1 text-meta font-medium tracking-wide text-fg-dim uppercase first:pt-0">{children}</div>;
}

export function Select<T extends string>({
  value,
  options,
  labels,
  onChange,
  label,
}: {
  value: T;
  options: readonly T[];
  labels?: Partial<Record<T, string>>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <select aria-label={label} className={`${FIELD} pr-6`} value={value} onChange={(event) => onChange(event.target.value as T)}>
      {options.map((option) => (
        <option key={option} value={option}>
          {labels?.[option] ?? option[0].toUpperCase() + option.slice(1)}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 flex-none rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-accent" : "bg-raised"}`}
    >
      <span
        className={`absolute top-0.5 size-3 rounded-full bg-fg-bright transition-[left] ${checked ? "left-3.5" : "left-0.5"}`}
      />
    </button>
  );
}

/** A text field that commits on Enter or blur; Escape reverts. */
export function CommitField({
  value,
  onCommit,
  label,
  placeholder,
  className = "w-56",
  type = "text",
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
  type?: "text" | "number" | "password";
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      aria-label={label}
      type={type}
      spellCheck={false}
      placeholder={placeholder}
      className={`${FIELD} ${className}`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit(draft);
        if (event.key === "Escape" && draft !== value) {
          event.stopPropagation();
          setDraft(value);
        }
      }}
    />
  );
}

/** The control for one declarative field. */
export function FieldControl({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (field.type) {
    case "toggle":
      return <Toggle label={field.label} checked={value === true} onChange={onChange} />;
    case "select": {
      const options = optionsOf(field);
      return (
        <Select
          label={field.label}
          value={String(value)}
          options={options.map((option) => option.value)}
          labels={Object.fromEntries(options.map((option) => [option.value, option.label]))}
          onChange={onChange}
        />
      );
    }
    case "number":
      return (
        <CommitField
          label={field.label}
          type="number"
          className="w-28"
          value={String(value)}
          onCommit={(text) => {
            const number = Number.parseFloat(text);
            if (Number.isFinite(number)) onChange(number);
          }}
        />
      );
    case "text":
      return <CommitField label={field.label} placeholder={field.placeholder} value={String(value ?? "")} onCommit={onChange} />;
    case "list":
      return (
        <CommitField
          label={field.label}
          placeholder={field.placeholder}
          value={joinArgs(Array.isArray(value) ? (value as string[]) : [])}
          onCommit={(text) => onChange(splitArgs(text))}
        />
      );
    case "color":
      return (
        <input
          type="color"
          aria-label={field.label}
          className="h-6 w-10 cursor-pointer rounded-[5px] bg-transparent"
          value={String(value).toLowerCase()}
          onChange={(event) => isHexColor(event.target.value) && onChange(event.target.value)}
        />
      );
  }
}

/** Rows for a list of declarative fields. */
export function FieldRows({
  fields,
  values,
  onChange,
}: {
  fields: readonly SettingField[];
  values: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  return (
    <>
      {fields.map((field) => (
        <Row key={field.key} label={field.label} hint={field.hint}>
          <FieldControl field={field} value={values[field.key]} onChange={(value) => onChange({ [field.key]: value })} />
        </Row>
      ))}
    </>
  );
}
