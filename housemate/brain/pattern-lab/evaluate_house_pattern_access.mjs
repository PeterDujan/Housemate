#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { householdOwner } from "../dist/src/household.js";
import { houseObservationAnswer } from "../dist/src/house-pattern-observations.js";
import { parseVoiceBrainRequest } from "../dist/src/voice-brain.js";

const catalogPath = resolve(process.argv[2] ?? "config/house-pattern-observations.json");
// Answer from the catalogue under test, not whichever one the default path resolves to.
process.env.JARVIS_V5_HOUSE_OBSERVATIONS_PATH = catalogPath;
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
if (!Array.isArray(catalog.observations)) throw new Error("reviewed observation catalogue is required");

// Asked as the house's owner: the trusted voice every observation must answer.
const owner = householdOwner();
if (!owner) throw new Error("the household has no owner");
const request = parseVoiceBrainRequest({
  transcript: "house observation accessibility evaluation",
  channel: "voice",
  source_via: "house-observation-access-eval",
  session_id: "house-observation-access-eval",
  speaker_name: owner.name,
  voice_id: owner.id,
  speaker_confidence: 1,
}, {
  actorId: owner.id,
  source: "api_token",
});
const config = { dataDir: "/share/jarvis-v5-observation-access-eval" };
const now = new Date(Date.parse(catalog.source.windowEnd) + 60 * 60_000);
const results = catalog.observations.map((observation) => {
  const question = questionFor(observation);
  const answer = houseObservationAnswer(config, request, question, now);
  return {
    id: observation.id,
    family: observation.family,
    question,
    ok: answer?.status === "ok" && answer.notes.includes(observation.id),
    status: answer?.status ?? "none",
    answer: answer?.text ?? null,
    notes: answer?.notes ?? null,
  };
});
const failures = results.filter((result) => !result.ok);
const summary = {
  total: results.length,
  accessible: results.length - failures.length,
  failed: failures.length,
  byFamily: Object.fromEntries([...new Set(results.map((result) => result.family))].sort().map((family) => {
    const familyResults = results.filter((result) => result.family === family);
    return [family, {
      total: familyResults.length,
      accessible: familyResults.filter((result) => result.ok).length,
      failed: familyResults.filter((result) => !result.ok).length,
    }];
  })),
  failureSamples: failures.slice(0, 30),
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;

function questionFor(observation) {
  const label = observation.subject.label;
  switch (observation.family) {
    case "activation":
      if (observation.subject.domain === "light") return `When does ${label} usually turn on?`;
      if (observation.subject.domain === "lock") return `When does ${withoutWords(label, ["lock"])} usually unlock?`;
      if (observation.subject.domain === "vacuum") return `When does ${label} usually start cleaning?`;
      if (observation.subject.domain === "media_player") return `When does ${label} usually start?`;
      return `When does ${label} usually turn on?`;
    case "deactivation":
      if (observation.subject.domain === "light") return `When does ${label} usually turn off?`;
      if (observation.subject.domain === "lock") return `When does ${withoutWords(label, ["lock"])} usually lock?`;
      if (observation.subject.domain === "vacuum") return `When does ${label} usually stop cleaning?`;
      if (observation.subject.domain === "media_player") return `When does ${label} usually stop?`;
      return `When does ${label} usually turn off?`;
    case "active_episode_duration":
      return `How long does ${label} usually stay active at a time?`;
    case "daily_active_duration":
      return `How long is ${label} usually active per day?`;
    case "home_arrival":
      return `When does ${label} usually arrive home?`;
    case "home_departure":
      return `When does ${label} usually leave home?`;
    case "light_pair_synchrony":
      return `Are ${label} usually on together?`;
    case "numeric_daily_cycle":
      return `When is ${label} normally highest?`;
    case "numeric_daily_delta":
      return `How much does ${label} usually change per day?`;
    case "numeric_day_night_difference":
      return `Is ${label} usually different during the day or night?`;
    case "numeric_typical_range":
      return `What is the usual range for ${label}?`;
    case "person_light_correlation":
      return `What is the usual correlation between ${label}?`;
    case "person_pair_timing":
      return observation.data.mode === "arrival"
        ? `Do ${label} usually arrive home together?`
        : `Do ${label} usually leave home together?`;
    case "person_zone_visit":
      return `How often does ${label} usually visit ${observation.data.zone}?`;
    case "zone_arrival":
      return `When does ${label} usually arrive at ${observation.data.zone}?`;
    default:
      throw new Error(`unsupported observation family ${observation.family}`);
  }
}

function withoutWords(value, excluded) {
  const blocked = new Set(excluded);
  return [...new Set(String(value).split(/\s+/).filter((word) => !blocked.has(word.toLowerCase())))]
    .join(" ");
}
