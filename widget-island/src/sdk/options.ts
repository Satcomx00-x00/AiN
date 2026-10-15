/**
 * Plugin options: a plugin declares its fields once; the settings page draws controls from them and
 * the plugin reads validated values through `host.options()`. A field's value type is its default's type.
 */

interface Base<T> {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly default: T;
  /**
   * Drawn by the plugin's own `settingsPanel` rather than as a standard control, e.g. a choice
   * that shows live state. Still validated and defaulted like any field.
   */
  readonly inPanel?: boolean | undefined;
}

export interface ToggleField extends Base<boolean> {
  readonly kind: "toggle";
}

export interface NumberField extends Base<number> {
  readonly kind: "number";
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit?: string | undefined;
}

export interface ChoiceField extends Base<string> {
  readonly kind: "choice";
  readonly choices: readonly { readonly value: string; readonly label: string }[];
}

export interface ListField extends Base<readonly string[]> {
  readonly kind: "list";
  readonly placeholder?: string | undefined;
}

/** A folder on disk; "" means the plugin's default location. */
export interface FolderField extends Base<string> {
  readonly kind: "folder";
  readonly placeholder?: string | undefined;
}

/** Free text, e.g. an id another control picks; "" for none. */
export interface TextField extends Base<string> {
  readonly kind: "text";
  readonly placeholder?: string | undefined;
}

export type Field = ToggleField | NumberField | ChoiceField | ListField | FolderField | TextField;
export type Fields = Readonly<Record<string, Field>>;
export type Values<F extends Fields> = { readonly [K in keyof F]: F[K]["default"] };

export const toggle = (label: string, value: boolean, hint?: string): ToggleField => ({ kind: "toggle", label, default: value, hint });

export const number = (
  label: string,
  value: number,
  range: { min: number; max: number; step?: number; unit?: string },
  hint?: string,
): NumberField => ({ kind: "number", label, default: value, min: range.min, max: range.max, step: range.step ?? 1, unit: range.unit, hint });

export const choice = (label: string, value: string, choices: readonly (readonly [value: string, label: string])[], hint?: string): ChoiceField => ({
  kind: "choice",
  label,
  default: value,
  choices: choices.map(([v, l]) => ({ value: v, label: l })),
  hint,
});

export const list = (label: string, value: readonly string[], placeholder?: string, hint?: string): ListField => ({
  kind: "list",
  label,
  default: value,
  placeholder,
  hint,
});

export const folder = (label: string, placeholder?: string, hint?: string): FolderField => ({ kind: "folder", label, default: "", placeholder, hint });

export const text = (label: string, value = "", placeholder?: string, hint?: string): TextField => ({ kind: "text", label, default: value, placeholder, hint });

/** A stored value if it fits the field, otherwise the field's default. */
export function valueOf(field: Field, raw: unknown): Field["default"] {
  switch (field.kind) {
    case "toggle":
      return typeof raw === "boolean" ? raw : field.default;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? Math.min(field.max, Math.max(field.min, raw)) : field.default;
    case "choice":
      return typeof raw === "string" && field.choices.some((c) => c.value === raw) ? raw : field.default;
    case "list":
      return Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))] : field.default;
    case "text":
      return typeof raw === "string" ? raw.trim() : field.default;
    case "folder":
      return typeof raw === "string" ? raw.trim() : field.default;
  }
}

/** Every field's value, taken from `raw` where valid. */
export function resolve<F extends Fields>(fields: F, raw: unknown): Values<F> {
  const stored = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, valueOf(field, stored[key])])) as Values<F>;
}
