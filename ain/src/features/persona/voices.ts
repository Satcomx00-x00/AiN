/** PersonaPlex's voices; the ids match `VOICES` in src-tauri/src/features/persona/mod.rs. */
export const VOICES = [
  ...["F", "M"].flatMap((g) => [0, 1, 2, 3].map((n) => `NAT${g}${n}`)),
  ...["F", "M"].flatMap((g) => [0, 1, 2, 3, 4].map((n) => `VAR${g}${n}`)),
] as const;

export const DEFAULT_VOICE = "NATF2";
export const DEFAULT_PROMPT = "You are a wise and friendly assistant. Answer questions or give advice in a clear, engaging and brief way.";

/** "NATF2" → "Natural, female 3". */
export function voiceName(id: string): string {
  const [, kind, gender, n] = /^(NAT|VAR)([FM])(\d)$/.exec(id) ?? [];
  if (!kind || !gender || !n) return id;
  return `${kind === "NAT" ? "Natural" : "Varied"}, ${gender === "F" ? "female" : "male"} ${Number(n) + 1}`;
}
