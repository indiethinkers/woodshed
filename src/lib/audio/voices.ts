// Deepgram Aura (aura-1) English voices offered in Settings → Accounts for
// voice-mode spoken replies. The stored preference is the raw Aura model id;
// an empty/unknown id falls back to the default (Asteria) on the backend.

export interface AuraVoice {
  id: string;
  name: string;
  /** Short descriptor shown after the name, e.g. "Female · US". */
  detail: string;
}

export const DEFAULT_VOICE_ID = "aura-asteria-en";

export const AURA_VOICES: AuraVoice[] = [
  { id: "aura-asteria-en", name: "Asteria", detail: "Female · US" },
  { id: "aura-luna-en", name: "Luna", detail: "Female · US" },
  { id: "aura-stella-en", name: "Stella", detail: "Female · US" },
  { id: "aura-athena-en", name: "Athena", detail: "Female · UK" },
  { id: "aura-hera-en", name: "Hera", detail: "Female · US" },
  { id: "aura-orion-en", name: "Orion", detail: "Male · US" },
  { id: "aura-arcas-en", name: "Arcas", detail: "Male · US" },
  { id: "aura-perseus-en", name: "Perseus", detail: "Male · US" },
  { id: "aura-angus-en", name: "Angus", detail: "Male · Ireland" },
  { id: "aura-orpheus-en", name: "Orpheus", detail: "Male · US" },
  { id: "aura-helios-en", name: "Helios", detail: "Male · UK" },
  { id: "aura-zeus-en", name: "Zeus", detail: "Male · US" },
];

/** Normalize a stored value to a known voice id, falling back to the default. */
export function resolveVoiceId(value: string | null | undefined): string {
  const id = value?.trim();
  if (id && AURA_VOICES.some((voice) => voice.id === id)) return id;
  return DEFAULT_VOICE_ID;
}
