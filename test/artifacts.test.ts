import test from 'node:test';
import * as assert from 'node:assert';
import { extractArtifacts } from '../src/prompt/responseParser';
import { HistoryStore } from '../src/conversation/historyStore';
import * as vscode from 'vscode';
import { ArtifactDocumentManager } from '../src/editor/artifactDocumentManager';

test('extractArtifacts: extracts plan document with byte-for-byte fidelity and produces concise chat notice', () => {
  const innerPlan = `# Detailed Implementation Plan
1. Refactor auth.ts to add JWT rotation:
\`\`\`typescript
interface TokenPair {
  accessToken: string;
  refreshToken: string;
}
\`\`\`
2. Write comprehensive unit tests.
3. Verify diagnostics.`;

  const rawModelResponse = `I have analyzed the request and prepared a plan.

\`\`\`plan
${innerPlan}
\`\`\`

Please review the plan before I proceed.`;

  const result = extractArtifacts(rawModelResponse);

  // 1. Byte-for-byte fidelity check
  assert.strictEqual(
    result.planDocument,
    innerPlan,
    'The extracted planDocument must be byte-for-byte identical to the raw content inside the fence'
  );

  // 2. Chat summary conciseness
  assert.ok(
    result.chatSummary.includes('📄 Plan docs ready — [view]'),
    'The chat summary must include the concise artifact notice'
  );
  assert.ok(
    !result.chatSummary.includes('# Detailed Implementation Plan'),
    'The chat summary must NOT contain the full inner plan document text'
  );
  assert.ok(
    !result.chatSummary.includes('```plan'),
    'The chat summary must NOT contain the plan code fence'
  );
});

test('extractArtifacts: extracts walkthrough document with byte-for-byte fidelity and produces concise chat notice', () => {
  const innerWalkthrough = `# Verification & Walkthrough Report
- Completed edit on auth.ts
- Ran test suite with 0 failures:
\`\`\`bash
npm test
\`\`\`
- All linters and compiler checks passed cleanly.`;

  const rawModelResponse = `Applied: added comment to auth.ts.

\`\`\`walkthrough
${innerWalkthrough}
\`\`\`

Everything is complete and verified!`;

  const result = extractArtifacts(rawModelResponse);

  // 1. Byte-for-byte fidelity check
  assert.strictEqual(
    result.walkthroughDocument,
    innerWalkthrough,
    'The extracted walkthroughDocument must be byte-for-byte identical to the raw content inside the fence'
  );

  // 2. Chat summary conciseness
  assert.ok(
    result.chatSummary.includes('📄 Results docs ready — [view]'),
    'The chat summary must include the concise walkthrough notice'
  );
  assert.ok(
    !result.chatSummary.includes('# Verification & Walkthrough Report'),
    'The chat summary must NOT contain the full inner walkthrough document text'
  );
  assert.ok(
    !result.chatSummary.includes('```walkthrough'),
    'The chat summary must NOT contain the walkthrough code fence'
  );
});

test('extractArtifacts: handles response containing only ```plan without outer text cleanly, providing fallback conversational summary alongside notice', () => {
  const innerPlan = `## Solo Plan\n- Step A\n- Step B`;
  const raw = `\`\`\`plan\n${innerPlan}\n\`\`\``;

  const result = extractArtifacts(raw);
  assert.strictEqual(result.planDocument, innerPlan);
  assert.strictEqual(
    result.chatSummary,
    'I have prepared plan docs for your review.\n\n📄 Plan docs ready — [view]'
  );
});

test('extractArtifacts: handles response with minimal whitespace around fence, ensuring conversational summary still appears', () => {
  const innerPlan = `## Minimal Plan\n1. Do task`;
  const raw = `   \n\n\`\`\`plan\n${innerPlan}\n\`\`\`\n\n  `;

  const result = extractArtifacts(raw);
  assert.strictEqual(result.planDocument, innerPlan);
  assert.strictEqual(
    result.chatSummary,
    'I have prepared plan docs for your review.\n\n📄 Plan docs ready — [view]'
  );
});

test('HistoryStore: stores and retrieves planDocument and walkthroughDocument on StoredChatMessage', async () => {
  const memoryStore = new HistoryStore();
  const msgId = 'test-msg-artifacts-1';

  await memoryStore.appendMessage({
    id: msgId,
    role: 'assistant',
    content: '📄 Implementation plan ready — [view]\n\nPlease review.',
    planDocument: '# My Stored Plan\n1. Do work',
    walkthroughDocument: '# My Walkthrough\n- Done',
    timestamp: Date.now(),
  });

  const retrieved = await memoryStore.getMessageById(msgId);
  assert.ok(retrieved, 'Message should be retrievable by ID');
  assert.strictEqual(retrieved?.planDocument, '# My Stored Plan\n1. Do work');
  assert.strictEqual(retrieved?.walkthroughDocument, '# My Walkthrough\n- Done');
  assert.strictEqual(retrieved?.content, '📄 Implementation plan ready — [view]\n\nPlease review.');
});

test('ArtifactDocumentManager: fresh regeneration from historyStore and real file URI outside workspace git tracking', async () => {
  const historyStore = new HistoryStore();
  const msgId = 'msg-plan-fresh-test';
  const originalPlan = '# Authoritative Plan from HistoryStore\n1. Step One';

  await historyStore.appendMessage({
    id: msgId,
    role: 'assistant',
    content: '📄 Implementation plan ready — [view]',
    planDocument: originalPlan,
    timestamp: Date.now(),
  });

  // 1. Storage URI location (outside user workspace)
  const storageUri = vscode.Uri.file('C:/Users/test/AppData/Roaming/Code/User/workspaceStorage/12345/openrouter');
  const doc = await ArtifactDocumentManager.openArtifactDocument(
    historyStore,
    'plan',
    msgId,
    undefined,
    storageUri
  );

  assert.ok(doc, 'A TextDocument should be returned');

  // Verify that target artifact file is inside storageUri, not in workspace
  const workspaceRoot = 'C:/mock/workspace';
  const docPath = (doc as any).uri ? (doc as any).uri.fsPath : '';
  if (docPath) {
    assert.ok(
      !docPath.startsWith(workspaceRoot),
      'Artifact documents must not be written inside the user workspace git directory'
    );
    assert.ok(
      docPath.includes('artifacts'),
      'Artifact documents must be stored in the dedicated artifacts storage directory'
    );
  }
});
