/**
 * How the island loads plugins from the plugins folder. The rule that matters most: a file's code
 * never runs before the user turns it on.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { extensionLoader } = await import("./app");

const def = (id: string) => ({ id, label: id, description: "", icon: "", slots: ["tab"], setup: () => ({}) });

/** A plugins folder whose files each define a plugin with the file's name as id (or `ids[file]`). */
function folder(files: string[], ids: Record<string, string> = {}) {
  const list = vi.fn(async () => ({ dir: "/plugins", plugins: files.map((file) => ({ file, source: file, problem: null })) }));
  const importer = vi.fn(async (source: string) => ({ default: () => def(ids[source] ?? source.replace(/\W/g, "")) }));
  return { port: { list, openDir: async () => {} }, importer };
}

describe("extensionLoader", () => {
  it("never runs a file that isn't turned on", async () => {
    const { port, importer } = folder(["on.js", "off.js"]);
    const loaded = await extensionLoader(port, importer, vi.fn()).sync(["on.js"]);
    expect(importer.mock.calls.map(([source]) => source)).toEqual(["on.js"]);
    expect(loaded.map((e) => e.plugin?.id)).toEqual(["onjs"]);
  });

  it("doesn't even list the folder while nothing new is turned on", async () => {
    const { port, importer } = folder(["a.js"]);
    const loader = extensionLoader(port, importer, vi.fn());
    await loader.sync([]);
    await loader.sync(["a.js"]);
    await loader.sync(["a.js"]);
    expect(port.list).toHaveBeenCalledTimes(1);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("loads a file once even when settings change twice in a row", async () => {
    const { port, importer } = folder(["a.js"]);
    const loader = extensionLoader(port, importer, vi.fn());
    const [first, second] = await Promise.all([loader.sync(["a.js"]), loader.sync(["a.js"])]);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("refuses a plugin that takes a built-in feature's id", async () => {
    const log = vi.fn();
    const { port, importer } = folder(["fake-clock.js"], { "fake-clock.js": "clock" });
    const [ext] = await extensionLoader(port, importer, log).sync(["fake-clock.js"]);
    expect(ext?.plugin).toBeNull();
    expect(log).toHaveBeenCalledWith(`[island] plugin fake-clock.js: the id "clock" is already used`);
  });

  it("refuses an id already taken by a plugin loaded earlier", async () => {
    const { port, importer } = folder(["a.js", "b.js"], { "a.js": "same", "b.js": "same" });
    const loader = extensionLoader(port, importer, vi.fn());
    await loader.sync(["a.js"]);
    const all = await loader.sync(["a.js", "b.js"]);
    expect(all.map((e) => e.problem)).toEqual([null, `the id "same" is already used`]);
  });

  it("keeps looking for a file that is turned on but missing", async () => {
    const log = vi.fn();
    const { port, importer } = folder([]);
    const loader = extensionLoader(port, importer, log);
    expect(await loader.sync(["later.js"])).toEqual([]);
    expect(log).toHaveBeenCalledWith("[island] plugin later.js is turned on but not in the plugins folder");
    port.list.mockResolvedValueOnce({ dir: "/plugins", plugins: [{ file: "later.js", source: "later.js", problem: null }] });
    expect((await loader.sync(["later.js"])).map((e) => e.plugin?.id)).toEqual(["laterjs"]);
  });

  it("carries on when the folder can't be listed", async () => {
    const log = vi.fn();
    const { port, importer } = folder([]);
    port.list.mockRejectedValueOnce(new Error("denied"));
    expect(await extensionLoader(port, importer, log).sync(["a.js"])).toEqual([]);
    expect(log).toHaveBeenCalledWith("[island] can't list plugins: Error: denied");
  });
});
