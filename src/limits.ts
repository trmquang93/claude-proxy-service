/**
 * Limits module for credit-based quota system
 * Handles model credit weights and plan-based rate limiting
 */

export type PlanType = "free" | "pro" | "max-5x" | "max-20x";

export interface PlanLimits {
  creditsPerWindow: number;      // Total credits allowed in the time window
  windowHours: number;            // Time window in hours
  allowedModels: string[];        // List of allowed model types
}

/**
 * Plan limits configuration
 * Credits are consumed based on tokens × model weight
 */
export const PLAN_LIMITS: Record<PlanType, PlanLimits> = {
  free: {
    creditsPerWindow: 10_000,      // ~10K Sonnet tokens or 2.5K Haiku tokens per day
    windowHours: 24,                // Daily limit
    allowedModels: ["haiku", "sonnet"],
  },
  pro: {
    creditsPerWindow: 10_000_000,   // ~10M Sonnet tokens per 5 hours (base tier)
    windowHours: 5,                 // 5-hour rolling window
    allowedModels: ["haiku", "sonnet", "opus"],
  },
  "max-5x": {
    creditsPerWindow: 50_000_000,   // ~50M Sonnet tokens per 5 hours (5× Pro)
    windowHours: 5,                 // 5-hour window
    allowedModels: ["haiku", "sonnet", "opus"],
  },
  "max-20x": {
    creditsPerWindow: 200_000_000,  // ~200M Sonnet tokens per 5 hours (20× Pro)
    windowHours: 5,                 // 5-hour window
    allowedModels: ["haiku", "sonnet", "opus"],
  },
};

/**
 * Model credit weights - defines how many credits each model consumes per token
 * Opus: 5x (most expensive)
 * Sonnet: 1x (baseline)
 * Haiku: 0.25x (cheapest)
 */
const MODEL_WEIGHTS: Record<string, number> = {
  opus: 5.0,
  sonnet: 1.0,
  haiku: 0.25,
};

/**
 * Get the credit weight for a model
 * @param model - Model name (e.g., "claude-opus-4-20250514", "sonnet", etc.)
 * @returns Credit weight multiplier
 */
export function getModelWeight(model: string): number {
  const lowerModel = model.toLowerCase();

  if (lowerModel.includes("opus")) {
    return MODEL_WEIGHTS.opus;
  }

  if (lowerModel.includes("sonnet")) {
    return MODEL_WEIGHTS.sonnet;
  }

  if (lowerModel.includes("haiku")) {
    return MODEL_WEIGHTS.haiku;
  }

  // Default to Sonnet weight (1.0) for unknown models
  return MODEL_WEIGHTS.sonnet;
}

/**
 * Calculate credits used based on tokens and model weight
 * @param model - Model name
 * @param tokens - Number of tokens used
 * @returns Credits consumed (rounded up to nearest integer)
 */
export function calculateCreditsUsed(model: string, tokens: number): number {
  const weight = getModelWeight(model);
  const credits = tokens * weight;

  // Round up to nearest integer
  return Math.ceil(credits);
}
