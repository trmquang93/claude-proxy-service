/**
 * Quota enforcement module with rolling window calculations
 * Implements credit-based rate limiting with plan-specific limits
 * Supports per-key custom quota percentages
 */

import pool from "./db";
import { PLAN_LIMITS, PlanType, getModelWeight } from "./limits";

/**
 * Calculate effective limit based on plan limit and quota percentage
 * @param planLimit - Base limit from user's plan
 * @param quotaPercentage - Percentage of plan limit (1-100)
 * @returns Effective limit (rounded down to integer)
 */
export function calculateEffectiveLimit(planLimit: number, quotaPercentage: number): number {
  return Math.floor((planLimit * quotaPercentage) / 100);
}

export interface WindowUsageStats {
  currentCredits: number;
  currentRequests: number;
  currentCost: number;
  oldestRequestTimestamp: number | null;
  windowStartTime: number;
  windowEndTime: number;
  nextResetAt: number;
  timeUntilResetMs: number;
  modelBreakdown: ModelUsageBreakdown[];
}

export interface ModelUsageBreakdown {
  model: string;
  requests: number;
  credits: number;
  percentage: number;
}

export interface UsagePercentages {
  creditPercentage: number;
  isOverLimit: boolean;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  usage: WindowUsageStats;
  percentages: UsagePercentages;
  resetTime: Date;
}

/**
 * Get rolling window usage for an API key
 * @param keyId - API key ID
 * @param windowHours - Window size in hours
 * @returns Usage statistics within the rolling window
 */
export async function getRollingWindowUsage(keyId: string, windowHours: number): Promise<WindowUsageStats> {
  const now = Date.now();
  const windowStartTime = now - windowHours * 60 * 60 * 1000;
  const windowEndTime = now;

  // Query usage within rolling window
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(credits_used), 0) as total_credits,
       COALESCE(SUM(cost), 0) as total_cost,
       COUNT(*) as total_requests,
       MIN(timestamp) as oldest_timestamp,
       model
     FROM api_key_usage_history
     WHERE key_id = $1 AND timestamp >= $2
     GROUP BY model`,
    [keyId, windowStartTime]
  );

  let totalCredits = 0;
  let totalCost = 0;
  let totalRequests = 0;
  let oldestTimestamp: number | null = null;
  const modelBreakdown: ModelUsageBreakdown[] = [];

  // Aggregate across all models
  for (const row of result.rows) {
    totalCredits += Number(row.total_credits);
    totalCost += Number(row.total_cost);
    totalRequests += Number(row.total_requests);

    // Track oldest timestamp
    if (row.oldest_timestamp) {
      const timestamp = Number(row.oldest_timestamp);
      if (oldestTimestamp === null || timestamp < oldestTimestamp) {
        oldestTimestamp = timestamp;
      }
    }

    // Extract model type from full model name
    const modelName = row.model?.toLowerCase() || "unknown";
    let modelType = "sonnet"; // default
    if (modelName.includes("opus")) modelType = "opus";
    else if (modelName.includes("haiku")) modelType = "haiku";
    else if (modelName.includes("sonnet")) modelType = "sonnet";

    modelBreakdown.push({
      model: modelType,
      requests: Number(row.total_requests),
      credits: Number(row.total_credits),
      percentage: 0 // Will calculate after we have total
    });
  }

  // Calculate percentages for model breakdown
  if (totalCredits > 0) {
    for (const breakdown of modelBreakdown) {
      breakdown.percentage = (breakdown.credits / totalCredits) * 100;
    }
  }

  const nextResetTime = getNextResetTime(oldestTimestamp, windowHours);
  const timeUntilResetMs = nextResetTime.getTime() - now;

  return {
    currentCredits: totalCredits,
    currentRequests: totalRequests,
    currentCost: totalCost,
    oldestRequestTimestamp: oldestTimestamp,
    windowStartTime,
    windowEndTime,
    nextResetAt: nextResetTime.getTime(),
    timeUntilResetMs: Math.max(0, timeUntilResetMs),
    modelBreakdown
  };
}

/**
 * Calculate usage percentages against plan limits
 * @param usage - Current usage statistics
 * @param planType - Plan type (free, pro, max-5x, max-20x)
 * @returns Usage percentages and over-limit status
 */
export function calculateUsagePercentage(usage: WindowUsageStats, planType: PlanType): UsagePercentages {
  const limits = PLAN_LIMITS[planType];

  const creditPercentage = (usage.currentCredits / limits.creditsPerWindow) * 100;
  const isOverLimit = creditPercentage >= 100;

  return {
    creditPercentage: Math.round(creditPercentage),
    isOverLimit
  };
}

/**
 * Check if an API key has exceeded its quota
 * @param keyId - API key ID
 * @param planType - Plan type
 * @returns Quota check result with usage stats and decision
 */
export async function checkQuotaLimit(keyId: string, planType: PlanType): Promise<QuotaCheckResult> {
  const limits = PLAN_LIMITS[planType];

  // Get quota_percentage from api_keys table
  const keyResult = await pool.query(
    "SELECT quota_percentage FROM api_keys WHERE id = $1",
    [keyId]
  );
  const quotaPercentage = keyResult.rows[0]?.quota_percentage ?? 100;

  // Calculate effective limit based on quota percentage
  const effectiveCreditsLimit = calculateEffectiveLimit(limits.creditsPerWindow, quotaPercentage);

  const usage = await getRollingWindowUsage(keyId, limits.windowHours);

  // Calculate percentages based on effective limit (not plan limit)
  const creditPercentage = (usage.currentCredits / effectiveCreditsLimit) * 100;
  const isOverLimit = creditPercentage >= 100;

  const percentages = {
    creditPercentage: Math.round(creditPercentage),
    isOverLimit
  };

  const resetTime = getNextResetTime(usage.oldestRequestTimestamp, limits.windowHours);

  if (percentages.isOverLimit) {
    const limitDescription = quotaPercentage < 100
      ? `${quotaPercentage}% of ${planType} plan limit`
      : `${planType} plan limit`;

    return {
      allowed: false,
      reason: `Quota exceeded: ${percentages.creditPercentage}% of ${limitDescription} used. Resets ${formatDuration(usage.timeUntilResetMs)} from now.`,
      usage,
      percentages,
      resetTime
    };
  }

  return {
    allowed: true,
    usage,
    percentages,
    resetTime
  };
}

/**
 * Calculate next reset time based on oldest request in window
 * @param oldestTimestamp - Timestamp of oldest request in window
 * @param windowHours - Window size in hours
 * @returns Date when quota will reset
 */
export function getNextResetTime(oldestTimestamp: number | null, windowHours: number): Date {
  if (oldestTimestamp === null) {
    // No usage yet, reset is window hours from now
    return new Date(Date.now() + windowHours * 60 * 60 * 1000);
  }

  // Reset is window hours after the oldest request
  return new Date(oldestTimestamp + windowHours * 60 * 60 * 1000);
}

/**
 * Format duration in milliseconds to human-readable string
 * @param ms - Duration in milliseconds
 * @returns Formatted duration (e.g., "2h 30m")
 */
export function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}h ${minutes}m`;
}
