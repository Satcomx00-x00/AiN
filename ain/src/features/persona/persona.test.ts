// @vitest-environment happy-dom
/**
 * Conversation: the shortcut or the tab's button calls PersonaPlex; the pill says who is speaking,
 * and the tab shows the voice's last words. The server, voice and persona are set in Settings.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { persona, personaGlance, statusText, talking, voiceName } = await import(".");
const { VOICES } = await import("./voices");
const { bindings } = await import("../../shell/commands");
const { catalogue } = await import("..");
const { textProblem } = await import("../../sdk/options");
import type { Phase, PersonaPort } from "./service";

const live = (said = "", speaking = false): Phase => ({ phase: "live", level: 0.5, speaking, said });

/** A conversation backend whose phase the test pushes. */
function fakePort() {
  let push: (phase: Phase) => void = () => {};
  const port = {
    watch: vi.fn(async (onChange: (phase: Phase) => void) => ((push = onChange), onChange({ phase: "idle" }), () => {})),
    control: vi.fn(async () => {}),
  } satisfies PersonaPort;
  return { port, phase: (p: Phase) => push(p) };
}

describe("on the pill", () => {
  it("says who is speaking, with the user's level while it listens", () => {
    expect(personaGlance({ phase: "connecting" }, 0, 0)).toEqual({ text: "Connecting…", mark: "eq", wide: true });
    expect(personaGlance(live(), 0, 0)).toEqual({ text: "Listening", mark: "mic", level: 0.5, wide: true });
    expect(personaGlance(live("Hi", true), 0, 0)).toEqual({ text: "Speaking", mark: "eq", wide: true });
    expect(personaGlance({ phase: "idle" }, 0, 0)).toBeNull();
  });

  it("shows a failure while it is fresh", () => {
    expect(personaGlance({ phase: "error", message: "x" }, 1000, 2000)).toEqual({ text: "Conversation failed", tone: "alert" });
    expect(personaGlance({ phase: "error", message: "x" }, 1000, 9000)).toBeNull();
  });

  it("binds its shortcut as an action, with no popup", () => {
    expect(bindings(catalogue, {})["persona.talk"]).toEqual({ shortcut: "Ctrl+Alt+KeyT", surface: "action" });
  });
});

describe("in the island", () => {
  const mount = () => {
    const fake = fakePort();
    const host = { refresh: vi.fn(), options: () => ({}) as never, setOptions: vi.fn(), secret: async () => "", openSettings: vi.fn(), openPage: vi.fn(), appearance: () => ({ style: "pill", size: "normal", theme: "island", tone: "dark", notch: false }) as const };
    const widget = persona.setup({ persona: fake.port } as never, host);
    const root = document.createElement("section");
    widget.panel?.(root);
    const main = root.querySelector<HTMLButtonElement>(".dict-main")!;
    const status = root.querySelector<HTMLElement>(".dict-status")!;
    const level = root.querySelector<HTMLElement>(".dict-level")!;
    const settings = [...root.querySelectorAll("button")].find((b) => b.textContent === "Settings")!;
    return { ...fake, root, host, main, status, level, settings, widget };
  };

  it("starts and ends a conversation", () => {
    const { port, phase, main, host } = mount();
    expect(main.getAttribute("aria-label")).toBe("Start talking");
    main.click();
    expect(port.control).toHaveBeenLastCalledWith("toggle");
    phase({ phase: "connecting" });
    expect(main.getAttribute("aria-label")).toBe("End the conversation");
    expect(host.refresh).toHaveBeenCalled();
  });

  it("shows the voice's last words and the user's level", () => {
    const { phase, status, level, settings, widget } = mount();
    expect(level.hidden).toBe(true);
    phase(live("Hello there", true));
    expect([status.textContent, status.classList.contains("dict-quote")]).toEqual(["“Hello there”", true]);
    expect([level.hidden, level.style.getPropertyValue("--p")]).toEqual([false, "0.5"]);
    expect(settings.hidden).toBe(true);
    expect(widget.glance?.(Date.now())?.text).toBe("Speaking");
    phase(live());
    expect(status.textContent).toBe("Listening… say hello.");
  });

  it("says what went wrong, and leads to Settings", () => {
    const { phase, status, settings, host } = mount();
    phase({ phase: "error", message: "Couldn't reach the PersonaPlex server at localhost:8998" });
    expect(status.textContent).toContain("Couldn't reach");
    settings.click();
    expect(host.openSettings).toHaveBeenCalledOnce();
  });

  it("stays put when the backend refuses", async () => {
    const { port, main } = mount();
    port.control.mockRejectedValueOnce(new Error("worker gone"));
    main.click();
    await new Promise((r) => setTimeout(r));
    expect(port.control).toHaveBeenCalledOnce();
  });
});

describe("its settings", () => {
  it("offers PersonaPlex's 18 voices by name", () => {
    expect(VOICES).toHaveLength(18);
    expect(persona.options?.voice.default).toBe("NATF2");
    expect([voiceName("NATF2"), voiceName("VARM0"), voiceName("odd")]).toEqual(["Natural, female 3", "Varied, male 1", "odd"]);
  });

  it("checks the server's address", () => {
    const server = persona.options!.server;
    expect(["ws://localhost:8998", "wss://gpu.example.com", "10.0.0.2:8998", "https://host/"].map((v) => textProblem(server, v))).toEqual([null, null, null, null]);
    expect(textProblem(server, "")).not.toBeNull();
    expect(textProblem(server, "not an address")).not.toBeNull();
  });

  it("says what each phase means", () => {
    expect(statusText({ phase: "idle" })).toContain("Ctrl+Alt+T");
    expect(statusText({ phase: "connecting" })).toBe("Connecting to PersonaPlex…");
    expect(talking({ phase: "live", level: 0, speaking: false, said: "" }) && !talking({ phase: "idle" })).toBe(true);
  });
});
