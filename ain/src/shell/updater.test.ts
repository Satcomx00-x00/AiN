import { afterEach, describe as suite, expect, it, vi } from "vitest";
import { type Report, demoUpdater, describe, noteLines } from "./updater";

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

  it("offers a first check before any has run", () => {
    expect(describe({ kind: "idle" })).toEqual({ text: "Not checked yet.", tone: "muted", badge: null, action: "check", progress: null });
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

suite("demoUpdater", () => {
  afterEach(() => vi.useRealTimers());

  it("starts idle, on the preview's version", async () => {
    expect(await demoUpdater().status()).toEqual({ current: "0.1.0", state: { kind: "idle" }, releases: "https://github.com/" });
  });

  it("finds 0.2.0 after a moment of checking, telling every watcher", async () => {
    vi.useFakeTimers();
    const updater = demoUpdater();
    const kinds: string[] = [];
    await updater.watch((r) => kinds.push(r.state.kind));
    const checked = updater.check();
    expect(kinds).toEqual(["checking"]);
    await vi.advanceTimersByTimeAsync(900);
    const report = await checked;
    expect(report.state).toMatchObject({ kind: "available", version: "0.2.0" });
    expect(report.state.kind === "available" && noteLines(report.state.notes ?? "")[0]).toEqual({ text: "Features", heading: true });
    expect(await updater.status()).toEqual(report);
    expect(kinds).toEqual(["checking", "available"]);
  });

  it("downloads in steps, then installs", async () => {
    vi.useFakeTimers();
    const updater = demoUpdater();
    const seen: Report[] = [];
    await updater.watch((r) => seen.push(r));
    const installed = updater.install();
    await vi.advanceTimersByTimeAsync(21 * 120);
    await installed;
    const downloads = seen.filter((r) => r.state.kind === "downloading").map((r) => (r.state.kind === "downloading" ? r.state.received : -1));
    expect(downloads).toHaveLength(21);
    expect([downloads[0], downloads[1], downloads.at(-1)]).toEqual([0, 443_104, 8_862_080]);
    expect(seen.at(-1)?.state).toEqual({ kind: "installing", version: "0.2.0" });
  });

  it("stops telling a watcher that stopped watching, and opens no page", async () => {
    vi.useFakeTimers();
    const updater = demoUpdater();
    const on = vi.fn();
    const stop = await updater.watch(on);
    stop();
    const checked = updater.check();
    await vi.advanceTimersByTimeAsync(900);
    await checked;
    expect(on).not.toHaveBeenCalled();
    expect(await updater.openReleases()).toBeUndefined();
  });
});
