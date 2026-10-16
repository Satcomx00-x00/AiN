// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Output, Source, VolumePort } from "./service";

const { volume } = await import(".");

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const source = (name: string, extra: Partial<Source> = {}): Source =>
  ({ id: `device:${name}`, kind: "device", name, level: 0.5, muted: false, default: false, active: true, ...extra }) as Source;

const SPEAKERS = source("Speakers (Realtek Audio)", { default: true, level: 0.62 });
const SPOTIFY = source("Spotify", { id: "app:spotify", kind: "app", level: 0.8 });

/** The mixer tab, on a fake volume service whose sources a test can change. */
async function mixer(sources: Source[] = [SPEAKERS, SPOTIFY], pinned: string[] = []) {
  let push: (s: Source[]) => void = () => {};
  const port: VolumePort = {
    watch: async (onChange) => (onChange({ level: 0.62, muted: false, device: "Speakers" } as Output), () => {}),
    watchSources: async (onChange) => ((push = onChange), onChange(sources), () => {}),
    peak: vi.fn(async () => 0.4),
    setLevel: vi.fn(async () => {}),
    setMuted: vi.fn(async () => {}),
  };
  let options = { popup: true, pinned };
  const host = { refresh: vi.fn(), options: () => options, setOptions: vi.fn((p: Partial<typeof options>) => void (options = { ...options, ...p })), openSettings() {} };
  const widget = volume.setup({ volume: port }, host as never);
  const root = document.createElement("section");
  widget.panel?.(root);
  await vi.advanceTimersByTimeAsync(0);
  const tick = async (visible = true) => {
    await widget.tick?.({ now: Date.now(), visible });
    await vi.advanceTimersByTimeAsync(0);
  };
  await tick();
  return {
    root,
    port,
    host,
    tick,
    push: (s: Source[]) => push(s),
    rows: () => [...root.querySelectorAll<HTMLElement>(".mx-row")],
    names: () => [...root.querySelectorAll(".mx-row .mx-name")].map((n) => n.textContent),
    button: (text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!,
  };
}

describe("the volume tab", () => {
  it("shows the default output, with its level and a live meter", async () => {
    const m = await mixer();
    expect(m.names()).toEqual(["Speakers"]);
    expect(m.rows()[0]?.querySelector(".mx-value")?.textContent).toBe("62%");
    expect(m.rows()[0]?.querySelector(".meter")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(m.port.peak).toHaveBeenCalled();
  });

  it("stops the meter while the tab is hidden", async () => {
    const m = await mixer();
    await m.tick(false);
    const calls = vi.mocked(m.port.peak).mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(m.port.peak).mock.calls.length).toBe(calls);
  });

  it("sets a source's level from its slider, and mutes it from its button", async () => {
    const m = await mixer([SPEAKERS, SPOTIFY], ["Spotify"]);
    const slider = m.rows()[0]!.querySelector<HTMLInputElement>("input")!;
    slider.value = "30";
    slider.dispatchEvent(new Event("input"));
    expect(m.port.setLevel).toHaveBeenCalledWith(0.3, "app:spotify");
    expect(m.rows()[0]?.querySelector(".mx-value")?.textContent).toBe("30%");
    m.rows()[0]!.querySelector<HTMLButtonElement>(".mx-mute")!.click();
    expect(m.port.setMuted).toHaveBeenCalledWith(true, "app:spotify");
  });

  it("shows a muted source as off, with an unmute button", async () => {
    const m = await mixer([source("Speakers", { default: true, muted: true })]);
    expect(m.rows()[0]?.dataset.muted).toBe("true");
    expect(m.rows()[0]?.querySelector(".mx-value")?.textContent).toBe("Off");
    expect(m.rows()[0]?.querySelector(".mx-mute")?.getAttribute("aria-label")).toBe("Unmute Speakers");
  });

  it("keeps a slider where it is dragged while updates arrive", async () => {
    const m = await mixer();
    const slider = m.rows()[0]!.querySelector<HTMLInputElement>("input")!;
    slider.dispatchEvent(new Event("pointerdown"));
    slider.value = "90";
    m.push([{ ...SPEAKERS, level: 0.1 }, SPOTIFY]);
    expect(slider.value).toBe("90");
    slider.dispatchEvent(new Event("pointerup"));
    m.push([{ ...SPEAKERS, level: 0.1 }, SPOTIFY]);
    expect(slider.value).toBe("10");
  });

  it("pins sources from its list, then shows them in pin order", async () => {
    const m = await mixer();
    m.button("Sources").click();
    expect(m.root.querySelector(".eyebrow")?.textContent).toBe("Pin sources");
    const pick = (name: string) => [...m.root.querySelectorAll<HTMLButtonElement>(".mx-pick-row")].find((b) => b.textContent?.includes(name))!;
    expect(pick("Spotify").getAttribute("aria-pressed")).toBe("false");
    pick("Spotify").click();
    expect(m.host.setOptions).toHaveBeenCalledWith({ pinned: ["Spotify"] });
    m.button("Done").click();
    expect(m.names()).toEqual(["Spotify"]);
  });

  it("leaves the list of sources when the tab is hidden", async () => {
    const m = await mixer();
    m.button("Sources").click();
    await m.tick(false);
    expect(m.root.querySelector(".eyebrow")?.textContent).toBe("Volume");
  });

  it("says when there is no audio output at all", async () => {
    let options = { popup: true, pinned: [] as string[] };
    const port: VolumePort = {
      watch: async (onChange) => (onChange(null), () => {}),
      watchSources: async (onChange) => (onChange([]), () => {}),
      peak: async () => 0,
      setLevel: async () => {},
      setMuted: async () => {},
    };
    const widget = volume.setup({ volume: port }, { refresh() {}, options: () => options, setOptions: (p: Partial<typeof options>) => void (options = { ...options, ...p }), openSettings() {} } as never);
    const root = document.createElement("section");
    widget.panel?.(root);
    await widget.tick?.({ now: 0, visible: true });
    expect(root.querySelector<HTMLElement>(".empty")?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>(".volume")?.hidden).toBe(true);
  });

  it("asks the island to redraw on a volume change, and pops up only if allowed", async () => {
    const m = await mixer();
    expect(m.host.refresh).toHaveBeenCalled();
    const widget = volume.setup(
      { volume: { ...m.port, watch: async (on) => (on({ level: 0.5, muted: false, device: "S" } as Output), on({ level: 0.7, muted: false, device: "S" } as Output), () => {}) } },
      { refresh() {}, options: () => ({ popup: false, pinned: [] }), setOptions() {}, openSettings() {} } as never,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(widget.glance?.(Date.now())).toBeNull();
  });
});
