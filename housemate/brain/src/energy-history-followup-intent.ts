export type EnergyHistoryFollowUpIntent =
  | { readonly kind: "normality" }
  | { readonly kind: "same_point_last_year" };

export function parseEnergyHistoryFollowUpIntent(normalized: string): EnergyHistoryFollowUpIntent | null {
  const refersToPriorReading = /\b(?:that|it|this)\b/.test(normalized);
  const asksForNorm = /\b(?:normal|usual|typical|expected|okay|ok|alright|fine)\b/.test(normalized);
  if (refersToPriorReading && asksForNorm) {
    return { kind: "normality" };
  }

  const hasPriorYear = /\b(?:last|previous|prior) years?\b|\ba year ago\b/.test(normalized);
  const hasElapsedPoint = /\b(?:at (?:this|the same) point(?: in time)?|so far|by now|to date|up to now)\b/.test(normalized);
  const hasFollowUpShape = /^(?:and\s+)?(?:what|how) about\b/.test(normalized)
    || refersToPriorReading
    || !/\b(?:house|home|grid|solar|battery|water|gas|office|lighting|lights)\b/.test(normalized);
  const hasRetainedMeasureReference = /\b(?:usage|use|used|consumption|energy|that|it|this)\b/.test(normalized)
    || /^(?:and\s+)?(?:what|how) about\b/.test(normalized);
  return hasPriorYear && hasElapsedPoint && hasRetainedMeasureReference && hasFollowUpShape
    ? { kind: "same_point_last_year" }
    : null;
}
