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

  /**
   * Formats a single per-token rate string into dollars per million tokens ($/M).
   */
  public static formatRatePerMillion(rateStr?: string): string {
    const num = parseFloat(rateStr || '0') || 0;
    if (num === 0) return '$0';
    const perMillion = num * 1_000_000;
    if (perMillion >= 100) {
      return `$${Math.round(perMillion)}`;
    }
    if (perMillion >= 1) {
      return `$${parseFloat(perMillion.toFixed(2))}`;
    }
    if (perMillion >= 0.01) {
      return `$${parseFloat(perMillion.toFixed(3))}`;
    }
    return `$${parseFloat(perMillion.toFixed(4))}`;
  }

  /**
   * Formats a model's prompt and completion rates into standard Input / Output /M badge label.
   */
  public static formatModelPricing(pricing?: ModelPricing): { label: string; isFree: boolean; tooltip: string } | null {
    if (!pricing) return null;
    const pRate = parseFloat(pricing.prompt || '0') || 0;
    const cRate = parseFloat(pricing.completion || '0') || 0;

    if (pRate === 0 && cRate === 0) {
      return {
        label: 'Free',
        isFree: true,
        tooltip: 'Free model ($0 / 1M tokens)',
      };
    }

    const pPerM = PricingCalculator.formatRatePerMillion(pricing.prompt);
    const cPerM = PricingCalculator.formatRatePerMillion(pricing.completion);
    const label = `${pPerM} / ${cPerM} /M`;
    const tooltip = `Input: ${pPerM} / 1M tokens • Output: ${cPerM} / 1M tokens`;

    return { label, isFree: false, tooltip };
  }
}

