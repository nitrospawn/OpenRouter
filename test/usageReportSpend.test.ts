import test from 'node:test';
import assert from 'node:assert';
import { UsageStore } from '../src/usage/usageStore';

test('UsageStore getSpendSummary: calculates all-time total across all projects and models by default', async () => {
  const usageStore = new UsageStore();

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-Alpha',
    model: 'openai/gpt-4o',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cost: 0.10,
  });

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-Beta',
    model: 'anthropic/claude-3.5-sonnet',
    promptTokens: 200,
    completionTokens: 100,
    totalTokens: 300,
    cost: 0.25,
  });

  await usageStore.appendRecord({
    type: 'terminal_command',
    project: 'Project-Alpha',
    command: 'npm run build',
    cost: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });

  const summary = await usageStore.getSpendSummary();
  assert.strictEqual(summary.total, 0.35, 'Total spend should be the sum of all records');
});

test('UsageStore getSpendSummary: filters total cost by project', async () => {
  const usageStore = new UsageStore();

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-Alpha',
    model: 'openai/gpt-4o',
    cost: 0.15,
  });

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-Beta',
    model: 'openai/gpt-4o',
    cost: 0.50,
  });

  const alphaSummary = await usageStore.getSpendSummary({ project: 'Project-Alpha' });
  assert.strictEqual(alphaSummary.total, 0.15, 'Should only include costs from Project-Alpha');

  const betaSummary = await usageStore.getSpendSummary({ project: 'Project-Beta' });
  assert.strictEqual(betaSummary.total, 0.50, 'Should only include costs from Project-Beta');
});

test('UsageStore getSpendSummary: filters total cost by model', async () => {
  const usageStore = new UsageStore();

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-Alpha',
    model: 'openai/gpt-4o',
    cost: 0.20,
  });

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-Alpha',
    model: 'anthropic/claude-3.5-sonnet',
    cost: 0.80,
  });

  const gptSummary = await usageStore.getSpendSummary({ model: 'openai/gpt-4o' });
  assert.strictEqual(gptSummary.total, 0.20, 'Should only include costs for GPT-4o');

  const claudeSummary = await usageStore.getSpendSummary({ model: 'anthropic/claude-3.5-sonnet' });
  assert.strictEqual(claudeSummary.total, 0.80, 'Should only include costs for Claude 3.5 Sonnet');
});

test('UsageStore getSpendSummary: filters by both project AND model simultaneously', async () => {
  const usageStore = new UsageStore();

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-Alpha',
    model: 'openai/gpt-4o',
    cost: 0.10,
  });

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-Alpha',
    model: 'anthropic/claude-3.5-sonnet',
    cost: 0.40,
  });

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-Beta',
    model: 'openai/gpt-4o',
    cost: 0.70,
  });

  const combinedSummary = await usageStore.getSpendSummary({
    project: 'Project-Alpha',
    model: 'openai/gpt-4o',
  });
  assert.strictEqual(combinedSummary.total, 0.10, 'Should match only Project-Alpha using openai/gpt-4o');
});

test('UsageStore: terminal command record stores 0 cost, 0 tokens, and project', async () => {
  const usageStore = new UsageStore();

  const record = await usageStore.appendRecord({
    type: 'terminal_command',
    project: 'My-Workspace',
    command: 'git status',
    cwd: '/workspace',
    cost: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });

  assert.strictEqual(record.cost, 0);
  assert.strictEqual(record.promptTokens, 0);
  assert.strictEqual(record.completionTokens, 0);
  assert.strictEqual(record.totalTokens, 0);
  assert.strictEqual(record.project, 'My-Workspace');
  assert.strictEqual(record.type, 'terminal_command');
});

test('UsageStore getDistinctModels: returns only models used in the specified project', async () => {
  const usageStore = new UsageStore();

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-A',
    model: 'openai/gpt-4o',
    cost: 0.1,
  });

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-A',
    model: 'openai/o3-mini (High)',
    cost: 0.2,
  });

  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'Project-B',
    model: 'anthropic/claude-3.5-sonnet',
    cost: 0.3,
  });

  const allModels = await usageStore.getDistinctModels();
  assert.strictEqual(allModels.length, 3);
  assert.ok(allModels.includes('openai/gpt-4o'));
  assert.ok(allModels.includes('openai/o3-mini (High)'));
  assert.ok(allModels.includes('anthropic/claude-3.5-sonnet'));

  const projectAModels = await usageStore.getDistinctModels('Project-A');
  assert.strictEqual(projectAModels.length, 2);
  assert.ok(projectAModels.includes('openai/gpt-4o'));
  assert.ok(projectAModels.includes('openai/o3-mini (High)'));
  assert.strictEqual(projectAModels.includes('anthropic/claude-3.5-sonnet'), false);

  const projectBModels = await usageStore.getDistinctModels('Project-B');
  assert.strictEqual(projectBModels.length, 1);
  assert.ok(projectBModels.includes('anthropic/claude-3.5-sonnet'));
  assert.strictEqual(projectBModels.includes('openai/gpt-4o'), false);
});
