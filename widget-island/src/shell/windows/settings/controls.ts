import { button, h, icon } from "../../../sdk/dom";
import { hexToHsv, hsvToHex, parseHex } from "../../../sdk/color";
import type { Field } from "../../../sdk/options";
import type { Theme } from "../../themes";

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

/**
 * Any color: a saturation/brightness square, a hue slider and the hex code.
 * The swatch opens the palette; `fallback` is what "Theme color" goes back to.
 */
export function colorPicker(value: string, fallback: string, onChange: (v: string) => void, label: string): HTMLElement {
  let [hue, sat, val] = hexToHsv(value);
  const swatch = button("", () => {
    panel.hidden = !panel.hidden;
    swatch.setAttribute("aria-expanded", String(!panel.hidden));
  }, { class: "cp-swatch", "aria-label": `${label}: open the palette`, "aria-expanded": "false", title: "Open the palette" });
  const hex = h("input", { class: "cp-hex", type: "text", maxlength: "7", spellcheck: "false", "aria-label": `${label}, hex code` });
  const reset = button("Theme color", () => setHex(fallback), { class: "secondary" });
  const knob = h("i", { class: "cp-knob" });
  const area = h("div", { class: "cp-area", tabindex: "0", role: "slider", "aria-label": `${label}: saturation and brightness` }, knob);
  const hueInput = h("input", { class: "cp-hue", type: "range", min: "0", max: "359", step: "1", "aria-label": `${label}: hue` });
  const panel = h("div", { class: "cp-panel" }, area, hueInput);
  panel.hidden = true;

  const paint = (): string => {
    const color = hsvToHex([hue, sat, val]);
    swatch.style.setProperty("--swatch", color);
    area.style.setProperty("--hue", String(Math.round(hue)));
    knob.style.left = `${sat * 100}%`;
    knob.style.top = `${(1 - val) * 100}%`;
    knob.style.background = color;
    area.setAttribute("aria-valuetext", color);
    hueInput.value = String(Math.round(hue));
    if (document.activeElement !== hex) hex.value = color;
    reset.hidden = color === fallback;
    return color;
  };
  const emit = () => onChange(paint());
  const setHex = (color: string) => {
    [hue, sat, val] = hexToHsv(color);
    hex.value = color;
    emit();
  };

  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const pick = (e: PointerEvent) => {
    const r = area.getBoundingClientRect();
    sat = clamp((e.clientX - r.left) / r.width);
    val = 1 - clamp((e.clientY - r.top) / r.height);
    emit();
  };
  area.addEventListener("pointerdown", (e) => {
    area.focus();
    try {
      area.setPointerCapture(e.pointerId);
    } catch {
      // Not a live pointer (a synthetic event): still pick where it landed.
    }
    pick(e);
  });
  area.addEventListener("pointermove", (e) => {
    if (area.hasPointerCapture(e.pointerId)) pick(e);
  });
  area.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => (sat = clamp(sat - step)),
      ArrowRight: () => (sat = clamp(sat + step)),
      ArrowUp: () => (val = clamp(val + step)),
      ArrowDown: () => (val = clamp(val - step)),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    move();
    emit();
  });
  hueInput.addEventListener("input", () => {
    hue = hueInput.valueAsNumber;
    emit();
  });
  hex.addEventListener("input", () => {
    const color = parseHex(hex.value);
    if (!color) return;
    [hue, sat, val] = hexToHsv(color);
    emit();
  });
  hex.addEventListener("change", () => {
    hex.value = paint();
  });
  paint();
  return h("div", { class: "cp" }, h("div", { class: "cp-row" }, swatch, hex, reset), panel);
}

/** The built-in themes as tiles, each previewing its background, text and colors. */
export function themeGrid(themes: readonly Theme[], current: string, onPick: (theme: Theme) => void): HTMLElement {
  return h(
    "div",
    { class: "themes", role: "radiogroup", "aria-label": "Theme" },
    ...themes.map((th) => {
      const tile = button(
        h(
          "span",
          { class: "theme-preview" },
          h("span", { class: "theme-aa" }, "Aa"),
          h("span", { class: "theme-dots" }, ...[th.accent, th.ok, th.warn, th.hot].map((c) => h("i", { style: `background:${c}` }))),
        ),
        () => onPick(th),
        { class: "theme-tile", role: "radio", "aria-checked": String(th.id === current), title: th.name },
      );
      tile.style.setProperty("--t-bg", th.bg);
      tile.style.setProperty("--t-fg", th.fg);
      tile.append(h("span", { class: "theme-name" }, th.name));
      return tile;
    }),
  );
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
/** A drop-down list: for choices too many (or too long) to sit side by side. */
export function dropdown(
  value: string,
  choices: readonly { readonly value: string; readonly label: string }[],
  onChange: (v: string) => void,
  label: string,
): HTMLSelectElement {
  const select = h("select", { class: "dropdown", "aria-label": label }, ...choices.map((c) => h("option", { value: c.value }, c.label)));
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/** Up to this many choices show as buttons side by side; more become a drop-down list. */
export const MAX_SEGMENTS = 3;

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
      return f.choices.length > MAX_SEGMENTS
        ? field(f.label, f.hint, dropdown(value as string, f.choices, onChange, f.label), true)
        : field(f.label, f.hint, segmented(value as string, f.choices, onChange, f.label));
    case "list":
      return field(f.label, f.hint, chips(value as readonly string[], f.placeholder, onChange, f.label), true);
    case "folder":
      return field(f.label, f.hint, folderControl(value as string, f.placeholder, pickFolder, onChange, f.label), true);
  }
}
