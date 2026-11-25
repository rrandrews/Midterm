import { Globe, Minus, Plus, RotateCcw } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { ColorPopover } from "../components/ui/ColorPicker";
import { Select as Dropdown, type SelectOption } from "../components/ui/Select";
import { Help, Tip } from "../components/ui/Tooltip";
import { type SettingField, optionsOf } from "../plugins/fields";
import { ProgramList } from "./ProgramList";
import { joinArgs, splitArgs } from "./schema";
import { useEditedWorkspace, useOverride } from "./scope";

/*
 * Controls for the settings dialog, shared by its sections and used to
 * render plugins' declarative fields.
 *
 * A section is a stack of `Group`s (a titled, outlined list) holding
 * `Row`s (label left, control right). A row's explanation goes behind a
 * (?) (`help`); `hint` is for live status under the label (a problem, a
 * version), never for prose that is always there.
 */

export const FIELD =
  "h-6 rounded-[5px] bg-field px-2 text-ui text-fg outline-none placeholder:text-fg-faint shadow-[inset_0_0_0_1px_var(--color-line-strong)] focus:shadow-[inset_0_0_0_1px_var(--color-accent)] disabled:opacity-40";

export const BUTTON =
  "inline-flex h-6 flex-none items-center justify-center gap-1 rounded-[5px] bg-raised/70 px-2.5 text-meta font-medium text-fg-soft outline-none hover:bg-raised hover:text-fg-bright focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] disabled:pointer-events-none disabled:opacity-40";

/** The one button that matters in a group of them (Save, Add). */
export const BUTTON_PRIMARY =
  "inline-flex h-6 flex-none items-center justify-center gap-1 rounded-[5px] bg-accent/20 px-2.5 text-meta font-semibold text-accent-fg outline-none shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_50%,transparent)] hover:bg-accent/28 focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] disabled:pointer-events-none disabled:opacity-40";

/** A square icon-only button. */
export const ICON_BUTTON =
  "flex size-6 flex-none items-center justify-center rounded-[5px] text-fg-dim outline-none hover:bg-hover hover:text-fg-bright focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] disabled:pointer-events-none disabled:opacity-30 data-[state=open]:bg-hover data-[state=open]:text-fg-bright";

/** A titled, outlined list of rows. */
export function Group({
  title,
  help,
  actions,
  shared,
  children,
  className = "",
}: {
  title?: ReactNode;
  help?: ReactNode;
  /** Buttons on the right of the title. */
  actions?: ReactNode;
  /** Settings no workspace can override; marked so while a workspace is edited. */
  shared?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const showShared = useEditedWorkspace() !== null && shared;
  return (
    <section className={`mb-5 last:mb-0 ${className}`}>
      {(title || actions || showShared) && (
        <div className="flex min-h-6 items-end gap-1.5 px-1 pb-1.5">
          {title && <h3 className="text-meta font-semibold text-fg-mid">{title}</h3>}
          {help && <Help>{help}</Help>}
          {showShared && <SharedTag />}
          <div className="flex-1" />
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </div>
      )}
      <div className="settings-group overflow-hidden rounded-lg bg-fg-bright/[0.025] shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
        {children}
      </div>
    </section>
  );
}

export function Row({
  label,
  help,
  hint,
  setting,
  children,
  className = "",
}: {
  label: ReactNode;
  /** Explanation, behind a (?). */
  help?: ReactNode;
  /** Status under the label (a problem, a version). */
  hint?: ReactNode;
  /**
   * The setting the row edits, as a path (`fontSize`, `ai.suggestions`,
   * `plugins.terminal.settings.shell`; see `isOverridden`). When a
   * workspace is being edited and overrides it, the row is marked and
   * offers to go back to the default.
   */
  setting?: string;
  children?: ReactNode;
  className?: string;
}) {
  const { overridden, reset } = useOverride(setting);
  return (
    <div className={`settings-row relative flex min-h-10 items-center gap-4 px-3 py-1.5 ${className}`} data-overridden={overridden || undefined}>
      {overridden && <OverrideMark />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-ui text-fg-soft">
          <span className="min-w-0 truncate">{label}</span>
          {help && <Help>{help}</Help>}
        </div>
        {hint && <div className="text-meta text-fg-dim">{hint}</div>}
      </div>
      {(children !== undefined || overridden) && (
        <div className="flex flex-none items-center gap-1.5">
          {overridden && <ResetOverride onReset={reset} />}
          {children}
        </div>
      )}
    </div>
  );
}

/** Marks settings that apply to every workspace, while one workspace is being edited. */
export function SharedTag() {
  return (
    <Tip content="Shared by every workspace: changing it here changes it everywhere.">
      <span className="inline-flex h-4 items-center gap-1 rounded-[4px] bg-fg-bright/[0.05] px-1.5 text-micro font-medium text-fg-dim shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
        <Globe size={9} strokeWidth={2} aria-hidden="true" />
        All workspaces
      </span>
    </Tip>
  );
}

/** The bar on the left of a row whose setting the edited workspace overrides. */
export function OverrideMark() {
  return <span aria-hidden="true" className="absolute top-2 bottom-2 left-0 w-[2px] rounded-r-full bg-accent" />;
}

export function ResetOverride({ onReset }: { onReset: () => void }) {
  return (
    <Tip content="Overridden in this workspace. Click to use the default.">
      <button type="button" aria-label="Use the default value" className={`${ICON_BUTTON} size-5! text-accent/80 hover:text-accent`} onClick={onReset}>
        <RotateCcw size={11} />
      </button>
    </Tip>
  );
}

/** A full-width row for content that does not fit label-and-control (a list, a preview). */
export function Block({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`settings-row px-3 py-2.5 ${className}`}>{children}</div>;
}

/** A heading between rows that are not in a `Group`. */
export function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="px-1 pt-5 pb-1.5 text-meta font-semibold text-fg-mid first:pt-0">{children}</h3>;
}

/** The settings dropdown, typed by its values. */
export function Select<T extends string>({
  value,
  options,
  labels,
  onChange,
  label,
  className,
  disabled,
}: {
  value: T;
  options: readonly T[] | readonly (SelectOption & { value: T })[];
  labels?: Partial<Record<T, string>>;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  const items: SelectOption[] = options.map((option) =>
    typeof option === "string"
      ? { value: option, label: labels?.[option as T] ?? option[0].toUpperCase() + option.slice(1) }
      : option,
  );
  return <Dropdown label={label} value={value} options={items} onChange={(next) => onChange(next as T)} className={className} disabled={disabled} />;
}

/** A few mutually exclusive choices, all visible. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`flex h-6 flex-none items-center gap-px rounded-[6px] bg-field p-[2px] shadow-[inset_0_0_0_1px_var(--color-line-strong)] ${disabled ? "pointer-events-none opacity-40" : ""}`}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const at = options.findIndex((option) => option.value === value);
        const next = options[(at + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length];
        onChange(next.value);
        (event.currentTarget.querySelector(`[data-value="${CSS.escape(next.value)}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          data-value={option.value}
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          title={option.title}
          onClick={() => onChange(option.value)}
          className="flex h-full items-center gap-1 rounded-[4px] px-2 text-meta font-medium text-fg-dim outline-none hover:text-fg-soft focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] aria-checked:bg-raised aria-checked:text-fg-bright aria-checked:shadow-[0_1px_2px_var(--color-shadow)]"
        >
          {option.label}
        </button>
      ))}
    </div>
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
      className={`relative h-[18px] w-[30px] flex-none rounded-full outline-none transition-colors duration-150 focus-visible:shadow-[0_0_0_1px_var(--color-app),0_0_0_2px_var(--color-accent)] disabled:opacity-40 ${checked ? "bg-accent" : "bg-raised shadow-[inset_0_0_0_1px_var(--color-line-strong)]"}`}
    >
      <span
        className={`absolute top-[2px] size-[14px] rounded-full shadow-[0_1px_2px_var(--color-shadow)] transition-[left] duration-150 ${checked ? "left-[14px] bg-app" : "left-[2px] bg-fg-mid"}`}
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
  style,
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
  type?: "text" | "password";
  style?: CSSProperties;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      aria-label={label}
      type={type}
      spellCheck={false}
      autoComplete="off"
      placeholder={placeholder}
      className={`${FIELD} ${className}`}
      style={style}
      value={draft}
      data-escape-local={draft !== value ? "" : undefined}
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

const STEPPER =
  "flex h-full w-5 flex-none items-center justify-center text-fg-dim outline-none hover:bg-hover hover:text-fg-bright disabled:pointer-events-none disabled:opacity-30";

/** A number with − and + (and the arrow keys); commits on Enter, blur or a step. Clamped to min/max. */
export function NumberField({
  value,
  onCommit,
  label,
  min = -Infinity,
  max = Infinity,
  step = 1,
  integer = false,
  unit,
  className = "w-[112px]",
}: {
  value: number;
  onCommit: (value: number) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  unit?: string;
  className?: string;
}) {
  const format = (number: number) =>
    integer ? (Math.abs(number) >= 10_000 ? Math.round(number).toLocaleString("en-US") : String(Math.round(number))) : String(number);
  const [draft, setDraft] = useState(format(value));
  // Whether the text was typed in since the value last showed; untouched text is never committed.
  const edited = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: format follows `integer` only
  useEffect(() => {
    setDraft(format(value));
    edited.current = false;
  }, [value]);
  const clamp = (number: number) => {
    const clamped = Math.min(max, Math.max(min, number));
    return integer ? Math.round(clamped) : clamped;
  };
  const commit = (number: number) => {
    const next = clamp(number);
    edited.current = false;
    setDraft(format(next));
    if (next !== value) onCommit(next);
  };
  const revert = () => {
    edited.current = false;
    setDraft(format(value));
  };
  /** The typed number, or null when the text is not one (thousands separators only in their places). */
  const parsed = (): number | null => {
    const text = draft.trim();
    if (!/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.test(text) || !/\d/.test(text)) return null;
    const number = Number(text.replace(/,/g, ""));
    return Number.isFinite(number) ? number : null;
  };
  const commitDraft = () => {
    if (!edited.current) return;
    const number = parsed();
    if (number === null) revert();
    else commit(number);
  };
  return (
    <div
      className={`flex h-6 flex-none items-stretch overflow-hidden rounded-[5px] bg-field shadow-[inset_0_0_0_1px_var(--color-line-strong)] focus-within:shadow-[inset_0_0_0_1px_var(--color-accent)] ${className}`}
    >
      <button type="button" tabIndex={-1} aria-label={`Decrease ${label}`} className={STEPPER} disabled={value <= min} onClick={() => commit(value - step)}>
        <Minus size={11} />
      </button>
      <div className="flex min-w-0 flex-1 items-center justify-center" onClick={() => input.current?.focus()}>
        <input
          ref={input}
          aria-label={label}
          inputMode="decimal"
          spellCheck={false}
          className="w-full min-w-0 bg-transparent text-center font-mono text-meta text-fg tabular-nums outline-none [field-sizing:content]"
          value={draft}
          data-escape-local={edited.current ? "" : undefined}
          onChange={(event) => {
            edited.current = true;
            setDraft(event.target.value);
          }}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitDraft();
            else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const from = (edited.current ? parsed() : null) ?? value;
              commit(from + (event.key === "ArrowUp" ? step : -step) * (event.shiftKey ? 10 : 1));
            } else if (event.key === "Escape" && edited.current) {
              event.stopPropagation();
              revert();
            }
          }}
        />
        {unit && <span className="pl-1 text-micro text-fg-faint">{unit}</span>}
      </div>
      <button type="button" tabIndex={-1} aria-label={`Increase ${label}`} className={STEPPER} disabled={value >= max} onClick={() => commit(value + step)}>
        <Plus size={11} />
      </button>
    </div>
  );
}

/** Whether a select field reads best as a segmented control: few, short choices. */
function segmentable(options: { label: string }[]): boolean {
  return options.length <= 3 && options.reduce((sum, option) => sum + option.label.length, 0) <= 26;
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
      if (segmentable(options)) return <Segmented label={field.label} value={String(value)} options={options} onChange={onChange} />;
      return <Dropdown label={field.label} value={String(value)} options={options} onChange={onChange} />;
    }
    case "number":
      return (
        <NumberField
          label={field.label}
          value={typeof value === "number" ? value : field.default}
          min={field.min}
          max={field.max}
          integer={field.integer}
          unit={field.unit}
          step={field.integer && (field.max ?? 0) >= 10_000 ? 1000 : 1}
          className={(field.max ?? 0) >= 10_000 ? "w-[128px]" : undefined}
          onCommit={onChange}
        />
      );
    case "text":
      return <CommitField label={field.label} placeholder={field.placeholder} value={String(value ?? "")} onCommit={onChange} />;
    case "list":
      return (
        <CommitField
          label={field.label}
          className="w-56 font-mono text-meta!"
          placeholder={field.placeholder}
          value={joinArgs(Array.isArray(value) ? (value as string[]) : [])}
          onCommit={(text) => onChange(splitArgs(text))}
        />
      );
    case "programs":
      return (
        <ProgramList
          label={field.label}
          placeholder={field.placeholder}
          value={(Array.isArray(value) ? (value as unknown[]) : field.default).filter((item): item is string => typeof item === "string")}
          onChange={onChange}
        />
      );
    case "color":
      return <ColorPopover label={field.label} value={String(value).toLowerCase()} onChange={onChange} align="end" />;
  }
}

/**
 * A row whose control takes the full width under its label (a list of
 * chips), with an optional reset on the label line.
 */
export function StackedRow({
  label,
  help,
  onReset,
  setting,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  /** Shown as a reset button when set (the value differs from its default). */
  onReset?: () => void;
  /** As for `Row`. */
  setting?: string;
  children: ReactNode;
}) {
  const override = useOverride(setting);
  return (
    <div className="settings-row relative px-3 pt-2 pb-2.5" data-overridden={override.overridden || undefined}>
      {override.overridden && <OverrideMark />}
      <div className="mb-1.5 flex h-5 items-center gap-1 text-ui text-fg-soft">
        <span className="min-w-0 truncate">{label}</span>
        {help && <Help>{help}</Help>}
        <div className="flex-1" />
        {override.overridden && <ResetOverride onReset={override.reset} />}
        {onReset && !override.overridden && (
          <Tip content="Reset to default">
            <button type="button" aria-label="Reset to default" className={`${ICON_BUTTON} size-5!`} onClick={onReset}>
              <RotateCcw size={11} />
            </button>
          </Tip>
        )}
      </div>
      {children}
    </div>
  );
}

function sameList(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Rows for a list of declarative fields; put them in a `Group`. */
export function FieldRows({
  fields,
  values,
  onChange,
  pluginId,
}: {
  fields: readonly SettingField[];
  values: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  /** The plugin the values are saved under, so rows can show workspace overrides. */
  pluginId?: string;
}) {
  const setting = (key: string) => (pluginId ? `plugins.${pluginId}.settings.${key}` : undefined);
  return (
    <>
      {fields.map((field) => {
        const control = (
          <FieldControl field={field} value={values[field.key]} onChange={(value) => onChange({ [field.key]: value })} />
        );
        if (field.type === "programs") {
          return (
            <StackedRow
              key={field.key}
              label={field.label}
              help={field.hint}
              setting={setting(field.key)}
              onReset={sameList(values[field.key], field.default) ? undefined : () => onChange({ [field.key]: [...field.default] })}
            >
              {control}
            </StackedRow>
          );
        }
        return (
          <Row key={field.key} label={field.label} help={field.hint} setting={setting(field.key)}>
            {control}
          </Row>
        );
      })}
    </>
  );
}
