import { describe as suite, expect, it } from "vitest";
import { describe, noteLines } from "./updater";

suite("describe", () => {
  it("offers to install an available update", () => {
    const v = describe({ kind: "available", version: "1.2.0", notes: null });
    expect(v).toMatchObject({ text: "Version 1.2.0 is ready to install.", action: "install", tone: "accent", badge: "Update available" });
  });

  it("shows download progress, with a ratio when the size is known", () => {
    const known = describe({ kind: "downloading", version: "1.2.0", received: 5 * 1024 * 1024, total: 10 * 1024 * 1024 });
    expect(known.text).toBe("Downloading 1.2.0 — 5.0 of 10.0 MB · 50%");
    expect(known.progress).toBe(0.5);
    const unknown = describe({ kind: "downloading", version: "1.2.0", received: 1024 * 1024, total: null });
    expect(unknown.text).toBe("Downloading 1.2.0 — 1.0 MB");
    expect(unknown.progress).toBe(0);
  });

  it("offers nothing while busy or disabled", () => {
    expect(describe({ kind: "checking" }).action).toBeNull();
    expect(describe({ kind: "installing", version: "1.2.0" }).action).toBeNull();
    expect(describe({ kind: "disabled", reason: "Development build: updates are off." }).action).toBeNull();
  });

  it("lets a failure be retried", () => {
    expect(describe({ kind: "failed", message: "offline" })).toMatchObject({ text: "offline", action: "check", tone: "hot" });
  });

  it("has no progress bar outside a download or install", () => {
    expect(describe({ kind: "upToDate" }).progress).toBeNull();
  });
});

suite("noteLines", () => {
  it("drops Markdown markers and collapses blank lines", () => {
    expect(noteLines("\n### Features\n- One\n* Two\n\n\n### Fixes\n- Three\n")).toEqual([
      { text: "Features", heading: true },
      { text: "• One", heading: false },
      { text: "• Two", heading: false },
      { text: "", heading: false },
      { text: "Fixes", heading: true },
      { text: "• Three", heading: false },
    ]);
  });
});
