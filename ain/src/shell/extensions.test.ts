import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { check, checkGreeting, checkNotifier, checkStyle, confine, confineGreeting, confineNotifier, confineStyle, fileRows, idOf, importSource, isolate, loadExtensions, storeFields } = await import("./extensions");
const { sdk } = await import("../sdk");

const rules = { taken: new Set(["clock", "media"]), services: ["media", "stats"] };

/** The smallest definition that passes every check. */
const valid = () => ({
  id: "pomodoro",
  label: "Pomodoro",
  description: "Work in 25 minute blocks.",
  icon: `<circle cx="8" cy="8" r="6"/>`,
  slots: ["tab"],
  setup: () => ({}),
});

describe("check", () => {
  it("accepts a minimal definition, needing nothing", () => {
    const out = check(valid(), rules);
    expect(typeof out === "string" ? out : out.needs).toEqual([]);
  });

  it("deduplicates the services a plugin needs", () => {
    const out = check({ ...valid(), needs: ["media", "media"] }, rules);
    expect(typeof out === "string" ? out : out.needs).toEqual(["media"]);
  });

  it.each([
    ["a non-object", null, "must return a plugin definition"],
    ["an uppercase id", { id: "Pomodoro" }, "id must be"],
    ["a one-letter id", { id: "p" }, "id must be"],
    ["an id starting with a digit", { id: "1pomo" }, "id must be"],
    ["a built-in's id", { id: "clock" }, `"clock" is already used`],
    ["an empty label", { label: "  " }, "label must be"],
    ["a 41-character label", { label: "x".repeat(41) }, "label must be"],
    ["a missing description", { description: undefined }, "description must be"],
    ["an icon that isn't markup", { icon: 3 }, "icon must be"],
    ["no slots", { slots: [] }, "slots must list"],
    ["an unknown slot", { slots: ["menu"] }, "slots must list"],
    ["no setup", { setup: "nope" }, "setup must be a function"],
    ["a command without a label", { commands: [{ id: "go" }] }, `command "go": label must be`],
    ["a command with its own window", { commands: [{ id: "go", label: "Go", description: "Goes.", shortcut: null, surface: "popup" }] }, `only have surface "action"`],
    ["a service it may not use", { needs: ["clipboard"] }, "unknown services: clipboard"],
    ["needs that aren't names", { needs: "media" }, "needs must list"],
    ["an option of unknown kind", { options: { x: { kind: "slider", label: "X", default: 1 } } }, `option "x" has an unknown kind`],
    ["an option without a label", { options: { x: { kind: "toggle", default: true } } }, `option "x" needs a label`],
    ["a default of the wrong type", { options: { x: { kind: "toggle", label: "X", default: "yes" } } }, "doesn't fit its kind"],
    ["a number option without bounds", { options: { x: { kind: "number", label: "X", default: 1 } } }, "needs a min, max and step"],
    [
      "a choice whose default isn't a choice",
      { options: { x: { kind: "choice", label: "X", default: "c", choices: [{ value: "a", label: "A" }] } } },
      "choices that include its default",
    ],
  ])("refuses %s", (_, patch, problem) => {
    const def = patch === null ? null : { ...valid(), ...patch };
    expect(check(def, rules)).toContain(problem);
  });

  it("accepts every option kind the settings page can draw", () => {
    const options = {
      on: sdk.options.toggle("On", true),
      n: sdk.options.number("N", 5, { min: 0, max: 10 }),
      c: sdk.options.choice("C", "a", [["a", "A"]]),
      l: sdk.options.list("L", ["x"]),
      f: sdk.options.folder("F"),
      t: sdk.options.text("T"),
      m: sdk.options.text("M", "", { multiline: true, required: true, pattern: "[a-z]+", maxLength: 20 }),
      s: sdk.options.secret("S", { required: true }),
      k: sdk.options.color("K", "#FF8800"),
      p: sdk.options.number("Port", 8080, { min: 1, max: 65535, box: true }),
    };
    expect(typeof check({ ...valid(), options }, rules)).toBe("object");
  });

  it.each([
    ["a pattern that doesn't compile", { t: sdk.options.text("T", "", { pattern: "(" }) }, "isn't a valid regular expression"],
    ["a maxLength of 0", { t: { kind: "text", label: "T", default: "", maxLength: 0 } }, "maxLength above 0"],
    ["a secret with a default", { s: { kind: "secret", label: "S", default: "hunter2" } }, "default that doesn't fit"],
    ["a secret whose key can't name a credential", { "a b": sdk.options.secret("S") }, "letters, digits, _ or -"],
    ["a color that isn't #rrggbb", { k: { kind: "color", label: "K", default: "red" } }, "default that doesn't fit"],
    ["a required that isn't true or false", { t: { kind: "text", label: "T", default: "", required: "yes" } }, "required that isn't true or false"],
    ["something other than an object of fields", "fields", "options must be an object of fields"],
  ])("refuses options with %s", (_, options, problem) => {
    expect(check({ ...valid(), options }, rules)).toContain(problem);
  });
});

describe("storeFields", () => {
  it("reads the options a store entry declares, with what the SDK's builders would fill in", () => {
    const fields = storeFields({
      city: { kind: "text", label: "City", default: "Paris", required: true },
      apiKey: { kind: "secret", label: "API key" },
      refresh: { kind: "number", label: "Every", default: 10, min: 5, max: 60 },
      tint: { kind: "color", label: "Tint", default: "#FF8800" },
    });
    expect(fields).toMatchObject({
      city: { kind: "text", required: true },
      apiKey: { kind: "secret", default: "" },
      refresh: { kind: "number", step: 1 },
      tint: { default: "#ff8800" },
    });
  });

  it("says why options can't be drawn, and gives none when there are none", () => {
    expect(storeFields({ units: { kind: "choice", label: "Units", default: "metric", choices: [] } })).toContain("choices that include its default");
    expect(storeFields(["a"])).toBe("options must be an object of fields");
    expect(storeFields({ city: "Paris" })).toBe(`option "city" needs a label`);
    expect(storeFields(null)).toBeNull();
  });
});

/** An importer over fake modules, keyed by source text. */
const modules = (bySource: Record<string, unknown>) => async (source: string) => {
  if (!(source in bySource)) throw new SyntaxError(`can't parse ${source}`);
  return bySource[source];
};
const file = (name: string, source: string | null, problem: string | null = null) => ({ file: name, source, problem });

describe("loadExtensions", () => {
  it("hands the SDK to each plugin's factory", async () => {
    const factory = vi.fn(() => valid());
    await loadExtensions([file("a.js", "a")], rules, modules({ a: { default: factory } }));
    expect(factory).toHaveBeenCalledWith(sdk);
  });

  it("reports why each unusable file was refused, and keeps going", async () => {
    const found = [
      file("unreadable.js", null, "larger than 1024 KB"),
      file("vanished.js", null),
      file("text.js", "text"),
      file("bad-greeting.js", "badgreeting"),
      file("broken.js", "broken"),
      file("no-default.js", "nodefault"),
      file("throws.js", "throws"),
      file("ok.js", "ok"),
    ];
    const out = await loadExtensions(
      found,
      rules,
      modules({
        nodefault: { notDefault: () => valid() },
        text: "export default 1",
        badgreeting: { default: () => ({ id: "wave", label: "Wave", play: "later" }) },
        throws: {
          default: () => {
            throw new Error("boom");
          },
        },
        ok: { default: () => valid() },
      }),
    );
    expect(out.map((e) => [e.file, e.problem])).toEqual([
      ["unreadable.js", "larger than 1024 KB"],
      ["vanished.js", "couldn't be read"],
      ["text.js", "must default-export a function that receives the island SDK"],
      ["bad-greeting.js", "play must be a function"],
      ["broken.js", "failed to load: SyntaxError: can't parse broken"],
      ["no-default.js", "must default-export a function that receives the island SDK"],
      ["throws.js", "failed to load: Error: boom"],
      ["ok.js", null],
    ]);
    expect(out.at(-1)?.plugin?.id).toBe("pomodoro");
    expect(out.slice(0, -1).map(idOf)).toEqual(Array(out.length - 1).fill(null));
  });

  it("takes the default export of a module that is itself a function", async () => {
    const factory = Object.assign(() => ({}), { default: () => valid() });
    const out = await loadExtensions([file("fn.js", "fn")], rules, modules({ fn: factory }));
    expect(out[0]).toMatchObject({ problem: null, plugin: { id: "pomodoro" } });
  });

  it("keeps the first of two plugins with the same id", async () => {
    const out = await loadExtensions([file("a.js", "a"), file("b.js", "b")], rules, modules({ a: { default: () => valid() }, b: { default: () => valid() } }));
    expect(out.map((e) => e.problem)).toEqual([null, `the id "pomodoro" is already used`]);
  });

  it("takes a definition with play and no setup as a startup animation", async () => {
    const play = vi.fn();
    const out = await loadExtensions([file("w.js", "w")], rules, modules({ w: { default: (api: typeof sdk) => api.defineGreeting({ id: "wave", label: "Wave", play }) } }));
    expect(out[0]).toMatchObject({ file: "w.js", plugin: null, needs: [], problem: null, greeting: { id: "wave", label: "Wave" } });
    expect(idOf(out[0]!)).toBe("wave");
    const stage = {} as never;
    await out[0]!.greeting!.play(stage);
    expect(play).toHaveBeenCalledWith(stage);
  });

  it("shares ids between plugins and startup animations", async () => {
    const out = await loadExtensions(
      [file("a.js", "a"), file("b.js", "b")],
      rules,
      modules({ a: { default: () => ({ id: "pomodoro", label: "P", play() {} }) }, b: { default: () => valid() } }),
    );
    expect(out.map((e) => e.problem)).toEqual([null, `the id "pomodoro" is already used`]);
  });

  it("takes a definition with mount and no setup as a pill style", async () => {
    const draw = vi.fn();
    const out = await loadExtensions(
      [file("s.js", "s")],
      rules,
      modules({ s: { default: (api: typeof sdk) => api.defineStyle({ id: "neon", label: "Neon", hidden: true, mount: () => ({ draw }) }) } }),
    );
    expect(out[0]).toMatchObject({ file: "s.js", plugin: null, greeting: null, needs: [], problem: null, style: { id: "neon", label: "Neon", hidden: true } });
    expect(idOf(out[0]!)).toBe("neon");
    out[0]!.style!.mount({} as HTMLElement, { options: () => ({}) }).draw({} as never);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("shares ids between plugins and pill styles", async () => {
    const out = await loadExtensions(
      [file("a.js", "a"), file("b.js", "b")],
      rules,
      modules({ a: { default: () => ({ id: "pomodoro", label: "P", mount: () => ({ draw() {} }) }) }, b: { default: () => valid() } }),
    );
    expect(out.map((e) => e.problem)).toEqual([null, `the id "pomodoro" is already used`]);
  });

  it("checks a definition with both play and setup as a plugin", async () => {
    const out = await loadExtensions([file("a.js", "a")], rules, modules({ a: { default: () => ({ ...valid(), play() {} }) } }));
    expect(out[0]).toMatchObject({ greeting: null, plugin: { id: "pomodoro" } });
  });

  it("doesn't change the ids the caller reserved", async () => {
    const taken = new Set(["clock"]);
    await loadExtensions([file("a.js", "a")], { ...rules, taken }, modules({ a: { default: () => valid() } }));
    expect([...taken]).toEqual(["clock"]);
  });
});

describe("confine", () => {
  const host = { refresh() {}, options: () => ({}) as never, setOptions() {}, secret: async () => "", openSettings() {}, openPage() {}, appearance: () => ({ style: "pill", size: "normal", theme: "island", tone: "dark", notch: false }) as const, notify: () => ({ id: "", update() {}, dismiss() {} }), on: () => () => {} };

  it("gives a plugin only the services it declared, frozen", () => {
    let got: Record<string, unknown> = {};
    const plugin = confine({ ...valid(), setup: (s: never) => ((got = s), {}) } as never, ["media"]);
    plugin.setup({ media: "M", stats: "S", clipboard: "secret" } as never, host);
    expect(got).toEqual({ media: "M" });
    expect(Object.isFrozen(got)).toBe(true);
  });

  it("binds a per-plugin service to the plugin's id, in its settings panel too", async () => {
    const { perPlugin } = await import("./extensions");
    let got: Record<string, unknown> = {};
    const accounts = perPlugin((id) => ({ owner: id }));
    const plugin = confine({ ...valid(), setup: (s: never) => ((got = s), {}), settingsPanel: (_: HTMLElement, s: never) => void (got = s) } as never, ["oauth"]);
    plugin.setup({ oauth: accounts, media: "M" } as never, host);
    expect(got).toEqual({ oauth: { owner: "pomodoro" } });
    got = {};
    plugin.settingsPanel?.({} as never, { oauth: accounts } as never, {} as never);
    expect(got).toEqual({ oauth: { owner: "pomodoro" } });
  });

  it("survives a setup that throws or returns nothing usable", () => {
    const log = vi.fn();
    const throws = confine({ ...valid(), setup: () => { throw new Error("x"); } } as never, [], log);
    expect(throws.setup({} as never, host)).toEqual({});
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`plugin "pomodoro": setup failed`));
    expect(confine({ ...valid(), setup: () => 42 } as never, [], log).setup({} as never, host)).toEqual({});
  });
});

describe("isolate", () => {
  it("switches a failing part off after reporting it once", () => {
    const report = vi.fn();
    const glance = vi.fn(() => {
      throw new Error("bad");
    });
    const widget = isolate({ glance }, report);
    expect(widget.glance?.(0)).toBeNull();
    expect(widget.glance?.(1)).toBeNull();
    expect(glance).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("catches async ticks that reject", async () => {
    const report = vi.fn();
    const tick = vi.fn(async () => {
      throw new Error("late");
    });
    const widget = isolate({ tick }, report);
    await widget.tick?.({ now: 0, visible: true });
    await widget.tick?.({ now: 1, visible: true });
    expect(tick).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("tick", expect.any(Error));
  });

  it("passes values through while nothing fails, and adds no parts", () => {
    const widget = isolate({ glance: () => ({ text: "hi" }), ambient: () => "#fff" }, vi.fn());
    expect(widget.glance?.(0)).toEqual({ text: "hi" });
    expect(widget.ambient?.()).toBe("#fff");
    expect(Object.keys(widget).sort()).toEqual(["ambient", "glance"]);
  });
});

describe("fileRows", () => {
  const plugin = { ...valid() } as never;
  const greeting = { id: "wave", label: "Wave", play: () => {} };
  const style = { id: "neon", label: "Neon", mount: () => ({ draw() {} }) };
  const loaded = new Map([
    ["a.js", { file: "a.js", plugin, greeting: null, style: null, notifier: null, needs: ["media"], problem: null }],
    ["w.js", { file: "w.js", plugin: null, greeting, style: null, notifier: null, needs: [], problem: null }],
    ["s.js", { file: "s.js", plugin: null, greeting: null, style, notifier: null, needs: [], problem: null }],
  ]);

  it("lists files by name, with details only for those turned on", () => {
    const rows = fileRows([{ file: "b.js" }, { file: "a.js" }], ["a.js"], loaded);
    expect(rows.map((r) => [r.file, r.on, r.plugin !== null, r.needs])).toEqual([
      ["a.js", true, true, ["media"]],
      ["b.js", false, false, []],
    ]);
  });

  it("shows nothing from a plugin that was turned off", () => {
    expect(fileRows([{ file: "a.js" }], [], loaded)[0]).toMatchObject({ on: false, plugin: null, needs: [], problem: null });
  });

  it("keeps a file that is on but gone, saying so", () => {
    expect(fileRows([], ["a.js"], loaded)).toEqual([{ file: "a.js", on: true, plugin: null, greeting: null, style: null, notifier: null, needs: ["media"], problem: "No longer in the plugins folder" }]);
  });

  it("shows a startup animation's file like a plugin's, only while on and present", () => {
    expect(fileRows([{ file: "w.js" }], ["w.js"], loaded)[0]).toMatchObject({ plugin: null, greeting, problem: null });
    expect(fileRows([{ file: "w.js" }], [], loaded)[0]?.greeting).toBeNull();
    expect(fileRows([], ["w.js"], loaded)[0]?.greeting).toBeNull();
  });

  it("shows a pill style's file the same way", () => {
    expect(fileRows([{ file: "s.js" }], ["s.js"], loaded)[0]).toMatchObject({ plugin: null, greeting: null, style, problem: null });
    expect(fileRows([{ file: "s.js" }], [], loaded)[0]?.style).toBeNull();
  });
});

describe("checkGreeting", () => {
  const ok = () => ({ id: "wave", label: "Wave", play: () => {} });

  it("keeps only what the island uses", () => {
    expect(Object.keys(checkGreeting({ ...ok(), extra: 1 }, new Set()) as object).sort()).toEqual(["id", "label", "play"]);
  });

  it.each([
    ["a bad id", { id: "Wave" }, "id must be"],
    ["a taken id", { id: "hello" }, `"hello" is already used`],
    ["no label", { label: "" }, "label must be"],
    ["a 41-character label", { label: "x".repeat(41) }, "label must be"],
    ["a play that isn't a function", { play: "wave" }, "play must be a function"],
  ])("refuses %s", (_, patch, problem) => {
    expect(checkGreeting({ ...ok(), ...patch }, new Set(["hello"]))).toContain(problem);
  });

  it("is refused under a built-in animation's id by the island's rules", async () => {
    const { extensionRules } = await import("../features");
    for (const id of ["hello", "boing", "sparkle", "typewriter"]) expect(extensionRules.taken.has(id)).toBe(true);
  });
});

describe("confineGreeting", () => {
  it("reports a failing animation instead of throwing, sync or async", async () => {
    const log = vi.fn();
    const sync = confineGreeting({ id: "a", label: "A", play: () => { throw new Error("boom"); } }, log);
    const async = confineGreeting({ id: "b", label: "B", play: () => Promise.reject(new Error("bang")) }, log);
    await expect(sync.play({} as never)).resolves.toBeUndefined();
    await expect(async.play({} as never)).resolves.toBeUndefined();
    expect(log.mock.calls.map(([m]) => m)).toEqual([expect.stringContaining(`"a" failed: Error: boom`), expect.stringContaining(`"b" failed: Error: bang`)]);
  });

  it("waits for the animation it wraps", async () => {
    let finish: () => void = () => {};
    const wrapped = confineGreeting({ id: "a", label: "A", play: () => new Promise<void>((r) => (finish = r)) }, vi.fn());
    let over = false;
    const done = Promise.resolve(wrapped.play({} as never)).then(() => (over = true));
    await Promise.resolve();
    expect(over).toBe(false);
    finish();
    await done;
    expect(over).toBe(true);
  });
});

describe("a plugin's settings panel", () => {
  it("must be a function when given", () => {
    expect(check({ ...valid(), settingsPanel: "nope" }, rules)).toBe("settingsPanel must be a function");
    expect(typeof check({ ...valid(), settingsPanel: () => {} }, rules)).toBe("object");
  });
});

describe("a plugin's page", () => {
  it("must be a function when given", () => {
    expect(check({ ...valid(), page: "nope" }, rules)).toBe("page must be a function");
    expect(typeof check({ ...valid(), page: () => {} }, rules)).toBe("object");
  });
});

describe("a plugin's panel height", () => {
  it("must be a height in pixels when given", () => {
    for (const panelHeight of ["300", 0, -5, Number.POSITIVE_INFINITY]) expect(check({ ...valid(), panelHeight }, rules)).toBe("panelHeight must be a height in pixels");
    expect(typeof check({ ...valid(), panelHeight: 320 }, rules)).toBe("object");
  });

  it("gets only the services the plugin declared, like its setup", () => {
    let got: Record<string, unknown> = {};
    const plugin = confine({ ...valid(), settingsPanel: (_: HTMLElement, s: never) => void (got = s) } as never, ["media"]);
    plugin.settingsPanel?.({} as HTMLElement, { media: "M", clipboard: "secret" } as never, {} as never);
    expect(got).toEqual({ media: "M" });
  });

  it("can't break the Settings page, nor its cleanup", () => {
    const log = vi.fn();
    const throws = confine({ ...valid(), settingsPanel: () => { throw new Error("x"); } } as never, [], log);
    expect(throws.settingsPanel?.({} as HTMLElement, {} as never, {} as never)).toBeUndefined();
    const badStop = confine({ ...valid(), settingsPanel: () => () => { throw new Error("y"); } } as never, [], log);
    const stop = badStop.settingsPanel?.({} as HTMLElement, {} as never, {} as never);
    expect(() => (stop as () => void)()).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("stays absent for a plugin without one", () => expect("settingsPanel" in confine(valid() as never, [])).toBe(false));
});

describe("checkStyle", () => {
  const ok = () => ({ id: "neon", label: "Neon", mount: () => ({ draw() {} }) });

  it("keeps only what the island uses", () => {
    expect(Object.keys(checkStyle({ ...ok(), extra: 1 }, new Set()) as object).sort()).toEqual(["id", "label", "mount"]);
    const full = { ...ok(), hidden: true, size: () => ({ width: 1, height: 1 }), options: { glow: { kind: "toggle", label: "Glow", default: true } } };
    expect(Object.keys(checkStyle(full, new Set()) as object).sort()).toEqual(["hidden", "id", "label", "mount", "options", "size"]);
  });

  it.each([
    ["a bad id", { id: "Neon" }, "id must be"],
    ["a taken id", { id: "pill" }, `"pill" is already used`],
    ["no label", { label: " " }, "label must be"],
    ["a mount that isn't a function", { mount: {} }, "mount must be a function"],
    ["a size that isn't a function", { size: { width: 4 } }, "size must be a function"],
    ["hidden that isn't a boolean", { hidden: "yes" }, "hidden must be true or false"],
    ["widens that isn't a boolean", { widens: 0 }, "widens must be true or false"],
    ["a description that isn't a string", { description: 3 }, "description must be a string"],
    ["a malformed option", { options: { glow: { kind: "toggle", label: "Glow", default: "on" } } }, `option "glow" has a default`],
  ])("refuses %s", (_, patch, problem) => {
    expect(checkStyle({ ...ok(), ...patch }, new Set(["pill"]))).toContain(problem);
  });

  it("is refused under a built-in style's id by the island's rules", async () => {
    const { extensionRules } = await import("../features");
    for (const id of ["pill", "solo", "stub", "sliver", "hidden"]) expect(extensionRules.taken.has(id)).toBe(true);
  });
});

describe("confineStyle", () => {
  const pill = { width: 200, height: 32, hasNotch: false, scale: 1 };

  it("gives the plain pill when size throws, and says why", () => {
    const log = vi.fn();
    const style = confineStyle({ id: "a", label: "A", size: () => { throw new Error("boom"); }, mount: () => ({ draw() {} }) }, log);
    expect(style.size?.(pill, {})).toEqual({ width: 200, height: 32 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`"a": size failed: Error: boom`));
  });

  it("refuses a mount that returns no view, so the island can set the style aside", () => {
    const style = confineStyle({ id: "a", label: "A", mount: () => 42 as never }, vi.fn());
    expect(() => style.mount({} as HTMLElement, { options: () => ({}) })).toThrow("mount must return a view");
  });

  it("passes size and view through while nothing fails", () => {
    const view = { draw() {} };
    const style = confineStyle({ id: "a", label: "A", size: (p) => ({ width: p.width / 2, height: 6 }), mount: () => view }, vi.fn());
    expect(style.size?.(pill, {})).toEqual({ width: 100, height: 6 });
    expect(style.mount({} as HTMLElement, { options: () => ({}) })).toBe(view);
  });
});

describe("importSource", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Serves each object URL as a data URL of `source`, recording the blobs made and the URLs revoked. */
  function objectUrls(source: string) {
    const blobs: Blob[] = [];
    const url = `data:text/javascript,${encodeURIComponent(source)}`;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => (blobs.push(blob as Blob), url));
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    return { blobs, url, revoke };
  }

  it("loads a module from its source text as JavaScript, then frees its URL", async () => {
    const source = "export default (api) => api.version;";
    const { blobs, url, revoke } = objectUrls(source);
    const module = (await importSource(source)) as { default: (api: { version: string }) => string };
    expect(module.default({ version: "1" })).toBe("1");
    expect([blobs.length, blobs[0]?.type, await blobs[0]?.text()]).toEqual([1, "text/javascript", source]);
    expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("frees the URL of a module that doesn't load too", async () => {
    const { url, revoke } = objectUrls("export default (;");
    await expect(importSource("export default (;")).rejects.toThrow();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
  });
});

describe("shortcut commands from the plugins folder", () => {
  const command = (patch: Record<string, unknown> = {}) => ({ id: "go", label: "Go", description: "Goes.", shortcut: "Ctrl+Alt+KeyG", ...patch });

  it("are accepted with no window of their own: their widget's onCommand hears them", () => {
    const out = check({ ...valid(), commands: [command(), command({ id: "stop", shortcut: null, surface: "action" })] }, rules);
    expect(typeof out === "string" ? out : out.plugin.commands?.map((c) => [c.id, c.surface])).toEqual([
      ["go", "action"],
      ["stop", "action"],
    ]);
    const none = check({ ...valid(), commands: [] }, rules);
    expect(typeof none === "string" ? none : none.plugin.commands).toEqual([]);
  });

  it.each([
    ["not a list", "go", "at most 8 commands"],
    ["more than 8", Array.from({ length: 9 }, (_, i) => command({ id: `c${i}` })), "at most 8 commands"],
    ["not an object", [3], "must be an object"],
    ["a bad id", [command({ id: "Go" })], "its own id"],
    ["a repeated id", [command(), command()], "its own id"],
    ["a 41-character label", [command({ label: "x".repeat(41) })], "label must be"],
    ["a label that isn't text", [command({ label: 3 })], "label must be"],
    ["no description", [command({ description: undefined })], "description must be"],
    ["a shortcut that isn't text", [command({ shortcut: 3 })], "shortcut must look like"],
    ["a shortcut that isn't keys", [command({ shortcut: "Ctrl+" })], "shortcut must look like"],
    ["a popup", [command({ popup: () => ({}) })], "popups are only available"],
  ])("are refused with %s", (_, commands, problem) => {
    expect(check({ ...valid(), commands }, rules)).toContain(problem);
  });
});

describe("notifiers", () => {
  const def = (patch: Record<string, unknown> = {}) => ({ id: "ticker", label: "Ticker", show: () => {}, ...patch });

  it("are checked like the rest", () => {
    expect(checkNotifier(def({ description: "A line." }), new Set())).toMatchObject({ id: "ticker", description: "A line." });
    expect(checkNotifier(def(), new Set())).not.toHaveProperty("description");
    expect(checkNotifier(def({ id: "T" }), new Set())).toContain("id must be");
    expect(checkNotifier(def(), new Set(["ticker"]))).toContain("already used");
    expect(checkNotifier(def({ id: "toast" }), new Set())).toContain("built-in way");
    expect(checkNotifier(def({ label: " " }), new Set())).toContain("label must be");
    expect(checkNotifier(def({ label: 3 }), new Set())).toContain("label must be");
    expect(checkNotifier(def({ description: 3 }), new Set())).toContain("description must be");
    expect(checkNotifier(def({ show: "x" }), new Set())).toContain("show must be a function");
  });

  it("run confined: a failure is logged and that notification doesn't show", () => {
    const log = vi.fn();
    const stage = {} as HTMLElement;
    const n = {} as never;
    const ctx = { dismiss: vi.fn(), act: vi.fn() };
    const cleanup = vi.fn(() => {
      throw new Error("cleanup");
    });
    const ok = confineNotifier(def({ show: () => cleanup }) as never, log);
    const stop = ok.show(stage, n, ctx);
    expect(typeof stop).toBe("function");
    (stop as () => void)();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`notifier "ticker" cleanup failed`));
    expect(confineNotifier(def() as never, log).show(stage, n, ctx)).toBeUndefined();
    const broken = confineNotifier(def({ show: () => { throw new Error("boom"); } }) as never, log);
    expect(broken.show(stage, n, ctx)).toBeUndefined();
    expect(log).toHaveBeenLastCalledWith(`[island] notifier "ticker" failed: Error: boom`);
    expect(confineNotifier(def() as never).id).toBe("ticker");
  });

  it("load from files, taking their id", async () => {
    const out = await loadExtensions(
      [file("ticker.js", "ticker"), file("again.js", "again")],
      rules,
      modules({ ticker: { default: () => def() }, again: { default: () => def() } }),
    );
    expect(out.map(idOf)).toEqual(["ticker", null]);
    expect(out[1]?.problem).toContain("already used");
  });
});

describe("hooks and events, isolated", () => {
  it("switch off a notification hook on its first failure, letting notifications through", () => {
    const report = vi.fn();
    const n = { id: "n1" } as never;
    const hook = vi.fn(() => {
      throw new Error("x");
    });
    const w = isolate({ onNotification: hook, onNotificationAction: () => { throw new Error("y"); }, onCommand: () => { throw new Error("z"); } }, report);
    expect(w.onNotification?.(n)).toBe(n);
    expect(w.onNotification?.(n)).toBe(n);
    expect(hook).toHaveBeenCalledOnce();
    w.onNotificationAction?.("n1", "a");
    w.onCommand?.("go", "press");
    expect(report.mock.calls.map(([what]) => what)).toEqual(["onNotification", "onNotificationAction", "onCommand"]);
    expect(isolate({ onNotification: () => "silent" }, report).onNotification?.(n)).toBe("silent");
  });

  it("see every notification only with needs: notifications", () => {
    const onNotification = () => null;
    const setup = () => ({ onNotification, tick: () => {} });
    const without = confine({ ...valid(), setup } as never, []).setup({} as never, {} as never);
    const granted = confine({ ...valid(), setup } as never, ["notifications"]).setup({} as never, {} as never);
    expect([without.onNotification, typeof granted.onNotification]).toEqual([undefined, "function"]);
    expect(confine({ ...valid(), setup: () => 3 } as never, []).setup({} as never, {} as never)).toEqual({});
  });
});
