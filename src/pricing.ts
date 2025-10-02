/**
 * Pricing module for calculating token costs based on Claude model and usage
 */

export enum ModelType {
  Opus = "opus",
  Sonnet = "sonnet",
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface PricingRates {
  input: number;        // Price per million tokens
  output: number;       // Price per million tokens
  cacheWrite: number;   // Price per million tokens
  cacheRead: number;    // Price per million tokens
}

// Pricing rates per million tokens
const OPUS_PRICING: PricingRates = {
  input: 15,
  output: 75,
  cacheWrite: 18.75,
  cacheRead: 1.50,
};

const SONNET_PRICING_SMALL: PricingRates = {
  input: 3,
  output: 15,
  cacheWrite: 3.75,
  cacheRead: 0.30,
};

const SONNET_PRICING_LARGE: PricingRates = {
  input: 6,
  output: 22.50,
  cacheWrite: 7.50,
  cacheRead: 0.60,
};

const CONTEXT_THRESHOLD = 200_000; // 200K tokens

/**
 * Detect model type from model name
 * @param model - Model name (e.g., "claude-opus-4-20250514", "claude-sonnet-4-20250514")
 * @returns ModelType enum value
 */
export function detectModelType(model: string): ModelType {
  const lowerModel = model.toLowerCase();

  if (lowerModel.includes("opus")) {
    return ModelType.Opus;
  }

  // Default to Sonnet for sonnet models or unknown models
  return ModelType.Sonnet;
}

/**
 * Calculate total cost for token usage based on model
 * @param model - Model name
 * @param usage - Token usage data
 * @returns Total cost in dollars
 */
export function calculateCost(model: string, usage: TokenUsage): number {
  const modelType = detectModelType(model);

  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;

  let pricing: PricingRates;

  if (modelType === ModelType.Opus) {
    pricing = OPUS_PRICING;
  } else {
    // For Sonnet, determine pricing tier based on context length
    const contextLength = inputTokens + cacheCreationTokens + cacheReadTokens;

    if (contextLength <= CONTEXT_THRESHOLD) {
      pricing = SONNET_PRICING_SMALL;
    } else {
      pricing = SONNET_PRICING_LARGE;
    }
  }

  // Calculate costs (converting tokens to millions)
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheWriteCost = (cacheCreationTokens / 1_000_000) * pricing.cacheWrite;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheRead;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}
