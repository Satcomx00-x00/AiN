import { button, h, icon } from "../core/dom";
import type { Field } from "../core/options";

const X = `<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>`;

/** A labelled setting: text on the left, its control on the right (or below, when `wide`). */
export function field(label: string, hint: string | undefined, control: HTMLElement, wide = false): HTMLElement {
  return h(
    "div",
    { class: wide ? "field wide" : "field" },
    h("div", {}, h("div", { class: "field-label" }, label), ...(hint ? [h("div", { class: "field-hint" }, hint)] : [])),
    control,
  );
}

export function switchControl(value: boolean, onChange: (v: boolean) => void, label: string): HTMLButtonElement {
  const el = button("", () => {
    value = !value;
    el.setAttribute("aria-checked", String(value));
    onChange(value);
  }, { class: "switch", role: "switch", "aria-checked": String(value), "aria-label": label });
  return el;
}

export function rangeControl(
  value: number,
  range: { min: number; max: number; step: number; unit?: string | undefined },
  onChange: (v: number) => void,
  label: string,
): HTMLElement {
  const unit = range.unit ? ` ${range.unit}` : "";
  const out = h("output", { class: "range-value" }, `${value}${unit}`);
  const input = h("input", {
    type: "range",
    class: "range",
    min: String(range.min),
    max: String(range.max),
    step: String(range.step),
    value: String(value),
    "aria-label": label,
  });
  const paint = () => input.style.setProperty("--p", String((input.valueAsNumber - range.min) / (range.max - range.min || 1)));
  input.addEventListener("input", () => {
    out.textContent = `${input.value}${unit}`;
    paint();
    onChange(input.valueAsNumber);
  });
  paint();
  return h("div", { class: "range-wrap" }, input, out);
}

export function segmented(
  value: string,
  choices: readonly { readonly value: string; readonly label: string }[],
  onChange: (v: string) => void,
  label: string,
): HTMLElement {
  const group = h("div", { class: "seg", role: "radiogroup", "aria-label": label });
  const buttons = choices.map((c) =>
    button(c.label, () => {
      for (const b of buttons) b.setAttribute("aria-checked", String(b === buttons[choices.indexOf(c)]));
      onChange(c.value);
    }, { role: "radio", "aria-checked": String(c.value === value) }),
  );
  group.append(...buttons);
  return group;
}

/** Editable list of short strings: chips with a remove button, plus an input that adds on Enter. */
export function chips(value: readonly string[], placeholder: string | undefined, onChange: (v: string[]) => void, label: string): HTMLElement {
  let items = [...value];
  const wrap = h("div", { class: "chips", role: "group", "aria-label": label });
  const input = h("input", { class: "chip-input", type: "text", placeholder: placeholder ?? "Add…", "aria-label": `Add to ${label}` });
  const draw = () => {
    wrap.replaceChildren(
      ...items.map((item) =>
        h(
          "span",
          { class: "chip" },
          item,
          button(icon(X), () => {
            items = items.filter((i) => i !== item);
            draw();
            onChange(items);
            input.focus();
          }, { class: "chip-x", "aria-label": `Remove ${item}` }),
        ),
      ),
      input,
    );
  };
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const text = input.value.trim();
    if (!text || items.includes(text)) return;
    items = [...items, text];
    input.value = "";
    draw();
    onChange(items);
    input.focus();
  });
  draw();
  return wrap;
}

/**
 * A folder path: type it, or pick it with the system dialog; "Default" clears it.
 * `pick` resolves with the chosen folder, or null if the user cancelled.
 */
export function folderControl(
  value: string,
  placeholder: string | undefined,
  pick: (current: string) => Promise<string | null>,
  onChange: (v: string) => void,
  label: string,
): HTMLElement {
  const input = h("input", { class: "path-input", type: "text", spellcheck: "false", placeholder: placeholder ?? "Default location", "aria-label": label });
  input.value = value;
  const reset = button("Default", () => set(""), { class: "secondary" });
  const set = (next: string) => {
    input.value = next.trim();
    reset.hidden = !input.value;
    onChange(input.value);
  };
  input.addEventListener("change", () => set(input.value));
  const browse = button("Browse…", () => {
    pick(input.value).then((chosen) => (chosen ? set(chosen) : undefined), (e: unknown) => console.error("[settings] folder picker", e));
  }, { class: "secondary" });
  reset.hidden = !value;
  return h("div", { class: "path" }, input, browse, reset);
}

/** The right control for a plugin option field. */
export function optionControl(
  f: Field,
  value: unknown,
  onChange: (v: unknown) => void,
  pickFolder: (current: string) => Promise<string | null> = async () => null,
): HTMLElement {
  switch (f.kind) {
    case "toggle":
      return field(f.label, f.hint, switchControl(value as boolean, onChange, f.label));
    case "number":
      return field(f.label, f.hint, rangeControl(value as number, f, onChange, f.label));
    case "choice":
      return field(f.label, f.hint, segmented(value as string, f.choices, onChange, f.label));
    case "list":
      return field(f.label, f.hint, chips(value as readonly string[], f.placeholder, onChange, f.label), true);
    case "folder":
      return field(f.label, f.hint, folderControl(value as string, f.placeholder, pickFolder, onChange, f.label), true);
  }
}
