/** Problems reported from anywhere in a window, in the words of whatever was thrown. */
import { describe, expect, it, vi } from "vitest";
import { messageOf, reportProblem } from "./report";

describe("reporting a problem", () => {
  it("words whatever was thrown", () => {
    expect(messageOf(new Error("disk full"))).toBe("disk full");
    expect(messageOf("offline")).toBe("offline");
    expect(messageOf({ code: 5 })).toBe('{"code":5}');
    expect(messageOf(undefined)).toBe("undefined");
  });

  it("reaches the console alone outside a window", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportProblem("Couldn't save", "disk full", "SETTINGS_SAVE");
    expect(warn).toHaveBeenCalledWith("[SETTINGS_SAVE] Couldn't save:", "disk full");
    warn.mockRestore();
  });
});
