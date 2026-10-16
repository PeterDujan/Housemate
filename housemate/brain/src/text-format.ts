/** Small reply-text helpers shared by the answer builders. */

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A name for mid-sentence: plain capitalised words lowered ("Office Lights"
 * -> "office lights"); acronyms, codes and possessives kept ("HVAC", "PC",
 * "TV2", "Sam's").
 */
export function lowerCommonWords(value: string): string {
  return value.split(" ").map((word) => (/^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word)).join(" ");
}

export function lowerInitial(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/**
 * "a and b"; three or more: "a, b, and c" (`oxford`), "a, b and c",
 * or `keep-ands-apart`: a comma before the last "and" only when an item has
 * its own "and" ("shut and locked, and the front door is locked").
 */
export function joinNatural(
  values: readonly string[],
  serialComma: "oxford" | "none" | "keep-ands-apart" = "oxford",
): string {
  if (values.length <= 1) return values[0] ?? "";
  const comma = serialComma === "oxford"
    ? values.length > 2
    : serialComma === "keep-ands-apart" && values.some((value) => value.includes(" and "));
  return `${values.slice(0, -1).join(", ")}${comma ? "," : ""} and ${values[values.length - 1]}`;
}

/** "a or b"; three or more: "a, b, or c". */
export function joinAlternatives(values: readonly string[]): string {
  if (values.length <= 1) {
    return values[0] ?? "";
  }
  if (values.length === 2) {
    return `${values[0]} or ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whitespace collapsed, cut to `maximum` characters with an ellipsis. */
export function truncateText(value: string, maximum: number): string {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1).trimEnd()}…`;
}

/** Whole numbers as they are, others to one decimal ("2.5", "3"). */
export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

/** Control characters become spaces. */
export function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
}

export function spokenWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** A span of time as said aloud, rounded to its largest unit ("about 3 hours"). */
export function spokenDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "about an hour" : `about ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "about a day" : `about ${days} days`;
}
