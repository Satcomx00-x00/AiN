import { z } from "zod";
import { follow } from "../../core/live";

export const UsageSchema = z.object({ mic: z.array(z.string()), camera: z.array(z.string()) });
export type Usage = z.infer<typeof UsageSchema>;

export interface PrivacyPort {
  /** Calls `onChange` with who uses the mic/camera (null where the OS can't tell) and on every change. */
  watch(onChange: (usage: Usage | null) => void): Promise<() => void>;
}

export const tauriPrivacy: PrivacyPort = {
  watch: (onChange) => follow("privacy:state", "plugin:privacy|state", UsageSchema.nullable(), onChange),
};
