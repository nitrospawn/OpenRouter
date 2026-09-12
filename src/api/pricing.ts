export interface ModelPricing {
  prompt?: string;
  completion?: string;
  request?: string;
  image?: string;
}

export class PricingCalculator {
  /**
   * Computes the dollar cost for a chat turn given prompt/completion tokens and model pricing object.
   * Returns exact float value.
   */
  public static calculateCost(
    promptTokens: number = 0,
    completionTokens: number = 0,
    pricing?: ModelPricing
  ): number {
    if (!pricing) {
      return 0;
    }

    // OpenRouter prices are per-token as strings, e.g. "0.0000025" ($2.50 / million tokens)
    const promptRate = parseFloat(pricing.prompt || '0') || 0;
    const completionRate = parseFloat(pricing.completion || '0') || 0;

    const cost = promptTokens * promptRate + completionTokens * completionRate;
    return Math.max(0, cost);
  }

  /**
   * Formats a cost into a human-readable USD string.
   * Uses up to 4 decimal places for sub-cent micro transactions (e.g. $0.0024).
   */
  public static formatCost(cost: number): string {
    if (cost <= 0) {
      return '$0.00';
    }
    if (cost < 0.01) {
      return `$${cost.toFixed(4)}`;
    }
    return `$${cost.toFixed(2)}`;
  }
}
