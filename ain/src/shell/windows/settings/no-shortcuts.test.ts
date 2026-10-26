// @vitest-environment happy-dom
/** The Shortcuts section when no built-in feature offers a command to bind. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { environment, restore, startSettings, system } from "../../../integration/harness";

vi.mock(import("../../../features"), async (original) => {
  const features = await original();
  return { ...features, catalogue: features.catalogue.filter((p) => !p.commands?.length) };
});

afterEach(restore);

describe("Settings → Shortcuts, with no commands", () => {
  it("says there are no shortcuts, and keeps the note about Windows' own", async () => {
    environment();
    const page = await startSettings(system(), "shortcuts");
    expect(page.page.querySelector("h1")?.textContent).toBe("Shortcuts");
    expect(page.page.querySelector(".page-body .lead")?.textContent).toBe("No shortcuts.");
    expect(page.page.querySelector(".recorder")).toBeNull();
    expect(page.page.querySelector(".note")?.textContent).toBe("Win + a single letter is reserved by Windows: add Shift or Alt.");
  });
});
