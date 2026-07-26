import { useEffect } from "react";
import { Mic, MicOff, SkipForward, X } from "lucide-react";
import {
  useVoiceConversation,
  type VoicePhase,
} from "@/lib/hooks/use-voice-conversation";
import { cn } from "@/lib/utils";

interface AssistantReply {
  id: string;
  text: string;
}

interface VoiceOverlayProps {
  active: boolean;
  agentBusy: boolean;
  displayName: string;
  latestAssistant: AssistantReply | null;
  /** Deepgram Aura voice id for spoken replies. */
  voice?: string;
  onClose: () => void;
  onError?: (message: string) => void;
  onUtterance: (text: string) => void;
}

// Map the fine-grained phases to the orb's four visual states.
function orbGroup(phase: VoicePhase): string {
  if (phase === "transcribing") return "thinking";
  return phase;
}

function phaseLabel(phase: VoicePhase, muted: boolean, displayName: string): string {
  if (muted && phase === "listening") return "Muted";
  switch (phase) {
    case "connecting":
      return "Starting…";
    case "listening":
      return "Listening";
    case "transcribing":
      return "Transcribing…";
    case "thinking":
      return `${displayName} is thinking…`;
    case "speaking":
      return "Speaking";
    default:
      return "";
  }
}

/**
 * Full hands-free voice mode. Mounted (inert) on the agent surface; `active`
 * drives the mic session inside `useVoiceConversation`. Renders a focused
 * monochrome takeover over the conversation with an orb that tracks the phase.
 */
export function VoiceOverlay({
  active,
  agentBusy,
  displayName,
  latestAssistant,
  voice,
  onClose,
  onError,
  onUtterance,
}: VoiceOverlayProps) {
  const { phase, transcript, muted, setMuted, skipSpeaking } = useVoiceConversation({
    active,
    agentBusy,
    latestAssistant,
    voice,
    onUtterance,
    onError,
  });

  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onClose]);

  if (!active) return null;

  const group = orbGroup(phase);

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-content/95 px-6 backdrop-blur-sm">
      <button
        aria-label="End voice conversation"
        className="absolute right-5 top-5 flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={onClose}
        type="button"
      >
        <X className="size-5" strokeWidth={1.8} />
      </button>

      <div className="flex flex-col items-center gap-8">
        <div className={cn("wd-orb", `wd-orb-${group}`)}>
          <span className="wd-orb-ring" />
          <span className="wd-orb-ring wd-orb-ring-2" />
          <div className="wd-orb-core">
            {group === "speaking" ? (
              <div className="flex items-center gap-1">
                <span className="wd-orb-bar" />
                <span className="wd-orb-bar" />
                <span className="wd-orb-bar" />
                <span className="wd-orb-bar" />
                <span className="wd-orb-bar" />
              </div>
            ) : group === "thinking" ? (
              <div className="flex items-center gap-1.5">
                <span className="wd-orb-dot" />
                <span className="wd-orb-dot" />
                <span className="wd-orb-dot" />
              </div>
            ) : muted ? (
              <MicOff className="size-7" strokeWidth={1.8} />
            ) : (
              <Mic className="size-7" strokeWidth={1.8} />
            )}
          </div>
        </div>

        <div className="flex min-h-[3.5rem] max-w-[34ch] flex-col items-center gap-2 text-center">
          <p className="text-[13px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {phaseLabel(phase, muted, displayName)}
          </p>
          {transcript && (
            <p className="text-[15px] leading-6 text-foreground/85">“{transcript}”</p>
          )}
        </div>
      </div>

      <div className="absolute bottom-10 flex items-center gap-3">
        {phase === "speaking" ? (
          <button
            className="flex h-10 items-center gap-2 rounded-full border border-border bg-background/70 px-4 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
            onClick={skipSpeaking}
            type="button"
          >
            <SkipForward className="size-4" strokeWidth={1.8} />
            Skip
          </button>
        ) : (
          <button
            aria-pressed={muted}
            className={cn(
              "flex size-12 items-center justify-center rounded-full border transition-colors",
              muted
                ? "border-foreground/30 bg-foreground text-background"
                : "border-border bg-background/70 text-foreground hover:bg-muted",
            )}
            onClick={() => setMuted(!muted)}
            title={muted ? "Unmute microphone" : "Mute microphone"}
            type="button"
          >
            {muted ? (
              <MicOff className="size-5" strokeWidth={1.8} />
            ) : (
              <Mic className="size-5" strokeWidth={1.8} />
            )}
          </button>
        )}
        <button
          className="flex h-12 items-center gap-2 rounded-full border border-border bg-background/70 px-5 text-[14px] font-medium text-foreground transition-colors hover:bg-muted"
          onClick={onClose}
          type="button"
        >
          End
        </button>
      </div>
    </div>
  );
}
