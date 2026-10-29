import { afterEach, describe, expect, it, vi } from "vitest";
import { isWindows } from "./platform";

afterEach(() => vi.unstubAllGlobals());

describe("isWindows", () => {
  it("reads the user agent, and is false with no navigator to ask", () => {
    expect(isWindows("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(true);
    expect(isWindows("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
    vi.stubGlobal("navigator", undefined);
    expect(isWindows()).toBe(false);
  });
});
