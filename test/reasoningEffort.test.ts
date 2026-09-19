import test from 'node:test';
import assert from 'node:assert';
import { detectModelCapabilities, getDefaultReasoningEffort } from '../src/api/modelCapabilities';
import { OpenRouterClient } from '../src/api/openrouterClient';
import { UsageStore } from '../src/usage/usageStore';

test('detectModelCapabilities: does not detect reasoning effort for standard models', () => {
  const gpt4o = {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    architecture: {
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
    },
  };
  const caps = detectModelCapabilities(gpt4o);
  assert.strictEqual(caps.supportsReasoningEffort, false);
  assert.strictEqual(caps.supportedReasoningEfforts, undefined);
});

test('detectModelCapabilities: detects reasoning effort and only shows supported levels', () => {
  const o3Mini = {
    id: 'openai/o3-mini',
    name: 'o3-mini',
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
    },
    supported_parameters: ['reasoning_effort'],
  };
  const caps = detectModelCapabilities(o3Mini);
  assert.strictEqual(caps.supportsReasoningEffort, true);
  assert.deepStrictEqual(caps.supportedReasoningEfforts, ['low', 'medium', 'high']);
});

test('OpenRouterClient.sendChatCompletionStream: includes reasoning_effort in outgoing payload', async () => {
  const originalFetch = globalThis.fetch;
  let capturedPayload: any = null;

  globalThis.fetch = async (_url: any, init: any) => {
    capturedPayload = JSON.parse(init.body);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Reasoning test response"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  try {
    let completed = false;
    await OpenRouterClient.sendChatCompletionStream(
      'fake-key',
      'openai/o3-mini',
      [{ role: 'user', content: 'test reasoning' }],
      () => {},
      () => { completed = true; },
      (err) => { throw err; },
      undefined,
      undefined,
      'high'
    );

    assert.ok(completed);
    assert.ok(capturedPayload);
    assert.strictEqual(capturedPayload.reasoning_effort, 'high');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenRouterClient.sendChatCompletionStream: retries without reasoning_effort if provider rejects with 400', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  const payloads: any[] = [];
  let fallbackCallbackFired = false;

  globalThis.fetch = async (_url: any, init: any) => {
    attempts++;
    payloads.push(JSON.parse(init.body));
    if (attempts === 1) {
      return new Response(
        JSON.stringify({ error: { message: 'Provider does not support reasoning_effort parameter' } }),
        { status: 400 }
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Fallback success"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  try {
    let collectedContent = '';
    await OpenRouterClient.sendChatCompletionStream(
      'fake-key',
      'openai/o3-mini',
      [{ role: 'user', content: 'test reasoning fallback' }],
      (chunk) => { collectedContent += chunk; },
      () => {},
      (err) => { throw err; },
      undefined,
      undefined,
      'medium',
      () => { fallbackCallbackFired = true; }
    );

    assert.strictEqual(attempts, 2, 'Should retry once without the unsupported parameter');
    assert.strictEqual(payloads[0].reasoning_effort, 'medium');
    assert.strictEqual(payloads[1].reasoning_effort, undefined, 'Second attempt must exclude reasoning_effort');
    assert.strictEqual(fallbackCallbackFired, true);
    assert.strictEqual(collectedContent, 'Fallback success');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UsageStore & Model Logging: distinguishes model effort level in Usage Report records', async () => {
  const usageStore = new UsageStore();
  
  // Log Turn 1 with High effort
  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'test-proj',
    model: 'openai/o3-mini (High)',
    promptTokens: 100,
    completionTokens: 500,
    totalTokens: 600,
    cost: 0.05,
  });

  // Log Turn 2 with Low effort
  await usageStore.appendRecord({
    type: 'chat_completion',
    project: 'test-proj',
    model: 'openai/o3-mini (Low)',
    promptTokens: 100,
    completionTokens: 80,
    totalTokens: 180,
    cost: 0.008,
  });

  const records = await usageStore.loadRecords();
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[0].model, 'openai/o3-mini (Low)');
  assert.strictEqual(records[1].model, 'openai/o3-mini (High)');

  const distinctModels = await usageStore.getDistinctModels();
  assert.ok(distinctModels.includes('openai/o3-mini (High)'));
  assert.ok(distinctModels.includes('openai/o3-mini (Low)'));
});

test('Switching effort level mid-conversation applies to next request sent', async () => {
  // Simulates user switching effort dropdown mid-conversation
  let currentReasoningEffort: string | undefined = 'medium';
  const sentPayloads: any[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url: any, init: any) => {
    sentPayloads.push(JSON.parse(init.body));
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  try {
    // Request 1: Medium effort
    await OpenRouterClient.sendChatCompletionStream(
      'key',
      'openai/o3-mini',
      [{ role: 'user', content: 'req 1' }],
      () => {},
      () => {},
      () => {},
      undefined,
      undefined,
      currentReasoningEffort
    );

    // User switches dropdown to 'high' mid-conversation
    currentReasoningEffort = 'high';

    // Request 2: High effort
    await OpenRouterClient.sendChatCompletionStream(
      'key',
      'openai/o3-mini',
      [{ role: 'user', content: 'req 2' }],
      () => {},
      () => {},
      () => {},
      undefined,
      undefined,
      currentReasoningEffort
    );

    assert.strictEqual(sentPayloads.length, 2);
    assert.strictEqual(sentPayloads[0].reasoning_effort, 'medium');
    assert.strictEqual(sentPayloads[1].reasoning_effort, 'high');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Switching to a model that does not support reasoning effort clears/ignores previous selection', async () => {
  // Simulates UI model switch behavior
  let currentReasoningEffort: string | undefined = 'high';

  // Model 1: supports reasoning
  const o3 = { id: 'openai/o3-mini', supported_parameters: ['reasoning_effort'] };
  const caps1 = detectModelCapabilities(o3 as any);
  assert.strictEqual(caps1.supportsReasoningEffort, true);

  // Model 2: text-only, no reasoning
  const gpt4oMini = { id: 'openai/gpt-4o-mini', architecture: { input_modalities: ['text'], output_modalities: ['text'] } };
  const caps2 = detectModelCapabilities(gpt4oMini as any);
  assert.strictEqual(caps2.supportsReasoningEffort, false);

  // When caps2 does not support reasoning effort, UI clears currentReasoningEffort
  if (!caps2.supportsReasoningEffort) {
    currentReasoningEffort = undefined;
  }

  const sentPayloads: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: any, init: any) => {
    sentPayloads.push(JSON.parse(init.body));
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  try {
    await OpenRouterClient.sendChatCompletionStream(
      'key',
      'openai/gpt-4o-mini',
      [{ role: 'user', content: 'req to gpt-4o-mini' }],
      () => {},
      () => {},
      () => {},
      undefined,
      undefined,
      currentReasoningEffort // Should be undefined now
    );

    assert.strictEqual(sentPayloads.length, 1);
    assert.strictEqual(sentPayloads[0].reasoning_effort, undefined, 'reasoning_effort must not be sent to unsupported model');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getDefaultReasoningEffort: defaults to low when supported, with robust fallbacks', () => {
  assert.strictEqual(getDefaultReasoningEffort(['low', 'medium', 'high']), 'low', 'Standard reasoning models must default to low');
  assert.strictEqual(getDefaultReasoningEffort(['medium', 'high']), 'medium', 'Should fallback to medium if low unavailable');
  assert.strictEqual(getDefaultReasoningEffort(['high', 'max']), 'high', 'Should fallback to first item if low and medium unavailable');
  assert.strictEqual(getDefaultReasoningEffort([]), 'low', 'Should default to low on empty array');
  assert.strictEqual(getDefaultReasoningEffort(undefined), 'low', 'Should default to low on undefined');
});
