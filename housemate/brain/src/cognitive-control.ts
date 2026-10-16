import type { AppConfig } from "./config.js";

export interface CognitiveCapabilities {
  readonly system: boolean;
  readonly learning: boolean;
  readonly recall: boolean;
  readonly proactive: boolean;
}

export type CognitiveFeature = "learning" | "recall" | "proactive";

type CognitiveConfig = Pick<
  AppConfig,
  | "cognitiveSystemEnabled"
  | "cognitiveLearningEnabled"
  | "cognitiveRecallEnabled"
  | "cognitiveProactiveEnabled"
>;

export function cognitiveCapabilities(config: CognitiveConfig): CognitiveCapabilities {
  const system = config.cognitiveSystemEnabled;
  const learning = system && config.cognitiveLearningEnabled;
  const recall = system && config.cognitiveRecallEnabled;
  return {
    system,
    learning,
    recall,
    proactive: system && config.cognitiveProactiveEnabled && recall,
  };
}

export function cognitiveFeatureEnabled(
  config: Partial<CognitiveConfig>,
  feature: CognitiveFeature,
): boolean {
  if (config.cognitiveSystemEnabled === false) {
    return false;
  }
  if (feature === "learning") return config.cognitiveLearningEnabled !== false;
  if (feature === "recall") return config.cognitiveRecallEnabled !== false;
  return config.cognitiveProactiveEnabled !== false && config.cognitiveRecallEnabled !== false;
}

export interface CognitiveControlState {
  readonly configured: {
    readonly system: boolean;
    readonly learning: boolean;
    readonly recall: boolean;
    readonly proactive: boolean;
  };
  readonly effective: CognitiveCapabilities;
}

export function cognitiveControlState(config: CognitiveConfig): CognitiveControlState {
  return {
    configured: {
      system: config.cognitiveSystemEnabled,
      learning: config.cognitiveLearningEnabled,
      recall: config.cognitiveRecallEnabled,
      proactive: config.cognitiveProactiveEnabled,
    },
    effective: cognitiveCapabilities(config),
  };
}
