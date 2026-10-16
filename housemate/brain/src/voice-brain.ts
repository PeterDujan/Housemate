import { VOICE_TRUST_MIN_CONFIDENCE, canonicalHouseholdActorId } from "./actor-identity.js";
import type { IntentConfidence, IntentRoute } from "./intent-contract.js";
import type { ResultSessionDirective } from "./result-contract.js";
import { defaultBrainNotWiredSentence } from "./speech-planner.js";
import { formatForSpeech } from "./spoken-format.js";
import type { ProgressiveSpeechSink } from "./progressive-speech.js";
import type { SpeechTone } from "./speech-tone.js";
import type { TurnPace } from "./turn-pace.js";
import { objectValue, optionalString } from "./value-guards.js";

export type VoiceBrainChannel = "voice" | "chat" | "test";
export type VoiceBrainErrorCode = "bad_request" | "brain_unavailable" | "internal_error";
export type VoiceBrainIdentitySource = "none" | "ha_ingress" | "api_token";

export interface VoiceBrainSpeaker {
  readonly name: string | null;
  readonly voiceId: string | null;
  readonly confidence: number | null;
  readonly trustedActorId?: string | null;
  /** True when the request transport supplied a valid credential. */
  readonly transportAuthenticated?: boolean;
  readonly identitySource?: VoiceBrainIdentitySource;
}

export interface VoiceBrainTiming {
  readonly wakeMs?: number;
  readonly sttMs?: number;
  readonly speakerMs?: number;
}

/**
 * The speaker (Show, speaker) a voice turn came from, as the Voice Loop's
 * endpoint registry records it. Trusted only from an admitted household client.
 */
export interface VoiceBrainEndpoint {
  readonly id: string;
  readonly name: string | null;
  /** Its Music Assistant player, set at pairing. */
  readonly mediaPlayer: string | null;
  /** The voice host muted that player for this request only: the music is still on. */
  readonly musicMutedByTurn?: boolean;
  /** The voice host paused that player for this request only: the music is still on. */
  readonly musicPausedByTurn?: boolean;
}

export interface VoiceBrainRequest {
  readonly schemaVersion: 1;
  readonly transcript: string;
  readonly transcriptConfidence?: number | null;
  readonly room: string | null;
  readonly channel: VoiceBrainChannel;
  readonly sourceVia: string | null;
  readonly endpoint?: VoiceBrainEndpoint | null;
  readonly sessionId: string | null;
  readonly conversationMode: boolean;
  readonly speaker: VoiceBrainSpeaker;
  readonly timing: VoiceBrainTiming;
  /** Internal transport sink. It is never accepted from caller JSON. */
  readonly progressive?: ProgressiveSpeechSink;
  /** Internal per-turn timing recorder, set by the brain. Never accepted from caller JSON. */
  readonly pace?: TurnPace;
}

export interface VoiceBrainRouteMetadata {
  readonly route: IntentRoute;
  readonly confidence: IntentConfidence;
  readonly status: "ok" | "clarify" | "declined" | "error";
  readonly resultId: string | null;
  readonly turnId: string;
}

export interface VoiceBrainSpeech {
  readonly text: string;
  readonly fish_text?: string;
  /** Code-picked tone for the whole reply; absent means neutral. */
  readonly tone?: SpeechTone;
  readonly lead_text?: string;
  readonly tail?: VoiceBrainTailMetadata;
}

export interface VoiceBrainTailMetadata {
  readonly turn_id: string;
  readonly status: "pending" | "ready" | "skipped" | "timeout" | "error";
  readonly poll_path?: string;
  readonly text?: string;
  readonly fish_text?: string;
  readonly reason?: string;
}

export interface VoiceBrainResponse {
  readonly ok: true;
  readonly modelUsed: boolean;
  readonly response: string;
  readonly text: string;
  readonly speech: VoiceBrainSpeech;
  readonly continue_session: boolean;
  readonly session: {
    readonly directive: ResultSessionDirective;
  };
  readonly voice_response: {
    /** `confirm_beep`: nothing is spoken; the endpoint plays its beep (silent music commands). */
    readonly mode: "speech" | "confirm_beep";
    readonly end_session: boolean;
    /** "hold": the voice host leaves the music it paused for this request as the command left it. */
    readonly music_after?: "hold";
    /**
     * He asked something, so the speaker listens again for the answer (a stock Echo's ExpectSpeech;
     * listen again only then, not after every answer).
     */
    readonly expect_speech: boolean;
    readonly kind: "answer" | "clarify" | "declined" | "error";
  };
  readonly route: VoiceBrainRouteMetadata;
  readonly error?: never;
}

export interface VoiceBrainErrorResponse {
  readonly ok: false;
  readonly error: {
    readonly code: VoiceBrainErrorCode;
    readonly message: string;
  };
  readonly response: string;
  readonly text: string;
  readonly speech: VoiceBrainSpeech;
  readonly continue_session: false;
  readonly session: {
    readonly directive: "close";
  };
  readonly voice_response: {
    readonly mode: "speech";
    readonly end_session: true;
    readonly kind: "error";
  };
}

export type VoiceBrainHandler = (request: VoiceBrainRequest) => Promise<VoiceBrainResponse> | VoiceBrainResponse;

export function parseVoiceBrainRequest(
  raw: unknown,
  transportTrust: {
    readonly actorId: string;
    readonly source: Exclude<VoiceBrainIdentitySource, "none">;
  } | null = null,
): VoiceBrainRequest {
  const value = objectValue(raw, "voice brain request");
  const transcript = firstNonEmptyString(value.transcript, value.utterance, value.text);
  if (!transcript) {
    throw new Error("voice brain request transcript is required");
  }
  const channel = channelValue(optionalString(value.channel) ?? "voice");
  const sourceVia = optionalString(value.source_via) ?? optionalString(value.sourceVia);
  const conversationMode = optionalBoolean(value.conversation_mode ?? value.conversationMode) ?? sourceVia === "linux_voice_loop";
  const speakerName = optionalString(value.speaker_name) ?? optionalString(value.speakerName);
  const voiceId = optionalString(value.voice_id)
    ?? optionalString(value.voiceId)
    ?? (channel === "chat" ? speakerName : null);
  const transcriptConfidence = optionalConfidence(
    value.stt_confidence
    ?? value.sttConfidence
    ?? value.transcript_confidence
    ?? value.transcriptConfidence,
  );
  const speakerConfidence = optionalConfidence(
    value.speaker_confidence ?? value.speakerConfidence,
  );
  const trustedActorId = verifiedTransportActorId({
    channel,
    claimedVoiceId: voiceId,
    speakerConfidence,
    transportTrust,
  });

  return {
    schemaVersion: 1,
    transcript,
    ...(transcriptConfidence !== null ? { transcriptConfidence } : {}),
    room: optionalString(value.room),
    channel,
    sourceVia,
    ...(endpointValue(value.endpoint) ? { endpoint: endpointValue(value.endpoint) } : {}),
    sessionId: optionalString(value.session_id) ?? optionalString(value.sessionId),
    conversationMode,
    speaker: {
      name: speakerName,
      voiceId,
      confidence: speakerConfidence,
      trustedActorId,
      transportAuthenticated: transportTrust !== null,
      identitySource: trustedActorId ? transportTrust?.source ?? "none" : "none",
    },
    timing: timingValue(value.timing),
  };
}

function verifiedTransportActorId(options: {
  readonly channel: VoiceBrainChannel;
  readonly claimedVoiceId: string | null;
  readonly speakerConfidence: number | null;
  readonly transportTrust: {
    readonly actorId: string;
    readonly source: Exclude<VoiceBrainIdentitySource, "none">;
  } | null;
}): string | null {
  const transportActorId = canonicalHouseholdActorId(options.transportTrust?.actorId);
  const claimedActorId = canonicalHouseholdActorId(options.claimedVoiceId);
  if (!transportActorId || !claimedActorId) {
    return null;
  }
  // The household is open: the authenticated voice loop's speaker ID names
  // whichever of the owner, Sam or Alex is talking, at the trust bar. Typed chat has no voice to
  // recognise, so it stays the credential's own person.
  if (options.channel === "voice") {
    return options.transportTrust?.source === "api_token"
      && (options.speakerConfidence ?? 0) >= VOICE_TRUST_MIN_CONFIDENCE
      ? claimedActorId
      : null;
  }
  return options.channel === "chat" && claimedActorId === transportActorId ? transportActorId : null;
}

export function buildVoiceBrainResponse(options: {
  readonly text: string;
  readonly modelUsed?: boolean;
  readonly fishText?: string | null;
  readonly speechText?: string | null;
  readonly speechFishText?: string | null;
  readonly tone?: SpeechTone;
  readonly session: ResultSessionDirective;
  readonly route: VoiceBrainRouteMetadata;
  readonly tail?: VoiceBrainTailMetadata | null;
  readonly confirmBeep?: boolean;
  readonly musicAfter?: "hold";
  /** The turn was a question (not a command): the speaker listens again for a reply. */
  readonly listenAgain?: boolean;
}): VoiceBrainResponse {
  const text = nonEmptyString(options.text, "voice brain response text");
  const speechText = options.confirmBeep ? "" : optionalString(options.speechText) ?? formatForSpeech(text);
  const fishText = optionalString(options.fishText);
  const speechFishText = options.confirmBeep ? null : optionalString(options.speechFishText) ?? (fishText ? formatForSpeech(fishText) : null);
  const tail = options.tail ?? null;
  const kind = voiceResponseKind(options.route.status);
  return {
    ok: true,
    modelUsed: options.modelUsed === true,
    response: text,
    text,
    speech: {
      text: speechText,
      fish_text: speechFishText ?? speechText,
      ...(options.tone ? { tone: options.tone } : {}),
      ...(tail ? { lead_text: speechText, tail } : {}),
    },
    continue_session: options.session === "continue",
    session: {
      directive: options.session,
    },
    voice_response: {
      mode: options.confirmBeep ? "confirm_beep" : "speech",
      end_session: options.session === "close",
      expect_speech: options.session !== "close" && !options.confirmBeep && (options.listenAgain === true || expectsAnswer(text, kind)),
      ...(options.musicAfter ? { music_after: options.musicAfter } : {}),
      kind,
    },
    route: options.route,
  };
}

/** A reply that asks something: a clarifying question, a question mark, or "say it again". */
function expectsAnswer(text: string, kind: VoiceBrainResponse["voice_response"]["kind"]): boolean {
  return kind === "clarify" || /\?["'”’)]*\s*$/u.test(text) || /^say (?:it|that) again\b/iu.test(text.trim());
}

export function buildVoiceBrainErrorResponse(code: VoiceBrainErrorCode, message: string): VoiceBrainErrorResponse {
  const text = "I couldn't handle that cleanly.";
  return {
    ok: false,
    error: {
      code,
      message,
    },
    response: text,
    text,
    speech: {
      text,
    },
    continue_session: false,
    session: {
      directive: "close",
    },
    voice_response: {
      mode: "speech",
      end_session: true,
      kind: "error",
    },
  };
}

export function createDefaultVoiceBrainHandler(now: () => Date = () => new Date()): VoiceBrainHandler {
  return (request) => {
    const turnId = `voice-${now().toISOString()}`;
    return buildVoiceBrainResponse({
      text: defaultBrainNotWiredSentence(),
      session: request.conversationMode ? "continue" : "close",
      route: {
        route: "open_conversation",
        confidence: "low",
        status: "ok",
        resultId: null,
        turnId,
      },
    });
  };
}

function voiceResponseKind(status: VoiceBrainRouteMetadata["status"]): VoiceBrainResponse["voice_response"]["kind"] {
  switch (status) {
    case "ok":
      return "answer";
    case "clarify":
      return "clarify";
    case "declined":
      return "declined";
    case "error":
      return "error";
  }
}

function channelValue(value: string): VoiceBrainChannel {
  if (value === "voice" || value === "chat" || value === "test") {
    return value;
  }
  return "voice";
}

function timingValue(value: unknown): VoiceBrainTiming {
  if (value === undefined || value === null) {
    return {};
  }
  const timing = objectValue(value, "voice brain timing");
  return {
    ...(optionalNonNegativeNumber(timing.wake_ms ?? timing.wakeMs) !== null ? { wakeMs: optionalNonNegativeNumber(timing.wake_ms ?? timing.wakeMs) as number } : {}),
    ...(optionalNonNegativeNumber(timing.stt_ms ?? timing.sttMs) !== null ? { sttMs: optionalNonNegativeNumber(timing.stt_ms ?? timing.sttMs) as number } : {}),
    ...(optionalNonNegativeNumber(timing.speaker_ms ?? timing.speakerMs) !== null ? { speakerMs: optionalNonNegativeNumber(timing.speaker_ms ?? timing.speakerMs) as number } : {}),
  };
}

function endpointValue(value: unknown): VoiceBrainEndpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = optionalString(raw.id);
  if (!id) {
    return null;
  }
  const mediaPlayer = optionalString(raw.media_player) ?? optionalString(raw.mediaPlayer);
  return {
    id,
    name: optionalString(raw.name),
    mediaPlayer: mediaPlayer?.startsWith("media_player.") ? mediaPlayer : null,
    ...(raw.music_muted_by_turn === true ? { musicMutedByTurn: true } : {}),
    ...(raw.music_paused_by_turn === true ? { musicPausedByTurn: true } : {}),
  };
}

function firstNonEmptyString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const text = optionalString(value);
    if (text) {
      return text;
    }
  }
  return null;
}

function nonEmptyString(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalConfidence(value: unknown): number | null {
  const parsed = optionalNonNegativeNumber(value);
  if (parsed === null) {
    return null;
  }
  return Math.min(1, parsed);
}

function optionalNonNegativeNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("voice brain numeric field must be non-negative");
  }
  return parsed;
}
