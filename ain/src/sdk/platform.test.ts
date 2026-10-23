import { afterEach, describe, expect, it, vi } from "vitest";
import { isMac, primaryKey } from "./platform";

afterEach(() => vi.unstubAllGlobals());

describe("isMac", () => {
  it("reads the user agent", () => {
    expect(isMac("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)")).toBe(true);
    expect(isMac("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
  });

  it("is false where there is no navigator to ask", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isMac()).toBe(false);
  });
});

describe("primaryKey", () => {
  it("is Cmd on macOS and Ctrl elsewhere", () => expect([primaryKey(true), primaryKey(false)]).toEqual(["Cmd", "Ctrl"]));
});
