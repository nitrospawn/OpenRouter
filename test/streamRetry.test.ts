import test from 'node:test';
import assert from 'node:assert';
import { OpenRouterClient } from '../src/api/openrouterClient';

test('OpenRouterClient.sendChatCompletionStream: retries transient network errors up to 2 times and succeeds', async () => {
  let attempts = 0;
  const originalFetch = globalThis.fetch;

  // Mock global fetch: fail on attempt 1 with 'fetch failed', then succeed on attempt 2
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) {
      throw new TypeError('fetch failed');
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello world!"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(stream, { status: 200 });
  };

  try {
    let collectedContent = '';
    let completed = false;
    let errorReceived: Error | undefined;

    await OpenRouterClient.sendChatCompletionStream(
      'fake-key',
      'openai/gpt-4o-mini',
      [{ role: 'user', content: 'hi' }],
      (chunk) => {
        collectedContent += chunk;
      },
      () => {
        completed = true;
      },
      (err) => {
        errorReceived = err;
      }
    );

    assert.strictEqual(attempts, 2, 'Should have retried once after first failure');
    assert.strictEqual(collectedContent, 'Hello world!');
    assert.strictEqual(completed, true);
    assert.strictEqual(errorReceived, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenRouterClient.sendChatCompletionStream: exhausts 2 retries (3 total attempts) before reporting error', async () => {
  let attempts = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    attempts++;
    throw new TypeError('fetch failed');
  };

  try {
    let errorReceived: Error | undefined;

    await OpenRouterClient.sendChatCompletionStream(
      'fake-key',
      'openai/gpt-4o-mini',
      [{ role: 'user', content: 'hi' }],
      () => {},
      () => {},
      (err) => {
        errorReceived = err;
      }
    );

    assert.strictEqual(attempts, 3, 'Should attempt 1 initial + 2 retries = 3 attempts total');
    assert.ok(errorReceived);
    assert.ok(errorReceived.message.includes('fetch failed'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UsageStore: failed retry attempts are never written to usageStore, only the eventual successful attempt is', async () => {
  let attempts = 0;
  const originalFetch = globalThis.fetch;

  // Mock fetch: fails on attempt 1 with 500 error, succeeds on attempt 2 with usage tokens
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: { message: 'Internal Server Error' } }), { status: 500 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Success after retry"}}],"usage":{"prompt_tokens":15,"completion_tokens":5,"total_tokens":20}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(stream, { status: 200 });
  };

  const loggedRecords: any[] = [];
  const mockUsageStore: any = {
    appendRecord: async (rec: any) => {
      loggedRecords.push(rec);
    },
  };

  try {
    let finalUsage: any;
    let errorReceived: Error | undefined;

    await OpenRouterClient.sendChatCompletionStream(
      'fake-key',
      'openai/gpt-4o-mini',
      [{ role: 'user', content: 'hi' }],
      () => {},
      async (usage) => {
        finalUsage = usage;
        if (usage) {
          await mockUsageStore.appendRecord({
            type: 'chat_completion',
            project: 'test-project',
            model: 'openai/gpt-4o-mini',
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            cost: 0.0001,
          });
        }
      },
      (err) => {
        errorReceived = err;
      }
    );

    // Verify retries took place
    assert.strictEqual(attempts, 2);
    assert.strictEqual(errorReceived, undefined);
    assert.ok(finalUsage);
    assert.strictEqual(finalUsage.total_tokens, 20);

    // Verify EXACTLY one record was logged to usageStore (the successful attempt), never the failed attempt
    assert.strictEqual(loggedRecords.length, 1);
    assert.strictEqual(loggedRecords[0].totalTokens, 20);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenRouterClient.fetchModels: retries transient network errors up to 2 times and succeeds', async () => {
  let attempts = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) {
      throw new TypeError('fetch failed');
    }
    return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' }] }), { status: 200 });
  };

  try {
    const models = await OpenRouterClient.fetchModels('fake-key');
    assert.strictEqual(attempts, 2);
    assert.strictEqual(models.length, 1);
    assert.strictEqual(models[0].id, 'openai/gpt-4o-mini');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

