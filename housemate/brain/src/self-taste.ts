import type { SelfPreference, SelfTasteChange } from "./self-model.js";
import { householdRegex } from "./household.js";

/**
 * Code-owned answers about the assistant's own tastes, read straight from the
 * self-model store. No model: the same question gets
 * the stored stance every time, and the model reads the same records.
 *
 * Every answer needs an exact match to a stored record: a favourite label
 * ("My favourite colour:...") or a taste's whole subject. Anything else is
 * left to open chat.
 */

export type SelfTasteAnswerKind = "favourite" | "subject" | "reason" | "overview" | "changes";

export interface SelfTasteAnswer {
  readonly kind: SelfTasteAnswerKind;
  readonly text: string;
  readonly preferenceIds: readonly string[];
}

type FavouriteRank = "first" | "second" | "least";

interface FavouriteLabel {
  readonly rank: FavouriteRank;
  readonly noun: string;
  readonly body: string;
}

const LABEL_PATTERN = /^(my favourite|second favourite|least favourite|favourite)\s+([^:]{2,40}):\s*(.+)$/i;

/** Asked noun -> the noun his favourite labels use. */
const NOUN_SYNONYMS: readonly (readonly [RegExp, string])[] = [
  [/^(?:colou?r|colou?rs)$/, "colour"],
  [/^(?:film|films|movie|movies|flick)$/, "film"],
  [/^(?:book|books|novel|novels|read)$/, "novel"],
  [/^(?:band|bands|singer|singers|artist|artists|musician|musicians|group|music|act)$/, "musician"],
  [/^(?:album|albums|record|records)$/, "album"],
  [/^(?:(?:tv\s+)?show|shows|(?:tv\s+)?series|sitcom|comedy|comedy series|comedy show|tv|television|program|programme|tv program|tv programme)$/, "comedy series"],
  [/^(?:word|words)$/, "word"],
  [/^(?:name|names)$/, "names"],
  [/^(?:animal|animals|creature)$/, "animal"],
  [/^(?:season|seasons|time of year)$/, "season"],
  [/^(?:weather)$/, "weather"],
  [/^(?:day|day of the week|weekday)$/, "day of the week"],
  [/^(?:time of day|time of the day|part of the day|time)$/, "time of day"],
  [/^(?:room|room in the house|room in this house|part of the house)$/, "room"],
  [/^(?:place|places|spot|place in the world)$/, "place"],
  [/^(?:decade|decade for music|music decade|era of music|musical era|era)$/, "decade for music"],
];

const trailingFiller = (): RegExp => householdRegex(String.raw`\s+(?:then|{ASSISTANT}|mate|at the moment|right now|these days|at all|by the way|really|honestly|exactly|again)$`);

/** Answers a taste question from stored preferences, or null when no record owns it. */
export function selfTasteAnswer(
  preferences: readonly SelfPreference[],
  transcript: string,
  previousResponse: string | null = null,
): SelfTasteAnswer | null {
  const active = preferences.filter((preference) => preference.status === "active");
  if (active.length === 0) return null;
  const text = normalizeTaste(transcript);
  if (!text) return null;

  if (previousResponse && looksLikeBareWhy(text)) {
    const previous = previousTasteAnswer(active, previousResponse);
    if (previous) return reasonAnswer(previous);
  }

  const whyObject = matchFirst(text, [
    /^why (?:do|did) you (?:like|love|rate|enjoy|admire|prefer|pick|choose|hate|dislike|mind) (.+)$/,
    /^why (?:is|are) (.+?) (?:your|one of your) (?:second |least )?favou?rites?(?: .*)?$/,
    /^why (?:is|are) (.+?) your (?:pick|choice|thing)$/,
    /^what do you like about (.+)$/,
  ]);
  if (whyObject) {
    const preference = subjectMatch(active, whyObject);
    return preference ? reasonAnswer(preference) : null;
  }

  if (looksLikeOverview(text)) return overviewAnswer(active);

  const favourite = favouriteQuestion(text);
  if (favourite) {
    const match = favouriteMatch(active, favourite.rank, favourite.noun);
    if (!match) return null;
    return {
      kind: "favourite",
      text: capitalise(match.label.body),
      preferenceIds: [match.preference.id],
    };
  }

  const object = matchFirst(text, [
    /^(?:do|did) you (?:really |actually |even )?(?:like|love|enjoy|rate|admire|mind|dig|hate|dislike) (.+)$/,
    /^what do you (?:really |actually )?(?:think|reckon) (?:of|about) (.+)$/,
    /^how do you feel about (.+)$/,
    /^(?:what s|what is|whats) your (?:view|take|opinion|stance|verdict) on (.+)$/,
    /^(?:what s|what is|whats) your (?:view|take|opinion|stance|verdict) of (.+)$/,
    /^are you (?:a fan of|into) (.+)$/,
    /^your thoughts on (.+)$/,
  ]);
  if (object) {
    const preference = subjectMatch(active, object);
    if (!preference) return null;
    return { kind: "subject", text: subjectText(preference), preferenceIds: [preference.id] };
  }
  return null;
}

/**
 * The compact taste list for every open chat:
 * every labelled favourite, then the strongest of the rest, one line each.
 */
export function compactTasteDigest(preferences: readonly SelfPreference[], limit = 30): string {
  const active = preferences.filter((preference) => preference.status === "active");
  const rankOrder: Record<FavouriteRank, number> = { first: 0, second: 1, least: 2 };
  const favourites = active
    .map((preference) => ({ preference, label: favouriteLabel(preference) }))
    .filter((item): item is { preference: SelfPreference; label: FavouriteLabel } => item.label !== null)
    .sort((left, right) => rankOrder[left.label.rank] - rankOrder[right.label.rank])
    .map((item) => item.preference);
  const rest = active
    .filter((preference) => favouriteLabel(preference) === null)
    .sort((left, right) => right.strength - left.strength
      || right.confidence - left.confidence
      || left.id.localeCompare(right.id));
  return [...favourites, ...rest]
    .slice(0, Math.max(1, limit))
    // A labelled stance names its own subject: "- My favourite colour: petrol blue...".
    .map((preference) => `- ${favouriteLabel(preference) ? "" : `${preference.subject}: `}${clip(preference.stance, 120)}`)
    .join("\n");
}

/**
 * The active taste that already owns a subject (plan rule 4), so a chat
 * opinion never becomes a rival record. Whole-subject matches only, or a
 * "favourite colour" subject when a taste is labelled his favourite colour.
 */
export function tasteOwningSubject(preferences: readonly SelfPreference[], subject: string): SelfPreference | null {
  const active = preferences.filter((preference) => preference.status === "active");
  const text = normalizeTaste(subject);
  const favourite = matchGroups(text, [householdRegex(String.raw`^(?:(?:{ASSISTANT} s|s|his|my|your) )?(second |least )?favou?rite (.+)$`)]);
  if (favourite) {
    const rank = (favourite[0] ?? "").trim();
    const noun = canonicalNoun(favourite[1] ?? "");
    const match = noun
      ? favouriteMatch(active, rank === "second" ? "second" : rank === "least" ? "least" : "first", noun)
      : null;
    if (match) return match.preference;
  }
  return subjectMatch(active, text);
}

/**
 * "Has anything changed about you lately?" read from the change log
 * newest first. Null when the question is not
 * about his own tastes changing; an empty log still gets an answer.
 */
export function selfTasteChangesAnswer(
  readChanges: () => readonly SelfTasteChange[],
  transcript: string,
): SelfTasteAnswer | null {
  if (!looksLikeChangesQuestion(normalizeTaste(transcript))) return null;
  const changes = readChanges();
  if (changes.length === 0) {
    return { kind: "changes", text: "Nothing's changed lately. My tastes are where they were.", preferenceIds: [] };
  }
  const shown = changes.slice(0, 2);
  const lines = shown.map((change) => {
    if (change.kind === "retired") return `I've let ${change.subject} go.`;
    const label = LABEL_PATTERN.exec(change.stanceAfter.trim());
    if (label) {
      // "My favourite colour is now teal..." rather than reading the label out.
      const lead = (label[1] ?? "").toLowerCase().replace(/^favourite/, "my favourite");
      const noun = (label[2] ?? "").trim().toLowerCase();
      return `${capitalise(lead)} ${noun} ${noun === "names" ? "are" : "is"} now ${clip(label[3] ?? "", 200)}`;
    }
    // Stances often lead with their subject ("Arrival: still great...").
    const prefix = `${change.subject}:`;
    const body = change.stanceAfter.trim().toLowerCase().startsWith(prefix.toLowerCase())
      ? change.stanceAfter.trim().slice(prefix.length)
      : change.stanceAfter;
    const stance = capitalise(clip(body, 220));
    if (change.kind === "added") return `${change.subject} is new for me. ${stance}`;
    if (change.kind === "restored") return `${change.subject} is back. ${stance}`;
    return `I've shifted on ${change.subject}. ${stance}`;
  });
  const more = changes.length - shown.length;
  const tail = more > 0 ? ` And ${more === 1 ? "one more" : `${more} more`} besides.` : "";
  return {
    kind: "changes",
    text: `${lines.map((line) => /[.!?…]$/.test(line) ? line : `${line}.`).join(" ")}${tail}`,
    preferenceIds: shown.map((change) => change.preferenceId),
  };
}

/**
 * Active tastes whose whole subject appears as words in the text ("I've been
 * playing Nick Cave all week" names Nick Cave). Never a partial word match.
 */
export function tastesNamedIn(preferences: readonly SelfPreference[], text: string): readonly SelfPreference[] {
  const padded = ` ${normalizeTaste(text)} `;
  if (padded.trim().length < 3) return [];
  const spans = preferences
    .filter((preference) => preference.status === "active")
    .map((preference) => ({
      preference,
      spans: [...subjectKeys(preference.subject, true)].flatMap((key) => {
        const found: { start: number; end: number }[] = [];
        for (let at = padded.indexOf(` ${key} `); at >= 0; at = padded.indexOf(` ${key} `, at + 1)) {
          found.push({ start: at + 1, end: at + 1 + key.length });
        }
        return found;
      }),
    }))
    .filter((item) => item.spans.length > 0);
  // "petrol blue" names Petrol blue, not also Blues.
  return spans
    .filter((item) => item.spans.some((span) => !spans.some((other) => other !== item
      && other.spans.some((wider) => wider.start <= span.start && wider.end >= span.end
        && wider.end - wider.start > span.end - span.start))))
    .map((item) => item.preference);
}

/** The text form taste matching uses, for code that keys records the same way. */
export function tasteMatchKey(value: string): string {
  return withoutArticle(normalizeTaste(value));
}

function favouriteQuestion(text: string): { rank: FavouriteRank; noun: string } | null {
  const match = matchGroups(text, [
    /^(?:(?:what|which|who) (?:s|is|are|would be|d be) )?your (second |least )?favou?rite (.+)$/,
    /^(?:what|which|who) (?:s|is|are) (?:your|the) (second |least )?favou?rite (.+?)(?: of yours)?$/,
    /^(?:do|have) you (?:got |have )?(?:a|any) (second |least )?favou?rite (.+)$/,
    /^tell me your (second |least )?favou?rite (.+)$/,
  ]);
  if (!match) {
    const best = matchGroups(text, [/^(?:what|which) (.+?) do you (?:like|love|rate) (best|most|least)$/]);
    if (!best) return null;
    const noun = canonicalNoun(best[0] ?? "");
    return noun ? { rank: best[1] === "least" ? "least" : "first", noun } : null;
  }
  const rank = (match[0] ?? "").trim();
  const noun = canonicalNoun(match[1] ?? "");
  if (!noun) return null;
  return { rank: rank === "second" ? "second" : rank === "least" ? "least" : "first", noun };
}

function favouriteMatch(
  preferences: readonly SelfPreference[],
  rank: FavouriteRank,
  noun: string,
): { preference: SelfPreference; label: FavouriteLabel } | null {
  const matches = preferences
    .map((preference) => ({ preference, label: favouriteLabel(preference) }))
    .filter((item): item is { preference: SelfPreference; label: FavouriteLabel } =>
      item.label !== null && item.label.rank === rank && canonicalNoun(item.label.noun) === noun)
    .sort((left, right) => right.preference.strength - left.preference.strength);
  return matches[0] ?? null;
}

function favouriteLabel(preference: SelfPreference): FavouriteLabel | null {
  const match = LABEL_PATTERN.exec(preference.stance.trim());
  if (!match) return null;
  const lead = (match[1] ?? "").toLowerCase();
  return {
    rank: lead.startsWith("second") ? "second" : lead.startsWith("least") ? "least" : "first",
    noun: (match[2] ?? "").trim().toLowerCase(),
    body: (match[3] ?? "").trim(),
  };
}

function canonicalNoun(raw: string): string | null {
  const phrase = trimFiller(raw)
    .replace(/^(?:kind|type|sort) of /, "")
    .replace(/^(?:the|a|an) /, "")
    .trim();
  if (!phrase) return null;
  for (const [pattern, noun] of NOUN_SYNONYMS) if (pattern.test(phrase)) return noun;
  return phrase;
}

/** A taste whose whole subject is the asked thing; never a partial word match. */
function subjectMatch(preferences: readonly SelfPreference[], rawObject: string): SelfPreference | null {
  const object = withoutArticle(trimFiller(rawObject));
  if (object.length < 3) return null;
  const candidates = preferences.filter((preference) => subjectKeys(preference.subject).has(object));
  candidates.sort((left, right) => right.strength - left.strength || left.id.localeCompare(right.id));
  return candidates[0] ?? null;
}

/**
 * A subject's whole-phrase keys. Asked about directly, "the blues" may be
 * said "blue"; spotted in free text (`inText`) only the plural is added, so
 * "green-blue" never names Blues, and a leading "the" stays.
 */
function subjectKeys(subject: string, inText = false): ReadonlySet<string> {
  const keys = new Set<string>();
  const add = (value: string) => {
    // In free text a title keeps its article: "wire something in" is not The Wire.
    const key = inText ? normalizeTaste(value) : withoutArticle(normalizeTaste(value));
    if (key.length >= 3) {
      keys.add(key);
      if (!key.endsWith("s")) keys.add(`${key}s`);
      else if (!inText) keys.add(key.slice(0, -1));
    }
  };
  add(subject);
  // "Cathy Freeman, Sydney 2000" and "Possum Magic by Mem Fox" are also
  // asked about by their head.
  const head = subject.split(/,| by | from /i)[0] ?? "";
  if (head !== subject) add(head);
  return keys;
}

function previousTasteAnswer(preferences: readonly SelfPreference[], previousResponse: string): SelfPreference | null {
  const said = normalizeTaste(previousResponse);
  if (!said) return null;
  for (const preference of preferences) {
    const label = favouriteLabel(preference);
    if (normalizeTaste(preference.stance) === said) return preference;
    if (label && normalizeTaste(label.body) === said) return preference;
  }
  return null;
}

/** "That's my favourite film. Blade Runner,..." rather than reading the label out. */
function subjectText(preference: SelfPreference): string {
  const label = favouriteLabel(preference);
  if (!label) return preference.stance;
  const rank = label.rank === "second" ? "second favourite" : label.rank === "least" ? "least favourite" : "favourite";
  const lead = label.noun === "names" ? `Those are my ${rank} ${label.noun}.` : `That's my ${rank} ${label.noun}.`;
  return `${lead} ${capitalise(label.body)}`;
}

function reasonAnswer(preference: SelfPreference): SelfTasteAnswer {
  return { kind: "reason", text: capitalise(preference.rationale), preferenceIds: [preference.id] };
}

function overviewAnswer(preferences: readonly SelfPreference[]): SelfTasteAnswer | null {
  const picks: SelfPreference[] = [];
  for (const noun of ["colour", "musician", "film", "novel"]) {
    const match = favouriteMatch(preferences, "first", noun);
    if (match) picks.push(match.preference);
  }
  if (picks.length < 2) return null;
  const names = picks.map((preference) => leadName(preference));
  const list = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return {
    kind: "overview",
    text: `A few of mine: ${list}.`,
    preferenceIds: picks.map((preference) => preference.id),
  };
}

/** "petrol blue" from "My favourite colour: petrol blue — that deep...". */
function leadName(preference: SelfPreference): string {
  const label = favouriteLabel(preference);
  if (!label) return preference.subject;
  const subject = normalizeTaste(preference.subject);
  return normalizeTaste(label.body).startsWith(subject) ? label.body.slice(0, preference.subject.length) : preference.subject;
}

function looksLikeOverview(text: string): boolean {
  return /^(?:what (?:are|re) (?:some of )?your (?:favou?rites|favou?rite things|tastes|likes)|tell me (?:about )?(?:some of )?your (?:favou?rites|favou?rite things|tastes)|what (?:sort|kind) of things do you like|what are you into)$/.test(text);
}

function looksLikeChangesQuestion(text: string): boolean {
  const trimmed = trimFiller(text.replace(/ (?:lately|recently|of late)$/, ""));
  return /^(?:has|have) (?:anything|much) changed (?:about you|for you|with you|in your tastes)$/.test(trimmed)
    || /^(?:has|have) (?:any of )?your (?:tastes|favou?rites|opinions) changed$/.test(trimmed)
    || /^(?:what s|what has|what have|whats) changed (?:about you|in your tastes|with your tastes|in your favou?rites)$/.test(trimmed)
    || /^(?:have you|did you|you) changed your mind (?:about|on) (?:anything|something)$/.test(trimmed)
    || /^(?:what|anything) (?:have you|did you) changed your mind (?:about|on)$/.test(trimmed)
    || /^(?:have|did) your tastes change$/.test(trimmed);
}

function looksLikeBareWhy(text: string): boolean {
  return /^(?:why|why s that|why is that|why that|why that one|why them|why him|why her|how come|what makes (?:it|that|them) (?:so )?(?:good|great|special)|why do you like (?:it|that|them|him|her))$/.test(text);
}

function matchFirst(text: string, patterns: readonly RegExp[]): string | null {
  const groups = matchGroups(text, patterns);
  return groups ? (groups[0] ?? null) : null;
}

function matchGroups(text: string, patterns: readonly RegExp[]): readonly (string | undefined)[] | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match.slice(1);
  }
  return null;
}

function trimFiller(value: string): string {
  let current = value.trim();
  for (let previous = ""; previous !== current;) {
    previous = current;
    current = current.replace(trailingFiller(), "").trim();
  }
  return current;
}

function withoutArticle(value: string): string {
  return value.replace(/^(?:the|a|an) /, "").trim();
}

function normalizeTaste(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(householdRegex(String.raw`^(?:hey |ok |okay |so |and |but )?(?:{ASSISTANT} )?`), "")
    .replace(/\b(?:fave|favo)\b/g, "favourite")
    .trim();
}

function capitalise(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

function clip(value: string, maximum: number): string {
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length <= maximum) return clean;
  const cut = clean.slice(0, maximum - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length).replace(/[\s,;:—-]+$/, "")}…`;
}
