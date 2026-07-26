import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsGroup } from "@/components/settings/settings-page";
import { base64ToBytes } from "@/lib/audio/capture";
import { AURA_VOICES, DEFAULT_VOICE_ID } from "@/lib/audio/voices";
import {
  useSetVoicePreference,
  useVoicePreference,
} from "@/lib/hooks/use-voice-preference";
import { tauriInvoke } from "@/lib/tauri";

interface KeyStatus {
  deepgram: boolean;
}

/**
 * Voice & dictation settings. The composer mic (dictation) and voice mode send
 * short mic clips to Deepgram for speech-to-text, and voice mode uses Deepgram
 * Aura for spoken replies. Key: paste here (stored in the OS keychain) or set
 * DEEPGRAM_API_KEY in .env.local during development.
 */
export function TranscriptionKeysSection() {
  const [status, setStatus] = useState<KeyStatus | null>(null);

  const refreshStatus = useCallback(() => {
    tauriInvoke<KeyStatus>("transcription_keys_status")
      .then((s) => setStatus(s ?? { deepgram: false }))
      .catch(() => setStatus({ deepgram: false }));
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  return (
    <SettingsGroup
      label="Voice & dictation"
      description="The composer mic and voice mode transcribe your speech with Deepgram, and voice mode speaks replies with Deepgram Aura. Audio is sent to Deepgram — this is the one place Woodshed leaves your device."
    >
      <div className="flex flex-col gap-4 max-w-[640px]">
        <KeyRow
          account="deepgram"
          label="Deepgram API key"
          help="Speech-to-text + text-to-speech. Get one at deepgram.com."
          configured={status?.deepgram ?? false}
          onSaved={refreshStatus}
        />

        <VoiceRow configured={status?.deepgram ?? false} />

        <p className="text-[12px] text-muted-foreground leading-relaxed">
          macOS will ask for <strong>Microphone</strong> access the first time
          you dictate or open voice mode. Mic audio is sent to Deepgram for
          transcription and Deepgram Aura for spoken replies — nothing else
          leaves your device.
        </p>
      </div>
    </SettingsGroup>
  );
}

function KeyRow({
  account,
  label,
  help,
  configured,
  onSaved,
}: {
  account: "deepgram";
  label: string;
  help: string;
  configured: boolean;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!value.trim() || saving) return;
    setSaving(true);
    try {
      await tauriInvoke("transcription_key_set", { account, value: value.trim() });
      setValue("");
      onSaved();
      toast.success(`${label} saved`);
    } catch (e) {
      toast.error(`Couldn’t save ${label}`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {configured && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            <Check className="h-3 w-3" /> configured
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder={configured ? "•••••••• (replace)" : "Paste key…"}
          className="flex-1 h-8 px-2.5 rounded-sm border border-border bg-background text-sm font-mono outline-none focus:border-foreground/40"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={!value.trim() || saving}
          className="h-8 px-3 rounded-sm border border-border bg-background text-sm text-foreground hover:bg-foreground/[0.04] disabled:opacity-40 transition-colors inline-flex items-center gap-1.5"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          Save
        </button>
      </div>
      <p className="text-[12px] text-muted-foreground">{help}</p>
    </div>
  );
}

/**
 * Voice picker for voice-mode spoken replies. Persists the chosen Deepgram Aura
 * voice to config.json; Preview synthesizes a sample line so you can hear it
 * before committing. Preview needs the Deepgram key configured.
 */
function VoiceRow({ configured }: { configured: boolean }) {
  const { data: voice } = useVoicePreference();
  const setVoice = useSetVoicePreference();
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const selected = voice ?? DEFAULT_VOICE_ID;

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  // Revoke any pending blob URL / stop playback on unmount.
  useEffect(() => stopPlayback, [stopPlayback]);

  const preview = async () => {
    if (previewing || !configured) return;
    setPreviewing(true);
    try {
      const audioBase64 = await tauriInvoke<string>("voice_speak", {
        text: "Hey — this is how I'll sound in voice mode.",
        voice: selected,
      });
      if (!audioBase64) {
        setPreviewing(false);
        return;
      }
      stopPlayback();
      // Blob URL (not data:) — the app CSP allows `media-src blob:` only.
      const url = URL.createObjectURL(
        new Blob([base64ToBytes(audioBase64)], { type: "audio/mpeg" }),
      );
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      const done = () => {
        stopPlayback();
        setPreviewing(false);
      };
      audio.onended = done;
      audio.onerror = done;
      await audio.play();
    } catch (e) {
      setPreviewing(false);
      toast.error("Couldn’t play preview", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">Voice</span>
      <div className="flex items-center gap-2">
        <select
          value={selected}
          onChange={(e) => setVoice.mutate(e.target.value)}
          disabled={setVoice.isPending}
          className="flex-1 h-8 px-2.5 rounded-sm border border-border bg-background text-sm text-foreground outline-none focus:border-foreground/40 disabled:opacity-40"
        >
          {AURA_VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} — {v.detail}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void preview()}
          disabled={!configured || previewing}
          title={configured ? "Hear a sample" : "Add a Deepgram key to preview"}
          className="h-8 px-3 rounded-sm border border-border bg-background text-sm text-foreground hover:bg-foreground/[0.04] disabled:opacity-40 transition-colors inline-flex items-center gap-1.5"
        >
          {previewing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
          Preview
        </button>
      </div>
      <p className="text-[12px] text-muted-foreground">
        The voice Woodshed uses to speak replies in voice mode (Deepgram Aura).
      </p>
    </div>
  );
}
