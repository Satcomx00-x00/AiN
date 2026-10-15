import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { check, confine, fileRows, isolate, loadExtensions } = await import("./extensions");
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
    ["shortcut commands", { commands: [{ id: "go" }] }, "only available to built-in features"],
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
    };
    expect(typeof check({ ...valid(), options }, rules)).toBe("object");
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
      ["broken.js", "failed to load: SyntaxError: can't parse broken"],
      ["no-default.js", "must default-export a function that receives the island SDK"],
      ["throws.js", "failed to load: Error: boom"],
      ["ok.js", null],
    ]);
    expect(out[4]?.plugin?.id).toBe("pomodoro");
  });

  it("keeps the first of two plugins with the same id", async () => {
    const out = await loadExtensions([file("a.js", "a"), file("b.js", "b")], rules, modules({ a: { default: () => valid() }, b: { default: () => valid() } }));
    expect(out.map((e) => e.problem)).toEqual([null, `the id "pomodoro" is already used`]);
  });

  it("doesn't change the ids the caller reserved", async () => {
    const taken = new Set(["clock"]);
    await loadExtensions([file("a.js", "a")], { ...rules, taken }, modules({ a: { default: () => valid() } }));
    expect([...taken]).toEqual(["clock"]);
  });
});

describe("confine", () => {
  const host = { refresh() {}, options: () => ({}) as never, setOptions() {}, openSettings() {} };

  it("gives a plugin only the services it declared, frozen", () => {
    let got: Record<string, unknown> = {};
    const plugin = confine({ ...valid(), setup: (s: never) => ((got = s), {}) } as never, ["media"]);
    plugin.setup({ media: "M", stats: "S", clipboard: "secret" } as never, host);
    expect(got).toEqual({ media: "M" });
    expect(Object.isFrozen(got)).toBe(true);
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
  const loaded = new Map([["a.js", { file: "a.js", plugin, needs: ["media"], problem: null }]]);

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
    expect(fileRows([], ["a.js"], loaded)).toEqual([{ file: "a.js", on: true, plugin: null, needs: ["media"], problem: "No longer in the plugins folder" }]);
  });
});

describe("a plugin's settings panel", () => {
  it("must be a function when given", () => {
    expect(check({ ...valid(), settingsPanel: "nope" }, rules)).toBe("settingsPanel must be a function");
    expect(typeof check({ ...valid(), settingsPanel: () => {} }, rules)).toBe("object");
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
