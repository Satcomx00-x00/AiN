import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { noOAuth, tauriOAuth } = await import("./oauth");

const google = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: "id",
  scopes: ["https://www.googleapis.com/auth/calendar.events"],
};

describe("the oauth service", () => {
  it("asks the app's backend in the plugin's name", async () => {
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce("ya29.token").mockResolvedValueOnce(true).mockResolvedValueOnce(null);
    const calendar = tauriOAuth.forPlugin("calendar");
    expect(await calendar.signIn(google)).toBeUndefined();
    expect(await calendar.token(google)).toBe("ya29.token");
    expect(await calendar.signedIn(google)).toBe(true);
    expect(await calendar.signOut(google)).toBeUndefined();
    expect(invoke.mock.calls).toEqual([
      ["plugin:oauth|sign_in", { plugin: "calendar", provider: google }],
      ["plugin:oauth|token", { plugin: "calendar", provider: google }],
      ["plugin:oauth|signed_in", { plugin: "calendar", provider: google }],
      ["plugin:oauth|sign_out", { plugin: "calendar", provider: google }],
    ]);
  });

  it("has no accounts outside the app", async () => {
    const preview = noOAuth.forPlugin("calendar");
    await expect(preview.signIn(google)).rejects.toThrow("only available in the app");
    expect(await preview.token(google)).toBeNull();
    expect(await preview.signedIn(google)).toBe(false);
  });
});
