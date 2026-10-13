import test from 'node:test';
import assert from 'node:assert';
import { PricingCalculator } from '../src/api/pricing';

const { formatRatePerMillion, formatModelPricing } = PricingCalculator;

test('formatRatePerMillion: formats zero rates cleanly', () => {
  assert.strictEqual(formatRatePerMillion('0'), '$0');
  assert.strictEqual(formatRatePerMillion(''), '$0');
  assert.strictEqual(formatRatePerMillion(undefined), '$0');
});

test('formatRatePerMillion: formats fractional dollar rates correctly', () => {
  // $0.15 / million tokens (0.00000015)
  assert.strictEqual(formatRatePerMillion('0.00000015'), '$0.15');
  // $0.075 / million tokens (0.000000075)
  assert.strictEqual(formatRatePerMillion('0.000000075'), '$0.075');
});

test('formatRatePerMillion: formats standard rates without unnecessary decimals', () => {
  // $3.00 / million tokens (0.000003) -> $3
  assert.strictEqual(formatRatePerMillion('0.000003'), '$3');
  // $15.00 / million tokens (0.000015) -> $15
  assert.strictEqual(formatRatePerMillion('0.000015'), '$15');
  // $10.00 / million tokens (0.00001) -> $10
  assert.strictEqual(formatRatePerMillion('0.00001'), '$10');
  // $800.00 / million tokens (0.0008) -> $800
  assert.strictEqual(formatRatePerMillion('0.0008'), '$800');
});

test('formatModelPricing: handles free models', () => {
  const result = formatModelPricing({ prompt: '0', completion: '0' });
  assert.deepStrictEqual(result, {
    label: 'Free',
    isFree: true,
    tooltip: 'Free model ($0 / 1M tokens)',
  });
});

test('formatModelPricing: formats standard prompt and completion rates', () => {
  // Claude 3.5 Sonnet: prompt 0.000003 ($3/M), completion 0.000015 ($15/M)
  const result = formatModelPricing({ prompt: '0.000003', completion: '0.000015' });
  assert.deepStrictEqual(result, {
    label: '$3 / $15 /M',
    isFree: false,
    tooltip: 'Input: $3 / 1M tokens • Output: $15 / 1M tokens',
  });
});

test('formatModelPricing: formats high-rate models (e.g. 0.00001 / 0.0008)', () => {
  const result = formatModelPricing({ prompt: '0.00001', completion: '0.0008' });
  assert.deepStrictEqual(result, {
    label: '$10 / $800 /M',
    isFree: false,
    tooltip: 'Input: $10 / 1M tokens • Output: $800 / 1M tokens',
  });
});

test('formatModelPricing: returns null when pricing is undefined', () => {
  assert.strictEqual(formatModelPricing(undefined), null);
});
