import test from 'node:test';
import assert from 'node:assert';
import { PricingCalculator } from '../src/api/pricing.ts';

test('PricingCalculator: calculates cost accurately for standard models', () => {
  // Test case 1: GPT-4o style pricing ($2.50 / M prompt, $10.00 / M completion)
  const pricing = {
    prompt: '0.0000025',
    completion: '0.000010',
  };

  const cost = PricingCalculator.calculateCost(1000, 500, pricing);
  // (1000 * 0.0000025) + (500 * 0.00001) = 0.0025 + 0.005 = 0.0075
  assert.strictEqual(cost, 0.0075);
});

test('PricingCalculator: handles free/zero pricing gracefully', () => {
  const pricing = {
    prompt: '0',
    completion: '0',
  };

  const cost = PricingCalculator.calculateCost(50000, 25000, pricing);
  assert.strictEqual(cost, 0);
});

test('PricingCalculator: handles missing pricing object', () => {
  const cost = PricingCalculator.calculateCost(1000, 500, undefined);
  assert.strictEqual(cost, 0);
});

test('PricingCalculator: formats USD amounts correctly', () => {
  assert.strictEqual(PricingCalculator.formatCost(0), '$0.00');
  assert.strictEqual(PricingCalculator.formatCost(-0.5), '$0.00');
  assert.strictEqual(PricingCalculator.formatCost(0.00456), '$0.0046');
  assert.strictEqual(PricingCalculator.formatCost(1.2345), '$1.23');
  assert.strictEqual(PricingCalculator.formatCost(12.5), '$12.50');
});
