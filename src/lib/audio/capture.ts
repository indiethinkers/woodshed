// Shared mic-capture helpers for the agent's dictation button and hands-free
// voice mode. The WebView's MediaRecorder produces an Opus/WebM (or MP4) blob;
// we base64 it over the Tauri IPC to the `voice_dictate` / `voice_speak`
// commands, which talk to Deepgram directly. No Woodshed server is involved.

export const PREFERRED_MIME_TYPES = ["audio/webm", "audio/mp4", "audio/ogg"];

/** First MediaRecorder container the WebView supports, or undefined to let it
 *  choose. macOS WKWebView generally supports audio/mp4; Opus/WebM on newer. */
export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_MIME_TYPES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

/** Strip the `;codecs=…` parameter — Deepgram wants the bare container MIME. */
export function baseMime(mimeType: string | undefined): string {
  return (mimeType ?? "audio/webm").split(";")[0]?.trim() || "audio/webm";
}

/** Decode standard base64 (e.g. Aura TTS audio) into ArrayBuffer-backed bytes
 *  (so the result is a valid BlobPart). */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Standard-base64 a blob for the IPC hop (chunked to dodge call-stack limits). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Echo cancellation matters for voice mode: the TTS playback bleeds into the
// mic, and these constraints keep the agent from transcribing its own voice.
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

export function micErrorMessage(error: unknown): string {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone access was denied. Enable it in System Settings → Privacy & Security → Microphone.";
    }
    if (error.name === "NotFoundError") return "No microphone was found.";
  }
  return error instanceof Error ? error.message : "Could not access the microphone.";
}

/**
 * Flatten assistant markdown into something that sounds natural when spoken:
 * drop heading/list/emphasis syntax, unwrap links + wikilinks to their label,
 * and strip code fences. Not exhaustive — just enough to keep Aura from
 * reading "asterisk asterisk".
 */
export function speechFromMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → text
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1") // wikilinks → label
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*+]\s+/gm, "") // bullet markers
    .replace(/^\s*\d+\.\s+/gm, "") // ordered markers
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1") // emphasis
    .replace(/^>\s?/gm, "") // blockquotes
    .replace(/\n{2,}/g, ". ") // paragraph breaks → pause
    .replace(/\s+/g, " ")
    .trim();
}
