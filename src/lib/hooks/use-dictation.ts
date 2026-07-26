import { useCallback, useEffect, useRef, useState } from "react";
import {
  baseMime,
  blobToBase64,
  MIC_CONSTRAINTS,
  micErrorMessage,
  pickMimeType,
} from "@/lib/audio/capture";
import { tauriInvoke } from "@/lib/tauri";

export type DictationStatus = "idle" | "recording" | "transcribing";

/**
 * Press-to-dictate for the agent composer's mic button. Records a single mic
 * clip; on stop, transcribes it via Deepgram and hands the text back through
 * `onResult` (the composer appends it to the input). One clip at a time —
 * tapping while recording stops + transcribes.
 */
export function useDictation(onResult: (text: string) => void) {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const statusRef = useRef<DictationStatus>("idle");
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const setPhase = useCallback((next: DictationStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      setError(micErrorMessage(err));
      return;
    }
    streamRef.current = stream;

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = async () => {
      const type = recorder.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      stopStream();
      if (blob.size < 1024) {
        setPhase("idle");
        return;
      }
      setPhase("transcribing");
      try {
        const audioBase64 = await blobToBase64(blob);
        const text = await tauriInvoke<string>("voice_dictate", {
          audioBase64,
          mime: baseMime(type),
        });
        if (text && text.trim()) onResultRef.current(text.trim());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPhase("idle");
      }
    };

    recorderRef.current = recorder;
    recorder.start();
    setPhase("recording");
  }, [setPhase, stopStream]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorderRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    if (statusRef.current === "recording") stop();
    else if (statusRef.current === "idle") void start();
  }, [start, stop]);

  // Clean up if the composer unmounts mid-recording (detach onstop so the
  // half-clip doesn't fire a stray transcription against a dead component).
  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  return { status, error, start, stop, toggle };
}
