import type { SafeRenderSummary } from "./result-contract.js";

export interface FishTextDecoration {
  readonly fishText: string;
  readonly fishTags: readonly string[];
}

const BANNED_FISH_TAGS = new Set(["calm"]);

export function extractFishTags(text: string): readonly string[] {
  const tags = [...text.matchAll(/\[([^\]\n]{1,80})\]/g)]
    .map((match) => (match[1] ?? "").trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(tags)].sort();
}

export function automaticFishTextForSummary(text: string, summary: Pick<SafeRenderSummary, "route">): FishTextDecoration {
  const tag = fishDeliveryTagForSummary(summary);
  const fishText = tag ? `[${tag}] ${text}` : text;
  const fishTags = extractFishTags(fishText);
  assertAllowedFishTags(fishTags);
  return { fishText, fishTags };
}

function fishDeliveryTagForSummary(summary: Pick<SafeRenderSummary, "route" | "renderContext">): string | null {
  const timeMode = summary.renderContext?.house?.timeMode ?? null;
  if (timeMode === "bedtime" || timeMode === "quiet_hours") {
    return "quietly";
  }
  switch (summary.route) {
    case "weather_query":
    case "energy_budget":
    case "time_window_math":
      return "matter-of-fact";
    case "entity_status":
    case "house_status":
      return "casual";
    case "memory_query":
      return "warmly";
    default:
      return null;
  }
}

function assertAllowedFishTags(tags: readonly string[]): void {
  const banned = tags.find((tag) => BANNED_FISH_TAGS.has(tag.trim().toLowerCase()));
  if (banned) {
    throw new Error(`renderer fish tag is not allowed: ${banned}`);
  }
}
