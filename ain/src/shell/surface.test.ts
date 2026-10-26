// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyPlugin, Command } from "../sdk/plugin";
import type { PopupPort } from "./commands";

const { hostCommands } = await import("./surface");
const { memorySettings, defaults } = await import("./settings");

beforeEach(() => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  document.body.replaceChildren();
  document.title = "";
  history.replaceState(null, "", "/");
});
afterEach(() => vi.restoreAllMocks());

const LAYOUT = { glance: { left: [], right: [] }, tabs: [] };

/** A plugin with one command whose view records how it was built and shown. */
function withCommand(id: string, command: Partial<Record<keyof Command, unknown>> = {}) {
  const built: unknown[] = [];
  const shown = vi.fn();
  const plugin = {
    id,
    label: id,
    description: "",
    icon: "",
    slots: ["tab"],
    options: { loud: { kind: "toggle", label: "Loud", default: false } },
    setup: () => ({}),
    commands: [
      {
        id: "go",
        label: `${id} go`,
        description: "",
        shortcut: null,
        popup: (root: HTMLElement, ctx: unknown) => {
          built.push(ctx);
          root.textContent = `${id} view`;
          return { show: shown };
        },
        ...command,
      },
    ],
  } as unknown as AnyPlugin;
  return { plugin, built, shown };
}

/** A popup window that shows commands on cue and records being hidden. */
function popupPort() {
  let show: (id: string) => void = () => {};
  const port: PopupPort & { hidden: number } = {
    hidden: 0,
    bind: async () => ({}),
    watchFailures: async () => () => {},
    open: async () => {},
    hide: async () => void port.hidden++,
    paste: async () => {},
    onShow: async (onShow) => ((show = onShow), () => {}),
  };
  return { port, show: (id: string) => show(id) };
}

async function host(...plugins: AnyPlugin[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const popup = popupPort();
  const store = memorySettings();
  hostCommands({ container, catalogue: plugins, layout: LAYOUT, services: { svc: true }, popup: popup.port, store });
  await Promise.resolve();
  return { container, popup, store };
}

describe("the popup and overlay windows", () => {
  it("show the command asked for, titled after it, and build its view only once", async () => {
    const a = withCommand("a");
    const { container, popup } = await host(a.plugin);
    popup.show("a.go");
    popup.show("a.go");
    expect(container.textContent).toBe("a view");
    expect(document.title).toBe("a go");
    expect(a.built).toHaveLength(1);
    expect(a.shown).toHaveBeenCalledTimes(2);
  });

  it("switch between commands, keeping each one's view", async () => {
    const a = withCommand("a");
    const b = withCommand("b");
    const { container, popup } = await host(a.plugin, b.plugin);
    popup.show("a.go");
    const first = container.firstChild;
    popup.show("b.go");
    popup.show("a.go");
    expect(container.firstChild).toBe(first);
    expect([a.built.length, b.built.length]).toEqual([1, 1]);
  });

  it("give a command its services and its plugin's options, as currently stored", async () => {
    const a = withCommand("a");
    const { popup, store } = await host(a.plugin);
    await store.save({ ...defaults(LAYOUT), options: { a: { loud: true } } });
    popup.show("a.go");
    const ctx = a.built[0] as { services: unknown; options: () => unknown };
    expect(ctx.services).toEqual({ svc: true });
    expect(ctx.options()).toEqual({ loud: true });
  });

  it("let a view list every command with its shortcut, and run one after hiding", async () => {
    const a = withCommand("a", { shortcut: "Ctrl+KeyA" });
    const b = withCommand("b", { surface: "screen" });
    const { popup, store } = await host(a.plugin, b.plugin);
    await store.save({ ...defaults(LAYOUT), shortcuts: { "a.go": "Alt+KeyA" } });
    const opened: string[] = [];
    popup.port.open = async (id, surface) => void opened.push(`${id} ${surface} after ${popup.port.hidden} hide`);
    popup.show("a.go");
    const ctx = a.built[0] as { commands: () => unknown[]; run: (id: string) => Promise<void> };
    expect(ctx.commands()).toEqual([
      { id: "a.go", label: "a go", description: "", icon: "", shortcut: "Alt+KeyA" },
      { id: "b.go", label: "b go", description: "", icon: "", shortcut: null },
    ]);
    await ctx.run("b.go");
    await ctx.run("nobody.here");
    expect(opened).toEqual(["b.go screen after 1 hide"]);
  });

  it("let a view open Settings or quit the app", async () => {
    const a = withCommand("a");
    const { popup, store } = await host(a.plugin);
    const open = vi.spyOn(store, "open");
    const quit = vi.spyOn(store, "quit");
    popup.show("a.go");
    const ctx = a.built[0] as { openSettings: (target?: string) => Promise<void>; quit: () => Promise<void> };
    await ctx.openSettings("zones");
    await ctx.quit();
    expect([open.mock.calls, quit.mock.calls.length]).toEqual([[["zones"]], 1]);
  });

  it("hide for a command they don't know, or one without a view", async () => {
    const quiet = withCommand("q", { popup: undefined });
    const { popup } = await host(quiet.plugin);
    popup.show("nobody.here");
    popup.show("q.go");
    expect(popup.port.hidden).toBe(2);
  });

  it("hide on Esc, unless the view used it, and when they lose focus", async () => {
    const { popup } = await host(withCommand("a").plugin);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    const used = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    used.preventDefault();
    document.dispatchEvent(used);
    window.dispatchEvent(new Event("blur"));
    expect(popup.port.hidden).toBe(2);
  });

  it("let a command's view close the window or paste, and give options to a plugin that has none", async () => {
    const a = withCommand("a");
    const bare = { ...a.plugin, options: undefined } as unknown as AnyPlugin;
    const { popup } = await host(bare);
    const pasted = vi.spyOn(popup.port, "paste");
    popup.show("a.go");
    const ctx = a.built[0] as { close: () => void; paste: () => Promise<void>; options: () => unknown };
    expect(ctx.options()).toEqual({});
    ctx.close();
    await ctx.paste();
    expect([popup.port.hidden, pasted.mock.calls.length]).toEqual([1, 1]);
  });

  it("ease the view in when motion is allowed", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    const animate = vi.spyOn(Element.prototype, "animate").mockImplementation(() => ({}) as Animation);
    const { container, popup } = await host(withCommand("a").plugin);
    popup.show("a.go");
    expect(animate).toHaveBeenCalledOnce();
    expect(animate.mock.contexts[0]).toBe(container);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 200 });
  });

  it("show the command in the address on their first appearance", async () => {
    const a = withCommand("a");
    history.replaceState(null, "", "/popup.html#a.go");
    const { container } = await host(a.plugin);
    expect(container.textContent).toBe("a view");
  });
});
