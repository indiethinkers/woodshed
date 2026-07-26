import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauriInvoke } from "@/lib/tauri";
import { resolveVoiceId } from "@/lib/audio/voices";

const VOICE_QUERY_KEY = ["voicePreference"] as const;

/**
 * The selected Deepgram Aura voice id for voice-mode spoken replies, normalized
 * to a known voice (default Asteria). Backed by config.json via `voice_get`.
 */
export function useVoicePreference() {
  return useQuery<string>({
    queryKey: VOICE_QUERY_KEY,
    queryFn: async () => resolveVoiceId(await tauriInvoke<string>("voice_get")),
    staleTime: Infinity,
  });
}

/** Persist a new voice id and refresh the cached preference. */
export function useSetVoicePreference() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (voice: string) => {
      await tauriInvoke("voice_set", { voice });
      return voice;
    },
    onSuccess: (voice) => {
      queryClient.setQueryData(VOICE_QUERY_KEY, resolveVoiceId(voice));
    },
  });
}
