/** Canonical state vocabulary shared by typed resolution and live status answers. */
export function canonicalStatusRequestedState(value: string | null): string | null {
  switch (value) {
    case "away": return "not_home";
    case "shut": return "closed";
    case "lit": return "on";
    case "dark":
    case "out": return "off";
    case "secure": return "locked";
    default: return value;
  }
}

/** Canonicalize ambiguous spoken state words only after the target domains are known. */
export function canonicalStatusRequestedStateForEntityIds(
  value: string | null,
  entityIds: readonly string[],
): string | null {
  if (value !== "out") {
    return canonicalStatusRequestedState(value);
  }
  const domains = new Set(entityIds.map((entityId) => entityId.split(".", 1)[0] ?? ""));
  return domains.size === 1 && (domains.has("person") || domains.has("device_tracker"))
    ? "not_home"
    : "off";
}
