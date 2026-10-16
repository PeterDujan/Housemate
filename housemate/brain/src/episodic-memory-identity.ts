import { HOUSE_TIME_ZONE } from "./house-config.js";
export const EPISODIC_MEMORY_TIMEZONE = HOUSE_TIME_ZONE;

const VERB_FORMS: Readonly<Record<string, readonly string[]>> = {
  attend: ["attend", "attended", "attending"],
  buy: ["buy", "bought", "buying"],
  bring: ["bring", "brought", "bringing"],
  call: ["call", "called", "calling"],
  catch: ["catch", "caught", "catching"],
  celebrate: ["celebrate", "celebrated", "celebrating", "celebration"],
  come: ["come", "came", "coming"],
  cook: ["cook", "cooked", "cooking"],
  cut: ["cut", "cutting"],
  do: ["do", "did", "done", "doing"],
  drink: ["drink", "drank", "drunk", "drinking"],
  drive: ["drive", "drove", "driven", "driving"],
  eat: ["eat", "ate", "eaten", "eating"],
  feed: ["feed", "fed", "feeding"],
  feel: ["feel", "felt", "feeling"],
  find: ["find", "found", "finding"],
  fly: ["fly", "flew", "flown", "flying"],
  get: ["get", "got", "gotten", "getting"],
  give: ["give", "gave", "given", "giving"],
  go: ["go", "went", "gone", "going"],
  have: ["have", "had", "having"],
  hear: ["hear", "heard", "hearing"],
  hold: ["hold", "held", "holding"],
  keep: ["keep", "kept", "keeping"],
  know: ["know", "knew", "known", "knowing"],
  leave: ["leave", "left", "leaving"],
  lose: ["lose", "lost", "losing"],
  make: ["make", "made", "making"],
  meet: ["meet", "met", "meeting"],
  pay: ["pay", "paid", "paying"],
  phone: ["phone", "phoned", "phoning"],
  put: ["put", "putting"],
  read: ["read", "reading"],
  receive: ["receive", "received", "receiving"],
  ride: ["ride", "rode", "ridden", "riding"],
  run: ["run", "ran", "running"],
  say: ["say", "said", "saying"],
  see: ["see", "saw", "seen", "seeing"],
  send: ["send", "sent", "sending"],
  sing: ["sing", "sang", "sung", "singing"],
  sit: ["sit", "sat", "sitting"],
  sleep: ["sleep", "slept", "sleeping"],
  speak: ["speak", "spoke", "spoken", "speaking"],
  spend: ["spend", "spent", "spending"],
  stand: ["stand", "stood", "standing"],
  stay: ["stay", "stayed", "staying"],
  swim: ["swim", "swam", "swum", "swimming"],
  take: ["take", "took", "taken", "taking"],
  tell: ["tell", "told", "telling"],
  throw: ["throw", "threw", "thrown", "throwing"],
  travel: ["travel", "traveled", "travelled", "traveling", "travelling"],
  visit: ["visit", "visited", "visiting"],
  wake: ["wake", "woke", "woken", "waking"],
  walk: ["walk", "walked", "walking"],
  watch: ["watch", "watched", "watching"],
  wear: ["wear", "wore", "worn", "wearing"],
  win: ["win", "won", "winning"],
  work: ["work", "worked", "working"],
  write: ["write", "wrote", "written", "writing"],
};

const VERB_CANONICAL = new Map<string, string>(
  Object.entries(VERB_FORMS).flatMap(([canonical, forms]) =>
    forms.map((form) => [form, canonical] as const)
  ),
);

/**
 * Episodes are occurrences, not single-value claim slots. The immutable source
 * occurrence keeps retries idempotent without pretending two similar events on
 * one day are contradictions.
 */
export function episodicMemoryOccurrenceClaimKey(
  subjectId: string,
  occurrenceRef: string,
): string | null {
  const subject = subjectId.trim().toLowerCase();
  const occurrence = occurrenceRef.trim().toLowerCase();
  return subject && occurrence
    ? `${subject}|episodic_occurrence|${occurrence}`
    : null;
}

export function canonicalEpisodicVerb(value: string): string {
  const normalized = value.trim().toLowerCase();
  const known = VERB_CANONICAL.get(normalized);
  if (known) return known;
  if (normalized.endsWith("ied") && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (normalized.endsWith("ed") && normalized.length > 3) {
    const stem = normalized.slice(0, -2);
    return stem.length > 2 && stem.at(-1) === stem.at(-2)
      ? stem.slice(0, -1)
      : stem;
  }
  return normalized;
}

export function episodicVerbForms(value: string): readonly string[] {
  const canonical = canonicalEpisodicVerb(value);
  return VERB_FORMS[canonical] ?? regularVerbForms(canonical);
}

export function episodicMemoryDateKey(
  occurredAt: string,
  timezone = EPISODIC_MEMORY_TIMEZONE,
): string | null {
  const instant = new Date(occurredAt);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((item) => item.type === type)?.value ?? "";
    const year = part("year");
    const month = part("month");
    const day = part("day");
    return /^\d{4}$/.test(year)
        && /^\d{2}$/.test(month)
        && /^\d{2}$/.test(day)
      ? `${year}-${month}-${day}`
      : null;
  } catch {
    return null;
  }
}

function regularVerbForms(canonical: string): readonly string[] {
  if (!canonical) return [];
  const forms = new Set([canonical]);
  if (canonical.endsWith("e")) {
    forms.add(`${canonical}d`);
    forms.add(`${canonical.slice(0, -1)}ing`);
  } else {
    forms.add(`${canonical}ed`);
    forms.add(`${canonical}ing`);
  }
  return [...forms];
}
