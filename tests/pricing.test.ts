import { describe, test, expect } from "bun:test";
import { calculateCost, detectModelType, ModelType } from "../src/pricing";

describe("Pricing Module", () => {
  describe("detectModelType", () => {
    test("should detect Opus model when name contains 'opus'", () => {
      expect(detectModelType("claude-opus-4-20250514")).toBe(ModelType.Opus);
      expect(detectModelType("OPUS-latest")).toBe(ModelType.Opus);
      expect(detectModelType("opus")).toBe(ModelType.Opus);
    });

    test("should detect Sonnet model when name contains 'sonnet'", () => {
      expect(detectModelType("claude-sonnet-4-20250514")).toBe(ModelType.Sonnet);
      expect(detectModelType("SONNET-4.5")).toBe(ModelType.Sonnet);
      expect(detectModelType("sonnet")).toBe(ModelType.Sonnet);
    });

    test("should fallback to Sonnet for unknown models", () => {
      expect(detectModelType("claude-unknown-model")).toBe(ModelType.Sonnet);
      expect(detectModelType("")).toBe(ModelType.Sonnet);
      expect(detectModelType("gpt-4")).toBe(ModelType.Sonnet);
    });

    test("should be case-insensitive", () => {
      expect(detectModelType("Claude-Opus-4")).toBe(ModelType.Opus);
      expect(detectModelType("ClAuDe-SoNnEt-4")).toBe(ModelType.Sonnet);
    });
  });

  describe("calculateCost - Opus Model", () => {
    test("should calculate Opus cost with input and output tokens only", () => {
      const cost = calculateCost("claude-opus-4-20250514", {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      // Input: 1000 tokens = (1000 / 1_000_000) * 15 = 0.015
      // Output: 500 tokens = (500 / 1_000_000) * 75 = 0.0375
      // Total: 0.0525
      expect(cost).toBeCloseTo(0.0525, 5);
    });

    test("should calculate Opus cost with cache write tokens", () => {
      const cost = calculateCost("opus", {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 0,
      });

      // Input: 1000 * $15/MTok = 0.015
      // Output: 500 * $75/MTok = 0.0375
      // Cache Write: 2000 * $18.75/MTok = 0.0375
      // Total: 0.09
      expect(cost).toBeCloseTo(0.09, 5);
    });

    test("should calculate Opus cost with cache read tokens", () => {
      const cost = calculateCost("opus", {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 3000,
      });

      // Input: 1000 * $15/MTok = 0.015
      // Output: 500 * $75/MTok = 0.0375
      // Cache Read: 3000 * $1.50/MTok = 0.0045
      // Total: 0.057
      expect(cost).toBeCloseTo(0.057, 5);
    });

    test("should calculate Opus cost with all token types", () => {
      const cost = calculateCost("opus-4.1", {
        input_tokens: 10000,
        output_tokens: 5000,
        cache_creation_input_tokens: 20000,
        cache_read_input_tokens: 30000,
      });

      // Input: 10000 * $15/MTok = 0.15
      // Output: 5000 * $75/MTok = 0.375
      // Cache Write: 20000 * $18.75/MTok = 0.375
      // Cache Read: 30000 * $1.50/MTok = 0.045
      // Total: 0.945
      expect(cost).toBeCloseTo(0.945, 5);
    });
  });

  describe("calculateCost - Sonnet Model (≤200K context)", () => {
    test("should calculate Sonnet cost for small context with input and output only", () => {
      const cost = calculateCost("claude-sonnet-4-20250514", {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      // Context: 1000 tokens (≤200K)
      // Input: 1000 * $3/MTok = 0.003
      // Output: 500 * $15/MTok = 0.0075
      // Total: 0.0105
      expect(cost).toBeCloseTo(0.0105, 5);
    });

    test("should calculate Sonnet cost with cache write tokens (≤200K)", () => {
      const cost = calculateCost("sonnet", {
        input_tokens: 50000,
        output_tokens: 10000,
        cache_creation_input_tokens: 100000,
        cache_read_input_tokens: 0,
      });

      // Context: 50000 + 100000 = 150000 tokens (≤200K)
      // Input: 50000 * $3/MTok = 0.15
      // Output: 10000 * $15/MTok = 0.15
      // Cache Write: 100000 * $3.75/MTok = 0.375
      // Total: 0.675
      expect(cost).toBeCloseTo(0.675, 5);
    });

    test("should calculate Sonnet cost with cache read tokens (≤200K)", () => {
      const cost = calculateCost("sonnet", {
        input_tokens: 50000,
        output_tokens: 10000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100000,
      });

      // Context: 50000 + 100000 = 150000 tokens (≤200K)
      // Input: 50000 * $3/MTok = 0.15
      // Output: 10000 * $15/MTok = 0.15
      // Cache Read: 100000 * $0.30/MTok = 0.03
      // Total: 0.33
      expect(cost).toBeCloseTo(0.33, 5);
    });

    test("should use ≤200K pricing at exactly 200K tokens", () => {
      const cost = calculateCost("sonnet", {
        input_tokens: 150000,
        output_tokens: 10000,
        cache_creation_input_tokens: 30000,
        cache_read_input_tokens: 20000,
      });

      // Context: 150000 + 30000 + 20000 = 200000 tokens (exactly at threshold)
      // Input: 150000 * $3/MTok = 0.45
      // Output: 10000 * $15/MTok = 0.15
      // Cache Write: 30000 * $3.75/MTok = 0.1125
      // Cache Read: 20000 * $0.30/MTok = 0.006
      // Total: 0.7185
      expect(cost).toBeCloseTo(0.7185, 5);
    });
  });

  describe("calculateCost - Sonnet Model (>200K context)", () => {
    test("should calculate Sonnet cost for large context with input and output only", () => {
      const cost = calculateCost("sonnet", {
        input_tokens: 250000,
        output_tokens: 50000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      // Context: 250000 tokens (>200K)
      // Input: 250000 * $6/MTok = 1.5
      // Output: 50000 * $22.50/MTok = 1.125
      // Total: 2.625
      expect(cost).toBeCloseTo(2.625, 5);
    });

    test("should calculate Sonnet cost with cache tokens (>200K)", () => {
      const cost = calculateCost("sonnet", {
        input_tokens: 150000,
        output_tokens: 20000,
        cache_creation_input_tokens: 100000,
        cache_read_input_tokens: 50000,
      });

      // Context: 150000 + 100000 + 50000 = 300000 tokens (>200K)
      // Input: 150000 * $6/MTok = 0.9
      // Output: 20000 * $22.50/MTok = 0.45
      // Cache Write: 100000 * $7.50/MTok = 0.75
      // Cache Read: 50000 * $0.60/MTok = 0.03
      // Total: 2.13
      expect(cost).toBeCloseTo(2.13, 5);
    });

    test("should use >200K pricing at 200001 tokens", () => {
      const cost = calculateCost("sonnet", {
        input_tokens: 200001,
        output_tokens: 10000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      // Context: 200001 tokens (>200K)
      // Input: 200001 * $6/MTok = 1.200006
      // Output: 10000 * $22.50/MTok = 0.225
      // Total: 1.425006
      expect(cost).toBeCloseTo(1.425006, 5);
    });
  });

  describe("calculateCost - Edge Cases", () => {
    test("should handle zero tokens", () => {
      const cost = calculateCost("sonnet", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      expect(cost).toBe(0);
    });

    test("should handle undefined cache tokens (defaults to 0)", () => {
      const cost = calculateCost("opus", {
        input_tokens: 1000,
        output_tokens: 500,
      });

      // Should calculate without errors
      // Input: 1000 * $15/MTok = 0.015
      // Output: 500 * $75/MTok = 0.0375
      // Total: 0.0525
      expect(cost).toBeCloseTo(0.0525, 5);
    });

    test("should handle very large token counts", () => {
      const cost = calculateCost("sonnet", {
        input_tokens: 1000000,
        output_tokens: 500000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      // Context: 1000000 tokens (>200K)
      // Input: 1000000 * $6/MTok = 6.0
      // Output: 500000 * $22.50/MTok = 11.25
      // Total: 17.25
      expect(cost).toBeCloseTo(17.25, 5);
    });

    test("should handle empty model name (fallback to Sonnet)", () => {
      const cost = calculateCost("", {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      // Should use Sonnet ≤200K pricing
      expect(cost).toBeCloseTo(0.0105, 5);
    });
  });
});
