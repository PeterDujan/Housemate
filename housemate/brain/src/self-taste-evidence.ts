import type { SelfPreference } from "./self-model.js";
import { tasteMatchKey, tastesNamedIn } from "./self-taste.js";
import { assistantName } from "./persona.js";

/**
 * Evidence about the assistant's tastes, found by code in ordinary turns
 *. No model: a turn either names a stored taste or a
 * played artist, or it does not. The weekly review reads these rows; code
 * nudges use them between reviews.
 */

export type TasteEvidenceKind = "mention" | "asked" | "pushback" | "agreement" | "played" | "chat_opinion";

export const TASTE_EVIDENCE_KINDS: readonly TasteEvidenceKind[] = [
  "mention", "asked", "pushback", "agreement", "played", "chat_opinion",
];

export interface TasteEvidenceObservation {
  /** The stored taste this is about; null for a played artist with no taste yet. */
  readonly preferenceId: string | null;
  readonly subject: string;
  readonly kind: TasteEvidenceKind;
  readonly summary: string;
}

export interface TasteTurnInput {
  readonly preferences: readonly SelfPreference[];
  readonly transcript: string;
  readonly route: string;
  readonly status: string;
  /** Tastes the code taste route spoke this turn. */
  readonly askedPreferenceIds: readonly string[];
  readonly previous: { readonly transcript: string; readonly responseText: string; readonly route?: string } | null;
  /** A track the assistant started on the speaker's player this turn. */
  readonly played: { readonly track: string; readonly artist: string | null } | null;
}

const SUMMARY_LIMIT = 160;

// About the assistant's pick, not the thing itself: "you're wrong", "good choice".
const PUSHBACK_PATTERN = /\b(?:you re wrong|you are wrong|that s wrong|wrong about|disagree|don t agree|do not agree|(?:bad|terrible|awful|poor|questionable|rubbish|shocking|horrible) (?:taste|choice|pick|call)|how can you (?:like|love|rate))\b/;
const AGREEMENT_PATTERN = /\b(?:(?:good|great|excellent|nice|top|solid|impeccable) (?:taste|choice|pick|call)|i agree|agreed|me too|same here|spot on|couldn t agree more|you re right|you are right|i (?:love|like|rate) (?:it|that|them|him|her) too)\b/;
const ASKS_HIS_VIEW = /\byou(?:r)?\b.*\b(?:favou?rite|like|love|rate|think|reckon|opinion|view|take|fan|into|feel|prefer)\b/;

export function tasteEvidenceFromTurn(input: TasteTurnInput): readonly TasteEvidenceObservation[] {
  if (input.status === "error") return [];
  const active = input.preferences.filter((preference) => preference.status === "active");
  const byId = new Map(active.map((preference) => [preference.id, preference]));
  const out: TasteEvidenceObservation[] = [];
  const said = clip(input.transcript);

  for (const id of input.askedPreferenceIds) {
    const preference = byId.get(id);
    if (preference) out.push({ preferenceId: id, subject: preference.subject, kind: "asked", summary: `Asked: ${said}` });
  }

  const named = tastesNamedIn(active, input.transcript);
  if (input.route === "open_conversation") {
    for (const preference of named) {
      // Saying "fair enough" uses a word he likes; it is not talk about it.
      if (preference.category === "words" || input.askedPreferenceIds.includes(preference.id)) continue;
      out.push({ preferenceId: preference.id, subject: preference.subject, kind: "mention", summary: `Said: ${said}` });
    }
  }

  const reaction = reactionKind(input.transcript);
  if (reaction) {
    const targets = named.length > 0 ? named : previousTaste(active, input.previous);
    for (const preference of targets) {
      out.push({ preferenceId: preference.id, subject: preference.subject, kind: reaction, summary: `Said: ${said}` });
    }
  }

  if (input.played && input.route === "music_playback") {
    const label = `${input.played.track}${input.played.artist ? ` by ${input.played.artist}` : ""}`;
    const summary = clip(`Played ${label} on ${assistantName()}`);
    const owners = active.filter((preference) => preference.category === "music" && playedMatches(preference.subject, input.played!));
    for (const preference of owners) {
      out.push({ preferenceId: preference.id, subject: preference.subject, kind: "played", summary });
    }
    if (owners.length === 0 && input.played.artist?.trim()) {
      out.push({ preferenceId: null, subject: input.played.artist.trim().slice(0, 80), kind: "played", summary });
    }
  }
  return out;
}

/** The key an artist with no taste is counted under, so plays on different days add up. */
export function candidateSubjectKey(subject: string): string {
  return `artist:${tasteMatchKey(subject)}`;
}

function reactionKind(transcript: string): "pushback" | "agreement" | null {
  const text = tasteMatchKey(transcript);
  if (PUSHBACK_PATTERN.test(text)) return "pushback";
  if (AGREEMENT_PATTERN.test(text)) return "agreement";
  return null;
}

/** A bare "good choice" reacts to the last reply only when it gave one taste in answer to his view. */
function previousTaste(
  preferences: readonly SelfPreference[],
  previous: TasteTurnInput["previous"],
): readonly SelfPreference[] {
  if (!previous || (previous.route !== undefined && previous.route !== "open_conversation")) return [];
  if (!ASKS_HIS_VIEW.test(tasteMatchKey(previous.transcript))) return [];
  const named = tastesNamedIn(preferences, previous.responseText);
  return named.length === 1 ? named : [];
}

/** The track or album title is the subject, or the artist is (or leads) it: "Nick Cave & The Bad Seeds". */
function playedMatches(subject: string, played: { readonly track: string; readonly artist: string | null }): boolean {
  const key = tasteMatchKey(subject);
  if (key.length < 3) return false;
  const track = tasteMatchKey(played.track.replace(/\s+[-([].*$/, ""));
  if (track === key) return true;
  const artist = tasteMatchKey(played.artist ?? "");
  if (!artist) return false;
  return artist === key || (key.includes(" ") && artist.startsWith(`${key} `));
}

function clip(value: string): string {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length <= SUMMARY_LIMIT ? clean : `${clean.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`;
}
