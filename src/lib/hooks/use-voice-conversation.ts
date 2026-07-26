import { useCallback, useEffect, useRef, useState } from "react";
import {
  base64ToBytes,
  baseMime,
  blobToBase64,
  MIC_CONSTRAINTS,
  micErrorMessage,
  pickMimeType,
  speechFromMarkdown,
} from "@/lib/audio/capture";
import { tauriInvoke } from "@/lib/tauri";

export type VoicePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking";

// --- Voice-activity-detection tuning (RMS over the time-domain signal) -------
// Speech sits well above room tone; these thresholds + a trailing silence
// window decide when a turn is over. Conservative on the silence side so we
// don't cut the user off mid-sentence.
const START_RMS = 0.02; // begin a turn once we cross this
const SUSTAIN_RMS = 0.012; // keep the turn alive above this
const SILENCE_MS = 1100; // trailing quiet that ends a turn
const MIN_SPEECH_MS = 350; // ignore lip-smacks / clicks
const MAX_TURN_MS = 20000; // hard cap on a single utterance
const MIN_CLIP_BYTES = 1400; // below this, assume we caught nothing

interface VadState {
  speaking: boolean;
  startedAt: number;
  lastVoiceAt: number;
}

interface AssistantReply {
  id: string;
  text: string;
}

interface UseVoiceConversationArgs {
  active: boolean;
  /** Agent is mid-turn (submitted/streaming). Gates the speak handoff. */
  agentBusy: boolean;
  /** The latest assistant message, or null. Drives reply detection. */
  latestAssistant: AssistantReply | null;
  /** Deepgram Aura voice id for spoken replies. Empty = backend default. */
  voice?: string;
  /** Send a transcribed utterance to the agent (creates a chat if needed). */
  onUtterance: (text: string) => void;
  onError?: (message: string) => void;
}

/**
 * Hands-free voice loop for the agent surface. Owns one mic stream for the
 * session and cycles: listen (with silence-detection VAD) → transcribe
 * (Deepgram) → send to the agent → wait for the reply → speak it (Aura TTS) →
 * listen again. The agent wiring lives in the surface; this hook only observes
 * `agentBusy` + `latestAssistant` to know when a fresh reply has landed.
 */
export function useVoiceConversation({
  active,
  agentBusy,
  latestAssistant,
  voice,
  onUtterance,
  onError,
}: UseVoiceConversationArgs) {
  const [phase, setPhaseState] = useState<VoicePhase>("idle");
  const [transcript, setTranscript] = useState("");
  const [muted, setMutedState] = useState(false);

  const phaseRef = useRef<VoicePhase>("idle");
  const activeRef = useRef(false);
  const mutedRef = useRef(false);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sampleRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recorderMimeRef = useRef<string>("audio/webm");
  const vadRef = useRef<VadState>({ speaking: false, startedAt: 0, lastVoiceAt: 0 });

  const playbackRef = useRef<HTMLAudioElement | null>(null);
  const playbackUrlRef = useRef<string | null>(null);
  // The assistant id present when we sent the current turn — a reply is "new"
  // once latestAssistant.id differs from this and the agent has gone idle.
  const baselineReplyIdRef = useRef<string | null>(null);

  const latestAssistantRef = useRef<AssistantReply | null>(latestAssistant);
  latestAssistantRef.current = latestAssistant;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const setPhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const reportError = useCallback((message: string) => {
    onErrorRef.current?.(message);
  }, []);

  // --- Listening ------------------------------------------------------------
  const beginListening = useCallback(() => {
    const stream = streamRef.current;
    if (!activeRef.current || !stream) return;
    chunksRef.current = [];
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    recorderMimeRef.current = recorder.mimeType || mimeType || "audio/webm";
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => void handleTurnEnd();
    recorderRef.current = recorder;
    recorder.start();
    vadRef.current = { speaking: false, startedAt: 0, lastVoiceAt: 0 };
    setTranscript("");
    setPhase("listening");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPhase]);

  const endTurn = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  const handleTurnEnd = useCallback(async () => {
    const type = recorderMimeRef.current;
    const blob = new Blob(chunksRef.current, { type });
    chunksRef.current = [];
    if (!activeRef.current) return;
    if (blob.size < MIN_CLIP_BYTES) {
      beginListening();
      return;
    }
    setPhase("transcribing");
    try {
      const audioBase64 = await blobToBase64(blob);
      const text = await tauriInvoke<string>("voice_dictate", {
        audioBase64,
        mime: baseMime(type),
      });
      if (!activeRef.current) return;
      const utterance = (text ?? "").trim();
      if (!utterance) {
        beginListening();
        return;
      }
      setTranscript(utterance);
      baselineReplyIdRef.current = latestAssistantRef.current?.id ?? null;
      setPhase("thinking");
      onUtteranceRef.current(utterance);
    } catch (err) {
      if (!activeRef.current) return;
      reportError(err instanceof Error ? err.message : String(err));
      beginListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beginListening, reportError, setPhase]);

  // --- VAD loop -------------------------------------------------------------
  const tick = useCallback(() => {
    if (!activeRef.current) return;
    rafRef.current = requestAnimationFrame(tick);
    if (phaseRef.current !== "listening" || mutedRef.current) return;
    const analyser = analyserRef.current;
    const sample = sampleRef.current;
    if (!analyser || !sample) return;

    analyser.getFloatTimeDomainData(sample);
    let sum = 0;
    for (let i = 0; i < sample.length; i += 1) sum += sample[i] * sample[i];
    const rms = Math.sqrt(sum / sample.length);
    const now = performance.now();
    const vad = vadRef.current;

    if (rms > START_RMS) {
      if (!vad.speaking) {
        vad.speaking = true;
        vad.startedAt = now;
      }
      vad.lastVoiceAt = now;
    } else if (rms > SUSTAIN_RMS && vad.speaking) {
      vad.lastVoiceAt = now;
    }

    if (vad.speaking) {
      const longEnough = now - vad.startedAt > MIN_SPEECH_MS;
      const trailingSilence = now - vad.lastVoiceAt > SILENCE_MS;
      const tooLong = now - vad.startedAt > MAX_TURN_MS;
      if ((longEnough && trailingSilence) || tooLong) {
        vad.speaking = false;
        endTurn();
      }
    }
  }, [endTurn]);

  // --- Speaking (reply detected by the effect below) ------------------------
  const speak = useCallback(
    async (text: string) => {
      setPhase("speaking");
      const spoken = speechFromMarkdown(text);
      if (!spoken) {
        beginListening();
        return;
      }
      try {
        const audioBase64 = await tauriInvoke<string>("voice_speak", {
          text: spoken,
          voice: voiceRef.current || undefined,
        });
        if (!activeRef.current) return;
        if (!audioBase64) {
          beginListening();
          return;
        }
        // Blob URL (not a data: URL) — the app CSP allows `media-src blob:`
        // but not `data:`. Revoke once playback is done.
        const url = URL.createObjectURL(
          new Blob([base64ToBytes(audioBase64)], { type: "audio/mpeg" }),
        );
        playbackUrlRef.current = url;
        const audio = new Audio(url);
        playbackRef.current = audio;
        const resume = () => {
          URL.revokeObjectURL(url);
          if (playbackUrlRef.current === url) playbackUrlRef.current = null;
          if (activeRef.current && phaseRef.current === "speaking") beginListening();
        };
        audio.onended = resume;
        audio.onerror = resume;
        await audio.play();
      } catch (err) {
        if (!activeRef.current) return;
        reportError(err instanceof Error ? err.message : String(err));
        beginListening();
      }
    },
    [beginListening, reportError, setPhase],
  );

  // Speak the agent's reply once it lands and the stream has settled. Guards on
  // phase === "thinking" so it fires exactly once per turn.
  useEffect(() => {
    if (!active || phaseRef.current !== "thinking" || agentBusy) return;
    const reply = latestAssistant;
    if (!reply || reply.id === baselineReplyIdRef.current || !reply.text.trim()) {
      return;
    }
    void speak(reply.text);
  }, [active, agentBusy, latestAssistant, speak]);

  // --- Controls -------------------------------------------------------------
  const setMuted = useCallback((next: boolean) => {
    mutedRef.current = next;
    setMutedState(next);
    // Disable the track so the VAD reads silence and won't end a turn on the
    // tail of speech captured before the mute.
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    if (next) vadRef.current = { speaking: false, startedAt: 0, lastVoiceAt: 0 };
  }, []);

  const skipSpeaking = useCallback(() => {
    const audio = playbackRef.current;
    if (audio) {
      audio.onended = null;
      audio.pause();
      playbackRef.current = null;
    }
    if (playbackUrlRef.current) {
      URL.revokeObjectURL(playbackUrlRef.current);
      playbackUrlRef.current = null;
    }
    if (activeRef.current && phaseRef.current === "speaking") beginListening();
  }, [beginListening]);

  // --- Session lifecycle ----------------------------------------------------
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    activeRef.current = true;
    mutedRef.current = false;
    setMutedState(false);
    setTranscript("");
    setPhase("connecting");

    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      } catch (err) {
        if (!cancelled) {
          reportError(micErrorMessage(err));
          setPhase("idle");
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      try {
        const AudioCtx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new AudioCtx();
        await ctx.resume();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        sampleRef.current = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      } catch (err) {
        if (!cancelled) reportError(err instanceof Error ? err.message : String(err));
      }
      rafRef.current = requestAnimationFrame(tick);
      beginListening();
    })();

    return () => {
      cancelled = true;
      activeRef.current = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;

      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      recorderRef.current = null;
      chunksRef.current = [];

      const audio = playbackRef.current;
      if (audio) {
        audio.onended = null;
        audio.pause();
        playbackRef.current = null;
      }
      if (playbackUrlRef.current) {
        URL.revokeObjectURL(playbackUrlRef.current);
        playbackUrlRef.current = null;
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      void audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      analyserRef.current = null;
      sampleRef.current = null;

      phaseRef.current = "idle";
      setPhaseState("idle");
      setTranscript("");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return { phase, transcript, muted, setMuted, skipSpeaking };
}
