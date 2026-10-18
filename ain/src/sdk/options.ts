/**
 * Plugin options: a plugin declares its fields once; the settings page draws controls from them and
 * the plugin reads validated values through `host.options()`. A field's value type is its default's type.
 * A `secret` is the exception: it lives in the system's credential store, and the plugin reads it
 * with `host.secret(key)`.
 */
import { isHex } from "./color";

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
  /** Drawn as a box to type the number in rather than a slider: for wide ranges, e.g. a port. */
  readonly box?: boolean | undefined;
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

/** What typed text must look like; Settings says what's wrong and doesn't save it until it fits. */
export interface Rules {
  /** Can't be left empty: the plugin's card says it needs setting up until it's filled in. */
  readonly required?: boolean | undefined;
  /** A regular expression the whole value must match, e.g. "[A-Za-z0-9]{32}". */
  readonly pattern?: string | undefined;
  /** Said when the value doesn't match `pattern`, e.g. "32 letters or digits". */
  readonly invalid?: string | undefined;
  readonly maxLength?: number | undefined;
}

/** Free text, e.g. a city or an id another control picks; "" for none. */
export interface TextField extends Base<string>, Rules {
  readonly kind: "text";
  readonly placeholder?: string | undefined;
  /** Several lines, e.g. a template. */
  readonly multiline?: boolean | undefined;
}

/** An API key, a token, a password: typed hidden, kept in the system's credential store. */
export interface SecretField extends Base<string>, Rules {
  readonly kind: "secret";
  readonly placeholder?: string | undefined;
}

/** A color, as "#rrggbb". */
export interface ColorField extends Base<string> {
  readonly kind: "color";
}

export type Field = ToggleField | NumberField | ChoiceField | ListField | FolderField | TextField | SecretField | ColorField;
export type Fields = Readonly<Record<string, Field>>;
export type Values<F extends Fields> = { readonly [K in keyof F]: F[K]["default"] };

export const toggle = (label: string, value: boolean, hint?: string): ToggleField => ({ kind: "toggle", label, default: value, hint });

export const number = (
  label: string,
  value: number,
  range: { min: number; max: number; step?: number; unit?: string; box?: boolean },
  hint?: string,
): NumberField => ({ kind: "number", label, default: value, min: range.min, max: range.max, step: range.step ?? 1, unit: range.unit, box: range.box, hint });

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

/** How a text or a secret is typed and checked. */
export interface TextOptions extends Rules {
  readonly placeholder?: string;
  readonly hint?: string;
  readonly multiline?: boolean;
}

/** `text(label, value, placeholder?, hint?)`, or `text(label, value, { placeholder, hint, required, pattern, … })`. */
export const text = (label: string, value = "", placeholder?: string | TextOptions, hint?: string): TextField =>
  typeof placeholder === "object" ? { ...placeholder, kind: "text", label, default: value } : { kind: "text", label, default: value, placeholder, hint };

export const secret = (label: string, rules: Omit<TextOptions, "multiline"> = {}): SecretField => ({ ...rules, kind: "secret", label, default: "" });

export const color = (label: string, value: string, hint?: string): ColorField => ({ kind: "color", label, default: value.toLowerCase(), hint });

/** `pattern` as a regular expression the whole value must match; null when there's none or it doesn't compile. */
export function patternOf(rules: Rules): RegExp | null {
  if (!rules.pattern) return null;
  try {
    return new RegExp(`^(?:${rules.pattern})$`, "u");
  } catch {
    return null;
  }
}

/** What's wrong with typed text, or null when it's fine. Empty is fine unless required. */
export function textProblem(rules: Rules, value: string): string | null {
  if (!value) return rules.required ? "Required." : null;
  if (rules.maxLength !== undefined && value.length > rules.maxLength) return `At most ${rules.maxLength} characters.`;
  if (patternOf(rules)?.test(value) === false) return rules.invalid ? `Expected ${rules.invalid}.` : "Doesn't have the expected format.";
  return null;
}

/** What's wrong with a typed number, or null when it's fine. */
export function numberProblem(field: NumberField, value: number): string | null {
  const unit = field.unit ? ` ${field.unit}` : "";
  if (!Number.isFinite(value)) return "Type a number.";
  if (value < field.min || value > field.max) return `Between ${field.min} and ${field.max}${unit}.`;
  const steps = (value - field.min) / field.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) return `In steps of ${field.step}${unit}.`;
  return null;
}

/**
 * The labels of required fields left empty: what the plugin still needs before it can work.
 * `saved` tells which secrets are in the credential store.
 */
export function unset(fields: Fields, raw: unknown, saved: (key: string) => boolean): string[] {
  const values = resolve(fields, raw) as Record<string, unknown>;
  return Object.entries(fields).flatMap(([key, f]) => {
    if (!("required" in f) || !f.required) return [];
    const empty = f.kind === "secret" ? !saved(key) : values[key] === "";
    return empty ? [f.label] : [];
  });
}

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
    case "text": {
      // What Settings refused to save never reaches the plugin, even if written to the file by hand.
      const text = typeof raw === "string" ? raw.trim() : field.default;
      return text && textProblem({ ...field, required: false }, text) ? field.default : text;
    }
    case "secret":
      // Never in the settings: the plugin reads it with `host.secret(key)`.
      return "";
    case "color":
      return isHex(raw) ? raw.toLowerCase() : field.default;
    case "folder":
      return typeof raw === "string" ? raw.trim() : field.default;
  }
}

/** Every field's value, taken from `raw` where valid. */
export function resolve<F extends Fields>(fields: F, raw: unknown): Values<F> {
  const stored = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, valueOf(field, stored[key])])) as Values<F>;
}
