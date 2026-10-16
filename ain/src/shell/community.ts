import { commands, type Offer, type Shelf } from "./bindings/store";

export type { Offer, Shelf };

/** The community plugin store, read over the internet by the app's backend. */
export interface CommunityPort {
  /** The plugins the store offers, read afresh. */
  catalog(): Promise<Shelf>;
  /** Downloads a plugin into the plugins folder, off; resolves with its file there. */
  install(id: string): Promise<string>;
  /** Opens a plugin's repository in the browser. */
  openRepo(id: string): Promise<void>;
}

export const tauriCommunity: CommunityPort = {
  catalog: () => commands.catalog(),
  install: (id) => commands.install(id),
  openRepo: async (id) => void (await commands.openRepo(id)),
};

/** No store, for the browser previews. */
export const noCommunity: CommunityPort = {
  catalog: () => Promise.reject(new Error("the store is only available in the app")),
  install: () => Promise.reject(new Error("the store is only available in the app")),
  openRepo: async () => {},
};

/** What a store plugin's button does, given the files already in the plugins folder. */
export const offerState = (offer: Offer, files: readonly string[]): "install" | "update" | "unavailable" =>
  offer.problem ? "unavailable" : files.includes(offer.file) ? "update" : "install";
