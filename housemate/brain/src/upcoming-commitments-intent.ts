import { normalizeWords as normalize } from "./speech-normalizer.js";

/**
 * Recognise a request for the speaker's upcoming obligations rather than a
 * request for one named calendar. The grammar is deliberately about semantic
 * ownership (I/we + have/got/plans) and a schedule-shaped complement; it does
 * not treat every occurrence of "anything on" as a calendar request.
 */
export function looksLikeUpcomingCommitmentsQuestion(normalized: string): boolean {
  const text = normalize(normalized);
  const temporalOn = "on(?:\\s+(?:today|tonight|tomorrow|this|next|in|over|within|during|between|from)\\b|$)";
  const ownedAnything = new RegExp(
    `\\b(?:(?:do|did)\\s+(?:i|we)\\s+have|have\\s+(?:i|we)\\s+got)\\s+(?:anything|something)\\s+${temporalOn}`,
  );
  const ownedWhat = new RegExp(
    `\\bwhat\\s+(?:(?:have\\s+(?:i|we)\\s+got)|(?:do\\s+(?:i|we)\\s+have))\\s+${temporalOn}`,
  );
  const ownedPlans = /\b(?:(?:do|did)\s+(?:i|we)\s+have|have\s+(?:i|we)\s+got)\s+(?:any\s+)?(?:plans?|commitments?|appointments?|obligations?)(?:\s+(?:today|tonight|tomorrow|this|next|in|over|within|during|between|from)\b|$)/;
  const upcomingPlans = /^(?:what s|whats|what is)\s+coming up\b|^(?:anything|any\s+(?:plans?|commitments?|appointments?|obligations?))\s+(?:coming up\b|(?:in|over|within|during|for)\b)/;
  return ownedAnything.test(text)
    || ownedWhat.test(text)
    || ownedPlans.test(text)
    || upcomingPlans.test(text);
}
