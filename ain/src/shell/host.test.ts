// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Greeting, Stage } from "../sdk/greeting";
import type { Host } from "../sdk/plugin";
import { secret, text } from "../sdk/options";
import type { AnyStyle, Folded } from "../sdk/style";
import { mount } from "./host";
import { type Settings, defaults } from "./settings";
import type { WindowPort } from "./window";

const EMPTY = { glance: { left: [], right: [] }, tabs: [] };
const settings = (greeting: string): Settings => {
  const base = defaults(EMPTY as never);
  return { ...base, general: { ...base.general, greeting } };
};
/** A window that records the auto-hide rules and input regions it is sent, and can show or hide the pill on cue. */
function fakeWindow() {
  const rules: [number | null, number][] = [];
  const regions: { width: number; height: number }[] = [];
  const canvases: { width: number; height: number }[] = [];
  let reveal: (shown: boolean) => void = () => {};
  const port: WindowPort = {
    island: async () => ({ width: 200, height: 32, hasNotch: false }),
    layout: async (canvas, region) => void (canvases.push(canvas), regions.push(region)),
    autoHide: async (dwell, grace) => void rules.push([dwell, grace]),
    onReveal: async (onReveal) => ((reveal = onReveal), () => {}),
  };
  return { port, rules, regions, canvases, reveal: (shown: boolean) => reveal(shown) };
}
let win = fakeWindow();

/** A greeting that records its plays and ends when told to. */
function controlled(id: string) {
  const plays: (() => void)[] = [];
  const greeting: Greeting = { id, label: id, play: () => new Promise<void>((r) => plays.push(r)) };
  return { greeting, plays, finish: () => plays.at(-1)?.() };
}

/** Lets every pending promise chain run. */
const settleAll = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.restoreAllMocks());

/** A style that records what it is asked to draw. */
function recording(id: string, extra: Partial<AnyStyle> = {}) {
  const drawn: Folded[] = [];
  const mounts: HTMLElement[] = [];
  let destroyed = 0;
  const style: AnyStyle = {
    id,
    label: id,
    mount: (root) => {
      mounts.push(root);
      root.append(document.createElement("i"));
      return { draw: (f) => void drawn.push(f), destroy: () => void destroyed++ };
    },
    ...extra,
  };
  return { style, drawn, mounts, destroyed: () => destroyed };
}

const PILL = recording("pill");
const HIDDEN = recording("hidden", { hidden: true });

async function start(chosen: string | Settings, ...gs: Greeting[]) {
  return startWith(chosen, gs, [PILL.style, HIDDEN.style]);
}

async function startWith(chosen: string | Settings, gs: Greeting[], styles: AnyStyle[]) {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  const el = document.createElement("div");
  document.body.replaceChildren(el);
  win = fakeWindow();
  const handle = await mount(el, [], {}, win.port, typeof chosen === "string" ? settings(chosen) : chosen, { greetings: gs, styles });
  return { el, handle };
}

const withGeneral = (patch: Partial<Settings["general"]>, base = settings("one")): Settings => ({ ...base, general: { ...base.general, ...patch } });

describe("the island's startup animation", () => {
  it("plays the chosen one at startup, and the pill doesn't open before it's over", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const { el } = await start("two", a.greeting, b.greeting);
    expect([a.plays.length, b.plays.length]).toEqual([0, 1]);
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("false");
    b.finish();
    await settleAll();
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("true");
  });

  it("plays again, as a preview, when another one is picked", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const { handle } = await start("one", a.greeting, b.greeting);
    a.finish();
    await settleAll();
    handle.configure(settings("one"));
    await settleAll();
    expect(a.plays).toHaveLength(1);
    handle.configure(settings("two"));
    await settleAll();
    expect(b.plays).toHaveLength(1);
  });

  it("doesn't open while a preview plays", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const { el, handle } = await start("one", a.greeting, b.greeting);
    a.finish();
    await settleAll();
    handle.configure(settings("two"));
    await settleAll();
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("false");
    b.finish();
    await settleAll();
    el.dispatchEvent(new MouseEvent("pointerleave"));
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("true");
  });

  it("doesn't preview before the startup one is over", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const { handle } = await start("one", a.greeting, b.greeting);
    handle.configure(settings("two"));
    await settleAll();
    expect(b.plays).toHaveLength(0);
  });

  it("plays only the last of several quick picks, after the one playing", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const c = controlled("three");
    const { handle } = await start("one", a.greeting, b.greeting, c.greeting);
    a.finish();
    await settleAll();
    handle.configure(settings("two"));
    await settleAll();
    handle.configure(settings("three"));
    handle.configure(settings("one"));
    handle.configure(settings("three"));
    await settleAll();
    expect([a.plays.length, b.plays.length, c.plays.length]).toEqual([1, 1, 0]);
    b.finish();
    await settleAll();
    expect([a.plays.length, b.plays.length, c.plays.length]).toEqual([1, 1, 1]);
  });

  it("plays the animation asked for by id (the Play button), without changing the setting", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const { handle } = await start("one", a.greeting, b.greeting);
    a.finish();
    await settleAll();
    handle.play("two");
    await settleAll();
    expect([a.plays.length, b.plays.length]).toEqual([1, 1]);
    b.finish();
    await settleAll();
    handle.play();
    await settleAll();
    expect([a.plays.length, b.plays.length]).toEqual([2, 1]);
  });

  it("plays the same animation again each time it's asked", async () => {
    const a = controlled("one");
    const { handle } = await start("one", a.greeting);
    for (let n = 0; n < 2; n++) {
      a.finish();
      await settleAll();
      handle.play("one");
      await settleAll();
    }
    expect(a.plays).toHaveLength(3);
  });

  it("ignores Play while the startup one is still on, or for “none”", async () => {
    const a = controlled("one");
    const { handle } = await start("one", a.greeting);
    handle.play("one");
    await settleAll();
    expect(a.plays).toHaveLength(1);
    a.finish();
    await settleAll();
    handle.play("none");
    await settleAll();
    expect(a.plays).toHaveLength(1);
  });

  it("doesn't play over the open panel", async () => {
    const a = controlled("one");
    const { el, handle } = await start("one", a.greeting);
    a.finish();
    await settleAll();
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("true");
    handle.play("one");
    await settleAll();
    expect(a.plays).toHaveLength(1);
  });

  it("previews from the animations given with the settings, e.g. once a plugin's is loaded", async () => {
    const a = controlled("one");
    const late = controlled("late");
    const { handle } = await start("one", a.greeting);
    a.finish();
    await settleAll();
    handle.configure(settings("late"), undefined, [a.greeting, late.greeting]);
    await settleAll();
    expect(late.plays).toHaveLength(1);
  });
});

describe("the hidden pill", () => {
  const hiding = (on: boolean, revealDelay = 500): Settings => withGeneral({ style: on ? "hidden" : "pill", revealDelay });

  it("starts hiding only once the startup animation is over", async () => {
    const a = controlled("one");
    await start(hiding(true), a.greeting);
    expect(win.rules).toEqual([]);
    a.finish();
    await settleAll();
    expect(win.rules).toEqual([[500, 260 + 500]]);
  });

  it("sends the rule again only when it changes, and none when turned off", async () => {
    const a = controlled("one");
    const { handle } = await start(hiding(true), a.greeting);
    a.finish();
    await settleAll();
    handle.configure(hiding(true));
    handle.configure(hiding(true, 1000));
    handle.configure(hiding(false));
    expect(win.rules).toEqual([
      [500, 760],
      [1000, 760],
      [null, 760],
    ]);
  });

  it("fades out when hidden, closing the island, and comes back when shown", async () => {
    const a = controlled("one");
    const { el } = await start(hiding(true), a.greeting);
    a.finish();
    await settleAll();
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("true");
    win.reveal(false);
    await settleAll();
    expect([el.dataset.hidden, el.dataset.open]).toEqual(["true", "false"]);
    win.reveal(true);
    expect(el.dataset.hidden).toBe("false");
  });
});

describe("pill styles", () => {
  it("draws the folded island with the chosen style, in the pill's glance row", async () => {
    const a = recording("a");
    const b = recording("b");
    const { el } = await startWith(withGeneral({ style: "b" }), [], [a.style, b.style]);
    await settleAll();
    expect(a.mounts).toHaveLength(0);
    expect(b.mounts).toEqual([el.querySelector(".surface > .glance")]);
    expect(el.dataset.style).toBe("b");
    expect(b.drawn.at(-1)).toMatchObject({ left: null, right: null, ambient: null, alert: false, wide: false });
  });

  it("falls back to the first style when the chosen one is gone", async () => {
    const a = recording("a");
    const { el } = await startWith(withGeneral({ style: "removed-plugin" }), [], [a.style]);
    expect(el.dataset.style).toBe("a");
  });

  it("swaps styles live, clearing the old one's look", async () => {
    const a = recording("a");
    const b = recording("b");
    const { el, handle } = await startWith(withGeneral({ style: "a" }), [], [a.style, b.style]);
    handle.configure(withGeneral({ style: "b" }));
    expect([a.destroyed(), b.mounts.length, el.dataset.style]).toEqual([1, 1, "b"]);
    expect(el.querySelector(".glance")?.children).toHaveLength(1);
    // The same style again isn't mounted again.
    handle.configure(withGeneral({ style: "b", pillCurve: 50 }));
    expect(b.mounts).toHaveLength(1);
  });

  it("takes the styles given with the settings, e.g. once a plugin's is loaded", async () => {
    const a = recording("a");
    const late = recording("late");
    const { el, handle } = await startWith(withGeneral({ style: "late" }), [], [a.style]);
    expect(el.dataset.style).toBe("a");
    handle.configure(withGeneral({ style: "late" }), undefined, undefined, [a.style, late.style]);
    expect(el.dataset.style).toBe("late");
  });

  it("sizes the pill from the style, within limits", async () => {
    const thin = recording("thin", { size: (p) => ({ width: p.width * 0.7, height: 6 }) });
    const { el } = await startWith(withGeneral({ style: "thin" }), [], [thin.style]);
    expect([el.style.getPropertyValue("--w"), el.style.getPropertyValue("--h")]).toEqual(["140px", "6px"]);
    const huge = recording("huge", { size: () => ({ width: 5000, height: 5000 }) });
    const { el: big } = await startWith(withGeneral({ style: "huge" }), [], [huge.style]);
    expect([big.style.getPropertyValue("--w"), big.style.getPropertyValue("--h")]).toEqual(["960px", "120px"]);
  });

  it("sets a style aside when it fails, and carries on with the default", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = recording("a");
    const mountFails = recording("m", {
      mount: () => {
        throw new Error("boom");
      },
    });
    const { el } = await startWith(withGeneral({ style: "m" }), [], [a.style, mountFails.style]);
    expect(el.dataset.style).toBe("a");
    const drawFails = recording("d", {
      mount: () => ({
        draw: () => {
          throw new Error("bang");
        },
      }),
    });
    const { el: other } = await startWith(withGeneral({ style: "d" }), [], [a.style, drawFails.style]);
    await settleAll();
    expect(other.dataset.style).toBe("a");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`"d": draw failed`));
  });

  it("keeps running with no style at all", async () => {
    const { el } = await startWith(settings("one"), [], []);
    expect(el.dataset.style).toBe("bare");
  });
});

describe("pill sizes", () => {
  it("scales the pill, its content and its ears", async () => {
    const sizes = [
      ["low", "160px", "20px", "0.625"],
      ["normal", "200px", "32px", "1"],
      ["large", "260px", "44px", "1.375"],
    ] as const;
    for (const [size, w, h, scale] of sizes) {
      const { el } = await start(withGeneral({ pillSize: size }));
      expect([el.style.getPropertyValue("--w"), el.style.getPropertyValue("--h"), el.style.getPropertyValue("--scale")]).toEqual([w, h, scale]);
      expect(el.style.getPropertyValue("--glance-h")).toBe(h);
    }
  });

  it("resizes live: the input region grows before the pill, and shrinks after it", async () => {
    const { el, handle } = await start(withGeneral({ pillSize: "normal" }));
    win.regions.length = 0;
    handle.configure(withGeneral({ pillSize: "large" }));
    // Growing: the pill keeps its size until the region has grown.
    expect(el.style.getPropertyValue("--h")).toBe("32px");
    await settleAll();
    expect(el.style.getPropertyValue("--h")).toBe("44px");
    expect(win.regions.at(-1)).toMatchObject({ height: 44 });
    handle.configure(withGeneral({ pillSize: "low" }));
    expect(el.style.getPropertyValue("--h")).toBe("20px");
    expect(win.regions.at(-1)).toMatchObject({ height: 20 });
  });

  it("plays the startup animation at the chosen size", async () => {
    const stages: Stage[] = [];
    const greeting: Greeting = { id: "one", label: "one", play: (s) => void stages.push(s) };
    await start(withGeneral({ pillSize: "large", greeting: "one" }), greeting);
    expect(stages[0]).toMatchObject({ size: { width: 260, height: 44 }, scale: 1.375 });
  });

  it("opens below the folded pill, whatever its size", async () => {
    const { el } = await start(withGeneral({ pillSize: "low", greeting: "none" }));
    await settleAll();
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("true");
    expect(el.style.getPropertyValue("--h")).toBe("176px");
  });
});

describe("short and textless styles", () => {
  const strip = () => recording("strip", { widens: false, size: (p) => ({ width: p.width, height: 6 }) });

  it("aren't widened by a live activity when they say so", async () => {
    const s = strip();
    const media = {
      id: "media",
      label: "Media",
      description: "",
      icon: "",
      slots: ["glance"] as const,
      setup: () => ({ glance: () => ({ text: "Song", wide: true }) }),
    };
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    win = fakeWindow();
    const base = withGeneral({ style: "strip" });
    await mount(el, [media as never], {}, win.port, { ...base, layout: { glance: { left: [], right: ["media"] }, tabs: [] } }, { styles: [s.style] });
    await settleAll();
    expect(el.dataset.wide).toBe("true");
    expect(el.style.getPropertyValue("--w")).toBe("200px");
  });

  it("open to the same panel as the pill, below a row as tall as the pill", async () => {
    const s = strip();
    const { el } = await startWith(withGeneral({ style: "strip", greeting: "none" }), [], [s.style]);
    expect(el.style.getPropertyValue("--h")).toBe("6px");
    expect(el.style.getPropertyValue("--glance-open-h")).toBe("32px");
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.style.getPropertyValue("--h")).toBe(`${32 + 156}px`);
  });
});

describe("a tab that asks for a taller panel", () => {
  const tab = (id: string, panelHeight?: number) => ({
    id,
    label: id,
    description: "",
    icon: "",
    slots: ["tab"] as const,
    ...(panelHeight ? { panelHeight } : {}),
    setup: () => ({ panel: () => {} }),
  });

  it("opens the island to it while it's shown, in a window that always fits it", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    win = fakeWindow();
    const placed = { ...withGeneral({ greeting: "none" }), layout: { glance: { left: [], right: [] }, tabs: ["plain", "month"] } };
    await mount(el, [tab("plain"), tab("month", 300)] as never, {}, win.port, placed, { styles: [PILL.style] });
    await settleAll();
    // The window is sized for the tallest tab from the start: 32 + 300, plus the open slack.
    expect(win.canvases.at(-1)?.height).toBe(32 + 300 + 16);
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect([el.style.getPropertyValue("--h"), el.style.getPropertyValue("--panel-h")]).toEqual([`${32 + 156}px`, "156px"]);

    el.querySelector<HTMLButtonElement>("#tab-month")?.click();
    await settleAll();
    expect([el.style.getPropertyValue("--h"), el.style.getPropertyValue("--panel-h")]).toEqual([`${32 + 300}px`, "300px"]);
    expect(win.regions.at(-1)?.height).toBe(32 + 300 + 16);

    el.querySelector<HTMLButtonElement>("#tab-plain")?.click();
    await settleAll();
    expect(el.style.getPropertyValue("--h")).toBe(`${32 + 156}px`);
  });
});

describe("pill styles, live", () => {
  it("reads the style's options for its size and while drawing, as they change", async () => {
    const seen: unknown[] = [];
    const s = recording("opt", {
      options: { thick: { kind: "number", label: "Thickness", default: 4, min: 2, max: 12, step: 1 } },
      size: (p, o) => ({ width: p.width, height: (o as { thick: number }).thick }),
      mount: (_, ctx) => ({ draw: () => void seen.push(ctx.options()) }),
    });
    const base = withGeneral({ style: "opt" });
    const { el, handle } = await startWith(base, [], [s.style]);
    await settleAll();
    expect(el.style.getPropertyValue("--h")).toBe("4px");
    expect(seen.at(-1)).toEqual({ thick: 4 });
    handle.configure({ ...base, options: { opt: { thick: 9 } } });
    await settleAll();
    expect(el.style.getPropertyValue("--h")).toBe("9px");
    expect(seen.at(-1)).toEqual({ thick: 9 });
  });

  it("starts or stops hiding when a hidden style is picked or left", async () => {
    const a = controlled("one");
    const { handle } = await start(withGeneral({ style: "pill", greeting: "one" }), a.greeting);
    a.finish();
    await settleAll();
    handle.configure(withGeneral({ style: "hidden", greeting: "one" }));
    handle.configure(withGeneral({ style: "pill", greeting: "one" }));
    expect(win.rules).toEqual([
      [null, 760],
      [500, 760],
      [null, 760],
    ]);
  });

  it("pops the new style in once the island has started, not at startup", async () => {
    const a = recording("a");
    const b = recording("b");
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    const animate = vi.spyOn(Element.prototype, "animate").mockImplementation(() => ({ finished: Promise.resolve(), cancel() {} }) as unknown as Animation);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    win = fakeWindow();
    const handle = await mount(el, [], {}, win.port, withGeneral({ style: "a", greeting: "none" }), { styles: [a.style, b.style] });
    await settleAll();
    const glance = el.querySelector(".glance");
    expect(animate.mock.contexts.filter((c) => c === glance)).toHaveLength(0);
    handle.configure(withGeneral({ style: "b", greeting: "none" }));
    expect(animate.mock.contexts.filter((c) => c === glance)).toHaveLength(1);
  });

  it("gives each style a clean row: no class, style or element left by the last one", async () => {
    const messy = recording("messy", {
      mount: (root) => {
        root.classList.add("messy");
        root.style.padding = "0";
        root.append(document.createElement("b"));
        return { draw() {} };
      },
    });
    const b = recording("b");
    const { el, handle } = await startWith(withGeneral({ style: "messy" }), [], [messy.style, b.style]);
    handle.configure(withGeneral({ style: "b" }));
    const glance = el.querySelector<HTMLElement>(".glance")!;
    expect([glance.className, glance.getAttribute("style"), glance.querySelector("b")]).toEqual(["glance", null, null]);
  });

  it("carries on when a style's destroy throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = recording("bad", {
      mount: () => ({
        draw() {},
        destroy() {
          throw new Error("x");
        },
      }),
    });
    const b = recording("b");
    const { el, handle } = await startWith(withGeneral({ style: "bad" }), [], [bad.style, b.style]);
    handle.configure(withGeneral({ style: "b" }));
    expect(el.dataset.style).toBe("b");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`"bad": destroy failed`));
  });

  it("doesn't come back to a style set aside this session, even when picked again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = recording("a");
    let mounts = 0;
    const flaky = recording("flaky", {
      mount: () => {
        mounts++;
        throw new Error("boom");
      },
    });
    const { el, handle } = await startWith(withGeneral({ style: "flaky" }), [], [a.style, flaky.style]);
    handle.configure(withGeneral({ style: "a" }));
    handle.configure(withGeneral({ style: "flaky" }));
    expect([el.dataset.style, mounts]).toEqual(["a", 1]);
  });
});

describe("pill sizes and a hardware notch", () => {
  it("keeps the notch's height whatever the size, with room for glances beside it", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    win = fakeWindow();
    const port = { ...win.port, island: async () => ({ width: 185, height: 32, hasNotch: true }) };
    await mount(el, [], {}, port, withGeneral({ pillSize: "low" }), { styles: [PILL.style] });
    expect([el.style.getPropertyValue("--w"), el.style.getPropertyValue("--h"), el.style.getPropertyValue("--scale")]).toEqual(["313px", "32px", "1"]);
  });

  it("follows the width setting at the chosen size", async () => {
    const { el } = await start(withGeneral({ pillSize: "large", pillWidth: 300 }));
    expect(el.style.getPropertyValue("--w")).toBe("390px");
  });
});

describe("what plugins see of the island", () => {
  it("tells a plugin the style drawing the pill, its size, the theme and the tone, as they change", async () => {
    let host: Host<never> | undefined;
    const spy = { id: "spy", label: "Spy", description: "", icon: "", slots: ["glance"] as const, setup: (_: unknown, h: Host<never>) => ((host = h), {}) };
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    win = fakeWindow();
    const [a, b] = [recording("a"), recording("b")];
    const base = withGeneral({ style: "b", pillSize: "large", theme: "dracula", pillColor: "#282a36" });
    const placed = { ...base, layout: { glance: { left: [], right: ["spy"] }, tabs: [] } };
    const handle = await mount(el, [spy as never], {}, win.port, placed, { styles: [a.style, b.style] });
    expect(host?.appearance()).toEqual({ style: "b", size: "large", theme: "dracula", tone: "dark", notch: false });

    // A style that's gone gives the first one: the plugin is told what is actually drawn.
    handle.configure({ ...placed, general: { ...placed.general, style: "gone", pillSize: "low", theme: "one-light", pillColor: "#fafafa" } });
    expect(host?.appearance()).toEqual({ style: "a", size: "low", theme: "one-light", tone: "light", notch: false });
  });

  it("opens a plugin's own page in Settings, with what it asks", async () => {
    let host: Host<never> | undefined;
    const spy = { id: "spy", label: "Spy", description: "", icon: "", slots: ["glance"] as const, setup: (_: unknown, h: Host<never>) => ((host = h), {}) };
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    win = fakeWindow();
    const opened: (string | undefined)[] = [];
    const placed = { ...withGeneral({}), layout: { glance: { left: [], right: ["spy"] }, tabs: [] } };
    await mount(el, [spy as never], {}, win.port, placed, { styles: [PILL.style], openSettings: (t) => void opened.push(t) });
    host?.openPage({ calendar: "me@example.com", event: "e1" });
    host?.openPage();
    expect(opened).toEqual(["page:spy?calendar=me%40example.com&event=e1", "page:spy"]);
  });

  it("hands a plugin its own secrets, and no one else's", async () => {
    let host: Host<never> | undefined;
    const spy = {
      id: "spy",
      label: "Spy",
      description: "",
      icon: "",
      slots: ["glance"] as const,
      options: { token: secret("Token"), city: text("City") },
      setup: (_: unknown, h: Host<never>) => ((host = h), {}),
    };
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    win = fakeWindow();
    const placed = { ...withGeneral({}), layout: { glance: { left: [], right: ["spy"] }, tabs: [] } };
    const asked: string[] = [];
    const readSecret = async (id: string, key: string) => (asked.push(`${id}/${key}`), "s3cret");
    await mount(el, [spy as never], {}, win.port, placed, { readSecret });
    const h = host as unknown as Host<Record<string, string>>;
    expect(await h.secret("token")).toBe("s3cret");
    await expect(h.secret("city")).rejects.toThrow(`"city" isn't one of spy's secret options`);
    await expect(h.secret("weather/apiKey")).rejects.toThrow();
    expect(asked).toEqual(["spy/token"]);
  });
});
