import { follow } from "../../sdk/follow";
import { type Usage, commands, events } from "./bindings";

export type { Usage };

export interface PrivacyPort {
  /** Calls `onChange` with who uses the mic/camera (null where the OS can't tell) and on every change. */
  watch(onChange: (usage: Usage | null) => void): Promise<() => void>;
}

export const tauriPrivacy: PrivacyPort = {
  watch: (onChange) => follow(events.usageChanged, commands.state, onChange),
};
