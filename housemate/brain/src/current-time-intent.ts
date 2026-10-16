import { normalizeQuestionLeadIn } from "./routing-text.js";
import { HOUSE_TIME_ZONE } from "./house-config.js";

export const BASIC_CURRENT_TIMEZONE = HOUSE_TIME_ZONE;

export type CurrentTimeField = "time" | "day" | "date";

export interface CurrentTimeIntent {
  readonly field: CurrentTimeField;
  readonly timezone: typeof BASIC_CURRENT_TIMEZONE;
}

const CLOCK_RETRIEVAL_REQUEST = "(?:check|read|get me|tell me|give me|show me|can (?:you )?(?:tell|give|show|get) me|could (?:you )?(?:tell|give|show|get) me|can i (?:get|have)|could i (?:get|have))";

/**
 * Own only this household's clock. An absent scope or an explicitly local
 * Sydney scope is valid; another location, person, event, or subject is not.
 */
export function parseCurrentTimeIntent(normalized: string): CurrentTimeIntent | null {
  const stripped = normalizeTypedTimeText(normalized);
  if (!stripped || hasNonClockSubject(stripped)) {
    return null;
  }

  const day = matchScopedRequest(stripped, [
    /^what day is it(?: today)?(?: (?:in|for) (.+)| (here))?$/,
    /^what day is today(?: (?:in|for) (.+)| (here))?$/,
    /^what day are we on(?: (?:in|for) (.+)| (here))?$/,
  ]);
  if (day) {
    return currentTimeIntent("day");
  }

  const date = matchScopedRequest(stripped, [
    /^which day is today(?: (?:in|for) (.+)| (here))?$/,
    /^what date is (?:it|today)(?: (?:in|for) (.+)| (here))?$/,
    /^what date are we on(?: (?:in|for) (.+)| (here))?$/,
    /^what is (?:the )?(?:(?:current|local|current local) )?date(?: today)?(?: (?:in|for) (.+)| (here))?$/,
    /^what is today s date(?: (?:in|for) (.+)| (here))?$/,
    /^what day of the month is it(?: (?:in|for) (.+)| (here))?$/,
    new RegExp(`^${CLOCK_RETRIEVAL_REQUEST} (?:the )?(?:(?:current|local|current local) )?(?:today s )?date(?: (?:in|for) (.+)| (here))?$`),
    /^what date (?:do we have|have we got)$/,
    /^(?:the )?(?:(?:current|local|current local) )?(?:today s )?date(?: (?:in|for) (.+)| (here))?$/,
    /^(.+?) date$/,
  ]);
  if (date) {
    return currentTimeIntent("date");
  }

  const clock = matchScopedRequest(stripped, [
    /^what time is it(?: (?:in|for) (.+)| (here))?$/,
    /^what is (?:the )?(?:current )?(?:local )?(?:time|clock)(?: (?:in|for) (.+)| (here))?$/,
    new RegExp(`^${CLOCK_RETRIEVAL_REQUEST} (?:the )?(?:current )?(?:local )?(?:time|clock(?: time)?)(?: (?:in|for) (.+)| (here))?$`),
    /^what time (?:do we have|have we got)$/,
    /^what does (?:the )?clock (?:say|read)(?: (?:in|for) (.+))?$/,
    /^(?:the )?(?:current )?(?:local )?(?:time|clock(?: time)?)$/,
    /^(?:time|clock) (?:in|for) (.+)$/,
    /^(.+?) (?:time|clock)$/,
  ]);
  if (!clock) {
    return null;
  }
  return currentTimeIntent("time");
}


function normalizeTypedTimeText(normalized: string): string {
  const text = normalizeQuestionLeadIn(normalized)
    .replace(/[/_,:-]+/g, " ")
    .replace(/\b(?:right now|now)\b(?=\s+(?:in|for)\b)/g, " ")
    .replace(/(?:(?:please|thanks|thank you|cheers|mate|right now|now|again)\s*)+$/g, "")
    .replace(/\s+for me$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripClockRetrievalScaffolding(text);
}

/** Remove who asked and who receives the answer; retain the clock proposition. */
function stripClockRetrievalScaffolding(value: string): string {
  let text = value;
  for (let index = 0; index < 4; index += 1) {
    const next = text
      .replace(/^(?:do|does|did) (?:you|we) know\s+/, "")
      .replace(/^(?:can|could|would) (?:i|we) (?:get|have)\s+/, "")
      .replace(/^(?:can|could|would|will) (?:you|we|i)\s+/, "")
      .replace(/^(?:check|read|get|tell|give|show|say|repeat)(?: (?:me|us))?\s+/, "")
      .replace(/^(?:let (?:me|us) (?:know|have|get))\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (next === text) break;
    text = next;
  }
  return text
    .replace(/^what (time|date|day) it is\b/, "what $1 is it")
    .replace(/^what ((?:the |today s |current |local )*(?:date|day)) is(?=$| (?:in|for|here)\b)/, "what is $1")
    .replace(/\s+/g, " ")
    .trim();
}

function matchScopedRequest(text: string, patterns: readonly RegExp[]): boolean {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) {
      continue;
    }
    const scopes = match.slice(1).filter((value): value is string => typeof value === "string" && value.trim() !== "");
    return scopes.length === 0 || scopes.every(isLocalCurrentTimeScope);
  }
  return false;
}

function isLocalCurrentTimeScope(value: string): boolean {
  const scope = value
    .replace(/^(?:the )/, "")
    .replace(/\s+/g, " ")
    .trim();
  return LOCAL_SCOPE.test(scope);
}

function hasNonClockSubject(text: string): boolean {
  return /\b(?:about|book|film|movie|novel|story|machine|power|energy|electricity|watts?|wattage|load|draw|drawing|usage|solar|grid|battery|school|work|lesson|lessons|practice|pickup|pick up|drop off|dropoff|leave|leaving|arrive|arrival|start|starting|finish|finishing|meeting|event|calendar|appointment|bin|bins|waste|recycling)\b/.test(text);
}

function currentTimeIntent(field: CurrentTimeField): CurrentTimeIntent {
  return { field, timezone: BASIC_CURRENT_TIMEZONE };
}

/** Names for the house's own zone people use for "local" ("Australia/Sydney": sydney, nsw, aest...). */
const ZONE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "Australia/Sydney": ["new south wales", "nsw", "aest", "aedt", "australian eastern(?: (?:standard|daylight))?(?: time)?"],
  "Australia/Melbourne": ["victoria", "vic", "aest", "aedt", "australian eastern(?: (?:standard|daylight))?(?: time)?"],
  "Australia/Brisbane": ["queensland", "qld", "aest", "australian eastern(?: standard)?(?: time)?"],
  "Australia/Adelaide": ["south australia", "acst", "acdt", "australian central(?: (?:standard|daylight))?(?: time)?"],
  "Australia/Perth": ["western australia", "wa", "awst", "australian western(?: standard)?(?: time)?"],
  "Europe/London": ["uk", "united kingdom", "england", "gmt", "bst", "british(?: summer)? time"],
  "America/New_York": ["eastern(?: time)?", "et", "est", "edt"],
  "America/Los_Angeles": ["pacific(?: time)?", "pt", "pst", "pdt"],
};

/** "here", "local" and the house's own zone: its city ("sydney", "sydney nsw/australia"), area and aliases. */
const LOCAL_SCOPE = (() => {
  const [area = "", ...rest] = HOUSE_TIME_ZONE.split("/");
  const city = rest.join(" ").replace(/_/g, " ").toLowerCase();
  const region = area.toLowerCase();
  const names = city ? [`${city}(?: ${region}| [a-z]{2,3})?`, `${region} ${city}`] : [];
  const extra = ZONE_ALIASES[HOUSE_TIME_ZONE] ?? [];
  return new RegExp(`^(?:here|local|my local|current local${[...names, ...extra].map((name) => `|${name}`).join("")})$`);
})();
