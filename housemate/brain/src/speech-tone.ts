import type { HaEntityState } from "./ha-state-cache.js";
import type { RoutingDialogueAct } from "./routing-text.js";

/**
 * The assistant's spoken tone. Code picks it from typed facts (route, dialogue act,
 * source readings); no model sets it. Open chat instead carries the model's
 * vetted inline Fish tags (MODEL_DELIVERY_TAGS). The Voice Loop maps a tone to
 * a delivery cue, and a segment without a tone is spoken neutrally. These seven only, never angry; night and
 * speaker do not change tone.
 */
export const SPEECH_TONES = ["neutral", "warm", "dry", "amused", "concerned", "sombre", "bright"] as const;
export type SpeechTone = (typeof SPEECH_TONES)[number];

/** Personality tails are the assistant's aside after the answer. */
export const PERSONALITY_TAIL_TONE: SpeechTone = "dry";

const DIALOGUE_ACT_TONES: Partial<Record<RoutingDialogueAct, SpeechTone>> = {
  greet: "warm",
  check_in: "warm",
  goodbye: "warm",
  gratitude: "warm",
  apology: "warm",
  compliment: "bright",
};

export function dialogueActTone(act: RoutingDialogueAct): SpeechTone {
  return DIALOGUE_ACT_TONES[act] ?? "neutral";
}

const ALERT_BINARY_SENSOR_CLASSES = new Set([
  "carbon_monoxide",
  "gas",
  "heat",
  "moisture",
  "problem",
  "safety",
  "smoke",
  "tamper",
]);

/**
 * True when the live state is a household alert worth sounding concerned
 * about: an open garage door, or an alert-class binary sensor that is on.
 * Only Home Assistant's own domain, device class and state count.
 */
export function entityStateIsAlert(state: HaEntityState): boolean {
  const domain = state.entityId.split(".", 1)[0] ?? "";
  const deviceClass = typeof state.attributes?.device_class === "string"
    ? state.attributes.device_class.trim().toLowerCase()
    : "";
  const value = String(state.state ?? "").trim().toLowerCase();
  if (domain === "binary_sensor") {
    return value === "on" && (deviceClass === "garage_door" || ALERT_BINARY_SENSOR_CLASSES.has(deviceClass));
  }
  if (domain === "cover" && deviceClass === "garage") {
    return value === "open" || value === "opening";
  }
  return false;
}

/** An entity-status answer sounds concerned when any source state it read is an alert. */
export function entityStatusTone(states: readonly HaEntityState[]): SpeechTone {
  return states.some(entityStateIsAlert) ? "concerned" : "neutral";
}

/**
 * The final tone for a finished turn. A tone the answering code set wins;
 * otherwise an ok entity-status answer is judged from the states it read.
 * Declines, clarifiers, errors and figures stay neutral.
 */
export function speechToneForResult(
  result: {
    readonly route: string;
    readonly status: string;
    readonly tone?: SpeechTone;
    readonly contextFrame?: unknown;
  },
  readState: (entityId: string) => HaEntityState | null,
): SpeechTone {
  if (result.status !== "ok") {
    return "neutral";
  }
  if (result.tone) {
    return result.tone;
  }
  if (result.route === "entity_status") {
    const states = entityStatusFrameIds(result.contextFrame)
      .map(readState)
      .filter((state): state is HaEntityState => state !== null);
    return entityStatusTone(states);
  }
  return "neutral";
}

function entityStatusFrameIds(frame: unknown): readonly string[] {
  if (!frame || typeof frame !== "object") {
    return [];
  }
  const record = frame as { readonly kind?: unknown; readonly target?: { readonly entityIds?: unknown } };
  if (record.kind !== "entity_status" || !Array.isArray(record.target?.entityIds)) {
    return [];
  }
  return record.target.entityIds.filter((id): id is string => typeof id === "string");
}

/**
 * Open chat only: the model writes Fish S2 delivery
 * tags inline, right before the words they colour ("Oh [sighing] fine.
 * [chuckling] Love you too, mate."). Only tags on this list survive; any other
 * letter-led bracket span (such as "[smug]" or "[smirking tone isn't valid
 * so]") is dropped before speech. Segment text
 * stays clean for logs, history and Home Assistant; the tagged copy goes only
 * to Fish as `fish_text`. List from docs.fish.audio emotion control; the owner
 * allows all of it except the crowd-noise tags. House answers
 * keep their code-picked tone.
 */
export const MODEL_DELIVERY_TAGS = [
  // Basic emotions
  "happy", "sad", "angry", "excited", "calm", "nervous", "confident", "surprised", "satisfied",
  "delighted", "scared", "worried", "upset", "frustrated", "depressed", "empathetic", "embarrassed",
  "disgusted", "moved", "proud", "relaxed", "grateful", "curious", "sarcastic",
  // Advanced emotions
  "disdainful", "unhappy", "anxious", "hysterical", "indifferent", "uncertain", "doubtful", "confused",
  "disappointed", "regretful", "guilty", "ashamed", "jealous", "envious", "hopeful", "optimistic",
  "pessimistic", "nostalgic", "lonely", "bored", "contemptuous", "sympathetic", "compassionate",
  "determined", "resigned",
  // Tone markers
  "in a hurry tone", "shouting", "screaming", "whispering", "soft tone", "emphasis",
  // Sounds
  "laughing", "chuckling", "sobbing", "crying loudly", "sighing", "groaning", "panting", "gasping",
  "yawning", "snoring", "clear throat",
  // Pauses
  "break", "long-break",
] as const;
const MODEL_DELIVERY_TAG_SET: ReadonlySet<string> = new Set(MODEL_DELIVERY_TAGS);

export const MODEL_DELIVERY_TAG_INSTRUCTION =
  "Your words are performed by a voice that takes inline delivery tags in square brackets. "
  + "Put a tag right before the words it colours, the way an actor's script marks delivery: "
  + "[sarcastic] on a sarcastic line, [chuckling] before a joke lands, [sighing] before a resigned remark, [emphasis] on the word that matters, [break] for a beat. "
  + "Use one only where the delivery differs from your plain speaking voice: most replies need one or none, never more than three in a sentence, and plain information gets none. "
  + "Never open a reply with a tag out of habit, and don't reach for the same tag reply after reply. "
  + `Use only these tags: ${MODEL_DELIVERY_TAGS.map((tag) => `[${tag}]`).join(" ")}. `
  + "Never invent other tags and never end the reply with a tag. The tags are performed, not read out.";

// Any letter-led bracket span up to 60 characters is the model talking about
// delivery, listed or not; only listed tags survive. 
// "[smirking tone isn't valid so]" reached Fish, the display and history.
// Brackets that open with a digit or symbol ("[3/5]") are content and stay.
const MODEL_TAG_INNER = /^[a-z][^[\]\n]{0,59}$/iu;
const MODEL_TAG_MAX_PENDING = 62;
const MODEL_TAG_ANYWHERE = /\[\s*[a-z][^[\]\n]{0,59}\]/giu;

/**
 * Streaming tag filter. Push returns the delta with listed tags kept (in
 * canonical lower case) and every other bracket word-tag removed; a partial
 * "[..." is held until it closes or proves not to be a tag, so streamed and
 * whole-text filtering produce the same text.
 */
export class ModelDeliveryTagFilter {
  private pending = "";

  push(delta: string): string {
    let rest = this.pending + String(delta ?? "");
    this.pending = "";
    let out = "";
    while (rest) {
      const open = rest.indexOf("[");
      if (open < 0) {
        out += rest;
        break;
      }
      out += rest.slice(0, open);
      rest = rest.slice(open);
      const close = rest.indexOf("]");
      const reopen = rest.indexOf("[", 1);
      if (reopen >= 0 && (close < 0 || reopen < close)) {
        // "[a [sighing]": the first bracket never closes; judge the inner one.
        out += rest.slice(0, reopen);
        rest = rest.slice(reopen);
        continue;
      }
      if (close < 0) {
        if (rest.length <= MODEL_TAG_MAX_PENDING) {
          this.pending = rest;
        } else {
          out += rest;
        }
        break;
      }
      const inner = rest.slice(1, close).trim();
      if (close <= MODEL_TAG_MAX_PENDING && MODEL_TAG_INNER.test(inner)) {
        const label = inner.toLowerCase().replaceAll(/\s+/gu, " ");
        if (MODEL_DELIVERY_TAG_SET.has(label)) {
          out += `[${label}]`;
        }
        rest = rest.slice(close + 1);
        continue;
      }
      out += rest.slice(0, close + 1);
      rest = rest.slice(close + 1);
    }
    return out;
  }

  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return rest;
  }
}

/** Whole-text form of ModelDeliveryTagFilter; a tag left dangling at the very end is dropped. */
export function filterModelDeliveryTags(text: string): string {
  const filter = new ModelDeliveryTagFilter();
  return (filter.push(text) + filter.flush()).replace(/(?:\s*\[[a-z][a-z -]{0,23}\])+\s*$/iu, "").trimEnd();
}

/** The words alone: every bracket word-tag removed, for display, logs and history. */
export function stripDeliveryTags(text: string): string {
  return String(text ?? "")
    .replaceAll(MODEL_TAG_ANYWHERE, " ")
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/\s+([.,;:!?])/gu, "$1")
    .trim();
}
