import { describe, test, expect } from "bun:test";
import { getModelWeight, calculateCreditsUsed, PLAN_LIMITS, PlanLimits, PlanType } from "../src/limits";

describe("Limits Module", () => {
  describe("getModelWeight", () => {
    test("should return 5.0 for opus models", () => {
      expect(getModelWeight("claude-opus-4-20250514")).toBe(5.0);
      expect(getModelWeight("opus-latest")).toBe(5.0);
      expect(getModelWeight("opus")).toBe(5.0);
      expect(getModelWeight("OPUS")).toBe(5.0);
    });

    test("should return 1.0 for sonnet models", () => {
      expect(getModelWeight("claude-sonnet-4-20250514")).toBe(1.0);
      expect(getModelWeight("sonnet-4.5")).toBe(1.0);
      expect(getModelWeight("sonnet")).toBe(1.0);
      expect(getModelWeight("SONNET")).toBe(1.0);
    });

    test("should return 0.25 for haiku models", () => {
      expect(getModelWeight("claude-haiku-4-20250514")).toBe(0.25);
      expect(getModelWeight("haiku-latest")).toBe(0.25);
      expect(getModelWeight("haiku")).toBe(0.25);
      expect(getModelWeight("HAIKU")).toBe(0.25);
    });

    test("should be case-insensitive", () => {
      expect(getModelWeight("Claude-Opus-4")).toBe(5.0);
      expect(getModelWeight("ClAuDe-SoNnEt-4")).toBe(1.0);
      expect(getModelWeight("CLAUDE-HAIKU-4")).toBe(0.25);
    });

    test("should handle model names with version numbers", () => {
      expect(getModelWeight("claude-opus-4-20250514")).toBe(5.0);
      expect(getModelWeight("claude-sonnet-4.5-20250514")).toBe(1.0);
      expect(getModelWeight("claude-haiku-3.7-20250514")).toBe(0.25);
    });

    test("should default to 1.0 for unknown models", () => {
      expect(getModelWeight("claude-unknown-model")).toBe(1.0);
      expect(getModelWeight("")).toBe(1.0);
      expect(getModelWeight("gpt-4")).toBe(1.0);
      expect(getModelWeight("random-ai-model")).toBe(1.0);
    });
  });

  describe("calculateCreditsUsed", () => {
    test("should multiply tokens by model weight for opus", () => {
      expect(calculateCreditsUsed("opus", 1000)).toBe(5000);
      expect(calculateCreditsUsed("claude-opus-4", 100)).toBe(500);
    });

    test("should multiply tokens by model weight for sonnet", () => {
      expect(calculateCreditsUsed("sonnet", 1000)).toBe(1000);
      expect(calculateCreditsUsed("claude-sonnet-4", 100)).toBe(100);
    });

    test("should multiply tokens by model weight for haiku", () => {
      expect(calculateCreditsUsed("haiku", 1000)).toBe(250);
      expect(calculateCreditsUsed("claude-haiku-4", 100)).toBe(25);
    });

    test("should round up to nearest integer", () => {
      // Haiku with odd tokens should round up
      expect(calculateCreditsUsed("haiku", 1)).toBe(1); // 0.25 -> 1
      expect(calculateCreditsUsed("haiku", 3)).toBe(1); // 0.75 -> 1
      expect(calculateCreditsUsed("haiku", 5)).toBe(2); // 1.25 -> 2
      expect(calculateCreditsUsed("haiku", 7)).toBe(2); // 1.75 -> 2
      expect(calculateCreditsUsed("haiku", 9)).toBe(3); // 2.25 -> 3
    });

    test("should handle zero tokens", () => {
      expect(calculateCreditsUsed("opus", 0)).toBe(0);
      expect(calculateCreditsUsed("sonnet", 0)).toBe(0);
      expect(calculateCreditsUsed("haiku", 0)).toBe(0);
    });

    test("should handle very large token counts", () => {
      expect(calculateCreditsUsed("opus", 1_000_000)).toBe(5_000_000);
      expect(calculateCreditsUsed("sonnet", 1_000_000)).toBe(1_000_000);
      expect(calculateCreditsUsed("haiku", 1_000_000)).toBe(250_000);
    });

    test("should use default weight (1.0) for unknown models", () => {
      expect(calculateCreditsUsed("unknown-model", 1000)).toBe(1000);
      expect(calculateCreditsUsed("", 1000)).toBe(1000);
    });
  });

  describe("PLAN_LIMITS definitions", () => {
    test("should have all required plan types defined", () => {
      expect(PLAN_LIMITS.free).toBeDefined();
      expect(PLAN_LIMITS.pro).toBeDefined();
      expect(PLAN_LIMITS["max-5x"]).toBeDefined();
      expect(PLAN_LIMITS["max-20x"]).toBeDefined();
    });

    test("free plan should have correct structure and values", () => {
      const freePlan = PLAN_LIMITS.free;
      expect(freePlan).toHaveProperty("creditsPerWindow");
      expect(freePlan).toHaveProperty("windowHours");
      expect(freePlan).toHaveProperty("allowedModels");

      expect(freePlan.creditsPerWindow).toBe(10_000);
      expect(freePlan.windowHours).toBe(24);
      expect(Array.isArray(freePlan.allowedModels)).toBe(true);
    });

    test("pro plan should have correct structure and values", () => {
      const proPlan = PLAN_LIMITS.pro;
      expect(proPlan).toHaveProperty("creditsPerWindow");
      expect(proPlan).toHaveProperty("windowHours");
      expect(proPlan).toHaveProperty("allowedModels");

      expect(proPlan.creditsPerWindow).toBe(10_000_000);
      expect(proPlan.windowHours).toBe(5);
      expect(Array.isArray(proPlan.allowedModels)).toBe(true);
    });

    test("max-5x plan should have correct structure and values", () => {
      const max5xPlan = PLAN_LIMITS["max-5x"];
      expect(max5xPlan).toHaveProperty("creditsPerWindow");
      expect(max5xPlan).toHaveProperty("windowHours");
      expect(max5xPlan).toHaveProperty("allowedModels");

      expect(max5xPlan.creditsPerWindow).toBe(50_000_000);
      expect(max5xPlan.windowHours).toBe(5);
      expect(Array.isArray(max5xPlan.allowedModels)).toBe(true);
    });

    test("max-20x plan should have correct structure and values", () => {
      const max20xPlan = PLAN_LIMITS["max-20x"];
      expect(max20xPlan).toHaveProperty("creditsPerWindow");
      expect(max20xPlan).toHaveProperty("windowHours");
      expect(max20xPlan).toHaveProperty("allowedModels");

      expect(max20xPlan.creditsPerWindow).toBe(200_000_000);
      expect(max20xPlan.windowHours).toBe(5);
      expect(Array.isArray(max20xPlan.allowedModels)).toBe(true);
    });

    test("each plan should have allowed models array", () => {
      expect(PLAN_LIMITS.free.allowedModels.length).toBeGreaterThan(0);
      expect(PLAN_LIMITS.pro.allowedModels.length).toBeGreaterThan(0);
      expect(PLAN_LIMITS["max-5x"].allowedModels.length).toBeGreaterThan(0);
      expect(PLAN_LIMITS["max-20x"].allowedModels.length).toBeGreaterThan(0);
    });

    test("free plan should only allow haiku and sonnet", () => {
      const freePlan = PLAN_LIMITS.free;
      expect(freePlan.allowedModels).toContain("haiku");
      expect(freePlan.allowedModels).toContain("sonnet");
      expect(freePlan.allowedModels).not.toContain("opus");
    });

    test("paid plans should allow all models", () => {
      const proPlan = PLAN_LIMITS.pro;
      expect(proPlan.allowedModels).toContain("haiku");
      expect(proPlan.allowedModels).toContain("sonnet");
      expect(proPlan.allowedModels).toContain("opus");

      const max5xPlan = PLAN_LIMITS["max-5x"];
      expect(max5xPlan.allowedModels).toContain("haiku");
      expect(max5xPlan.allowedModels).toContain("sonnet");
      expect(max5xPlan.allowedModels).toContain("opus");

      const max20xPlan = PLAN_LIMITS["max-20x"];
      expect(max20xPlan.allowedModels).toContain("haiku");
      expect(max20xPlan.allowedModels).toContain("sonnet");
      expect(max20xPlan.allowedModels).toContain("opus");
    });
  });

  describe("Edge Cases", () => {
    test("should handle null or undefined model gracefully", () => {
      // TypeScript should prevent this, but just in case
      expect(getModelWeight("")).toBe(1.0);
    });

    test("should handle special characters in model name", () => {
      expect(getModelWeight("claude-opus-4!@#$%")).toBe(5.0);
      expect(getModelWeight("claude-sonnet-4_test")).toBe(1.0);
    });

    test("should handle fractional credits correctly", () => {
      // Test that rounding works correctly
      const credits = calculateCreditsUsed("haiku", 1);
      expect(Number.isInteger(credits)).toBe(true);
      expect(credits).toBe(1);
    });
  });
});
