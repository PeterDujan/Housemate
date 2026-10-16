import { existsSync } from "node:fs";

import { readHouseholdFile } from "./household.js";

/**
 * The page's "Finish setting up" list: what a new house still has to do, worked out from
 * the house's own files and Home Assistant, never from a flag the page sets. Once every step is done
 * the list is gone.
 */

export interface SetupStep {
  readonly id: "assistant" | "people" | "brain" | "assist";
  readonly done: boolean;
}

export interface SetupStatus {
  readonly ok: true;
  readonly complete: boolean;
  readonly steps: readonly SetupStep[];
  /** The Housemate Brain conversation agent in Home Assistant, when it is added. */
  readonly agent: string | null;
}

export function setupStatus(input: {
  readonly personalityFile: string;
  readonly householdFile: string;
  /** The brain is signed in, or switched off (then nothing to sign in). */
  readonly brainReady: boolean;
  readonly agent: string | null;
}): SetupStatus {
  let people = false;
  try {
    people = readHouseholdFile(input.householdFile).ownerId !== null;
  } catch {
    people = false;
  }
  const steps: SetupStep[] = [
    { id: "assistant", done: existsSync(input.personalityFile) },
    { id: "people", done: people },
    { id: "brain", done: input.brainReady },
    { id: "assist", done: input.agent !== null },
  ];
  return { ok: true, complete: steps.every((step) => step.done), steps, agent: input.agent };
}
