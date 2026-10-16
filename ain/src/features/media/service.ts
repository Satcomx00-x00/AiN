import { follow } from "../../sdk/follow";
import { type Control, type Track, commands, events } from "./bindings";

export type { Control, Track };

export interface MediaPort {
  /** Calls `onChange` with the current track (null when nothing plays) and on every change. */
  watch(onChange: (track: Track | null) => void): Promise<() => void>;
  /** Current artwork as a `data:` URL. */
  artwork(): Promise<string | null>;
  control(action: Control): Promise<void>;
}

export const tauriMedia: MediaPort = {
  watch: (onChange) => follow(events.trackChanged, commands.state, onChange),
  artwork: () => commands.artwork(),
  control: async (action) => void (await commands.control(action)),
};
