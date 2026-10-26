// @vitest-environment happy-dom
/** The Now playing tab and glance: the track, its artwork and tint, and the playback controls. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Control, MediaPort, Track } from "./service";

vi.mock("../../sdk/color", () => ({ imageColor: vi.fn(() => "#1db954") }));

const { media } = await import(".");

const NOW = 100_000;
const SONG: Track = { title: "Hurry Up, We're Dreaming Tonight", artist: "M83", album: "", app: "Spotify", playing: true, positionMs: 30_000, durationMs: 240_000, measuredAt: NOW, artworkKey: "k1" };

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The tab on a fake player whose track a test can change. */
async function player(first: Track | null = SONG, opts = { wide: true, tint: true }) {
  let push: (t: Track | null) => void = () => {};
  const port = {
    watch: vi.fn(async (onChange: (t: Track | null) => void) => ((push = onChange), onChange(first), () => {})),
    artwork: vi.fn(async (): Promise<string | null> => "data:image/png;base64,ART"),
    control: vi.fn(async (_: Control) => {}),
  } satisfies MediaPort;
  let options = opts;
  const host = { refresh: vi.fn(), options: () => options, setOptions() {}, openSettings() {} };
  const widget = media.setup({ media: port }, host as never);
  const root = document.createElement("section");
  widget.panel?.(root);
  await vi.advanceTimersByTimeAsync(0);
  const q = <E extends HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
  return {
    port,
    host,
    widget,
    root,
    q,
    push: async (t: Track | null) => (push(t), await vi.advanceTimersByTimeAsync(0)),
    setOptions: (o: typeof opts) => (options = o),
    button: (label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!,
  };
}

describe("the Now playing tab", () => {
  it("shows the track, who plays it, and how far along it is", async () => {
    const p = await player();
    expect(p.q(".media-title").textContent).toBe(SONG.title);
    expect(p.q(".media-sub").textContent).toBe("M83 · Spotify");
    expect([...p.q(".media-progress").children].map((c) => c.textContent)).toEqual(["0:30", "", "4:00"]);
    await p.widget.tick?.({ now: NOW + 30_000, visible: true });
    expect(p.q(".media-progress span").textContent).toBe("1:00");
    expect(p.q(".bar").style.getPropertyValue("--p")).toBe("0.25");
    expect(p.button("Pause")).not.toBeNull();
  });

  it("doesn't redraw while hidden", async () => {
    const p = await player();
    expect(p.widget.tick?.({ now: NOW + 60_000, visible: false })).toBeUndefined();
    expect(p.q(".media-progress span").textContent).toBe("0:30");
  });

  it("shows a stream with no known length, from an app with no artist", async () => {
    const p = await player({ ...SONG, artist: "", durationMs: 0 });
    await p.widget.tick?.({ now: NOW + 5_000, visible: true });
    expect(p.q(".media-sub").textContent).toBe("Spotify");
    expect([...p.q(".media-progress").children].map((c) => c.textContent)).toEqual(["0:35", "", ""]);
    expect(p.q(".bar").style.getPropertyValue("--p")).toBe("0");
  });

  it("pauses at once, before the player confirms, and sends each control", async () => {
    const p = await player();
    vi.setSystemTime(NOW + 10_000);
    p.button("Pause").click();
    expect(p.port.control).toHaveBeenLastCalledWith("toggle");
    expect(p.button("Play")).not.toBeNull();
    expect(p.q(".bar").dataset.live).toBe("false");
    await p.widget.tick?.({ now: NOW + 99_000, visible: true });
    expect(p.q(".media-progress span").textContent).toBe("0:40");
    p.button("Previous").click();
    p.button("Next").click();
    expect(p.port.control.mock.calls.map(([a]) => a)).toEqual(["toggle", "previous", "next"]);
  });

  it("only sends the toggle when nothing plays, and shrugs off a refused control", async () => {
    const p = await player(null);
    expect([p.q<HTMLElement>(".media").hidden, p.q<HTMLElement>(".empty").hidden]).toEqual([true, false]);
    p.port.control.mockRejectedValueOnce(new Error("no player"));
    p.button("Next").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.port.control).toHaveBeenCalledWith("next");
    expect(p.widget.glance?.(NOW)).toBeNull();
  });
});

describe("the artwork", () => {
  it("shows the cover, tints the island with it, and puts it on the pill", async () => {
    const p = await player();
    const img = p.q<HTMLImageElement>(".art-img");
    expect([img.getAttribute("src"), p.q(".art").dataset.has]).toEqual(["data:image/png;base64,ART", "true"]);
    img.dispatchEvent(new Event("load"));
    expect(p.widget.ambient?.()).toBe("#1db954");
    expect(p.host.refresh).toHaveBeenCalled();
    expect(p.widget.glance?.(NOW)).toEqual({ text: "Hurry Up, We're Dreamin…", mark: "eq", wide: true, art: "data:image/png;base64,ART" });
    p.setOptions({ wide: false, tint: false });
    expect(p.widget.ambient?.()).toBeNull();
    expect(p.widget.glance?.(NOW)?.wide).toBe(false);
  });

  it("drops the cover and tint for a track without artwork", async () => {
    const p = await player();
    p.q<HTMLImageElement>(".art-img").dispatchEvent(new Event("load"));
    await p.push({ ...SONG, title: "Radio", artworkKey: "" });
    expect([p.q<HTMLImageElement>(".art-img").hasAttribute("src"), p.q(".art").dataset.has]).toEqual([false, "false"]);
    expect(p.widget.ambient?.()).toBeNull();
    expect(p.widget.glance?.(NOW)).toEqual({ text: "Radio", mark: "eq", wide: true });
  });

  it("treats artwork that can't be read as none", async () => {
    const p = await player(null);
    p.port.artwork.mockRejectedValueOnce(new Error("gone"));
    await p.push(SONG);
    expect(p.q(".art").dataset.has).toBe("false");
  });

  it("keeps the newest track's cover when an older one arrives late", async () => {
    const p = await player(null);
    let late: (url: string) => void = () => {};
    p.port.artwork.mockImplementationOnce(() => new Promise((r) => (late = r)));
    await p.push(SONG);
    await p.push({ ...SONG, artworkKey: "k2" });
    late("data:image/png;base64,OLD");
    await vi.advanceTimersByTimeAsync(0);
    expect(p.q<HTMLImageElement>(".art-img").getAttribute("src")).toBe("data:image/png;base64,ART");
    expect(p.port.artwork).toHaveBeenCalledTimes(2);
  });
});
