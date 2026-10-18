import { type Provider, commands } from "./bindings/oauth";
import { type PerPlugin, perPlugin } from "./extensions";

export type { Provider };

/**
 * What the `oauth` service does for a plugin: signs it in to an online account in the system
 * browser and hands it short-lived access tokens. The app keeps the refresh token in the OS
 * keychain, filed under the plugin's id. That keeps plugins' accounts from mixing up; it isn't a
 * wall against a malicious plugin, which shares the island's window with the others.
 */
export interface OAuthPort {
  /** Opens the provider's sign-in page in the browser; resolves once the user is signed in. */
  signIn(provider: Provider): Promise<void>;
  /** A valid access token, or null when not signed in (or no longer: sign in again). */
  token(provider: Provider): Promise<string | null>;
  /** Forgets the account, and revokes it where the provider allows. */
  signOut(provider: Provider): Promise<void>;
  /** Whether there is an account, without going online. */
  signedIn(provider: Provider): Promise<boolean>;
}

/** The app's sign-in service, one per plugin. */
export const tauriOAuth: PerPlugin<OAuthPort> = perPlugin((plugin) => ({
  signIn: async (provider) => void (await commands.signIn(plugin, provider)),
  token: (provider) => commands.token(plugin, provider),
  signOut: async (provider) => void (await commands.signOut(plugin, provider)),
  signedIn: (provider) => commands.signedIn(plugin, provider),
}));

/** No accounts, for the browser previews. */
export const noOAuth: PerPlugin<OAuthPort> = perPlugin(() => ({
  signIn: () => Promise.reject(new Error("signing in is only available in the app")),
  token: async () => null,
  signOut: async () => {},
  signedIn: async () => false,
}));
