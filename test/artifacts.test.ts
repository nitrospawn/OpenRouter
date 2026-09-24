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

test('extractArtifacts: extracts plan document when code fence uses ```implementation_plan alias', () => {
  const innerPlan = `# Implementation Plan for Feature\n1. Do step one\n2. Do step two`;
  const raw = `I have prepared the plan:\n\n\`\`\`implementation_plan\n${innerPlan}\n\`\`\`\n\nPlease review.`;

  const result = extractArtifacts(raw);
  assert.strictEqual(result.planDocument, innerPlan);
  assert.ok(result.chatSummary.includes('📄 Plan docs ready — [view]'));
  assert.ok(!result.chatSummary.includes(innerPlan));
});

test('extractArtifacts: extracts plan document when code fence uses ```implementation-plan alias', () => {
  const innerPlan = `# Implementation Plan\n1. Setup database\n2. Run migrations`;
  const raw = `\`\`\`implementation-plan\n${innerPlan}\n\`\`\``;

  const result = extractArtifacts(raw);
  assert.strictEqual(result.planDocument, innerPlan);
  assert.ok(result.chatSummary.includes('📄 Plan docs ready — [view]'));
});

test('extractArtifacts: resilient fallback extracts unfenced Markdown Implementation Plan', () => {
  const planMarkdown = `# Implementation Plan - Notepad App\n## Proposed Changes\n1. Create notepad.ts\n2. Add autosave feature\n\n## Verification\n- Run tests`;
  const raw = `I have analyzed your request and prepared the plan.\nWould you like me to proceed with this plan, or would you like to review or make adjustments first?\n\n${planMarkdown}`;

  const result = extractArtifacts(raw);
  assert.strictEqual(result.planDocument, planMarkdown);
  assert.ok(result.chatSummary.includes('📄 Plan docs ready — [view]'));
  assert.ok(result.chatSummary.includes('Would you like me to proceed with this plan'));
  assert.ok(!result.chatSummary.includes('## Proposed Changes'));
});

test('extractArtifacts: resilient fallback extracts unfenced Markdown Plan when user asks "plan only"', () => {
  const planMarkdown = `# Plan: Refactor Logger\n1. Create logger.ts\n2. Replace console.log statements`;
  const raw = `Here is the requested plan:\n\n${planMarkdown}`;

  const result = extractArtifacts(raw);
  assert.strictEqual(result.planDocument, planMarkdown);
  assert.ok(result.chatSummary.includes('📄 Plan docs ready — [view]'));
  assert.ok(!result.chatSummary.includes(planMarkdown));
});

test('ArtifactDocumentManager.prepareArtifactFile: creates and writes .md file to disk immediately', async () => {
  const historyStore = new HistoryStore();
  const msgId = 'msg-immediate-write-test';
  const planContent = '# Immediate Plan\n1. Action item';

  await historyStore.appendMessage({
    id: msgId,
    role: 'assistant',
    content: '📄 Plan docs ready — [view]',
    planDocument: planContent,
    timestamp: Date.now(),
  });

  const storageUri = vscode.Uri.file('C:/Users/test/AppData/Roaming/Code/User/workspaceStorage/12345/openrouter');
  const prepared = await ArtifactDocumentManager.prepareArtifactFile(
    historyStore,
    'plan',
    msgId,
    planContent,
    storageUri
  );

  assert.ok(prepared, 'prepareArtifactFile should return URI and content');
  assert.strictEqual(prepared?.content, planContent);
  assert.ok(prepared?.uri.fsPath.endsWith(`implementation_plan_${msgId}.md`));
});

test('ArtifactDocumentManager.prepareArtifactFile: resolves plan from previous turn in active session when current turn has planDocument undefined', async () => {
  const historyStore = new HistoryStore();
  const turn1Id = 'msg-turn-1-plan';
  const turn2Id = 'msg-turn-2-revision-summary';
  const authoritativePlan = '# Authoritative Plan Rev 1\n1. Initial step';

  // Turn 1 emitted full plan
  await historyStore.appendMessage({
    id: turn1Id,
    role: 'assistant',
    content: '📄 Plan docs ready — [view]',
    planDocument: authoritativePlan,
    timestamp: Date.now() - 5000,
  });

  // User asked to apply fixes
  await historyStore.appendMessage({
    id: 'msg-user-fixes',
    role: 'user',
    content: 'please apply this fixes to the plan',
    timestamp: Date.now() - 3000,
  });

  // Turn 2 assistant only summarized changes without repeating plan fence
  await historyStore.appendMessage({
    id: turn2Id,
    role: 'assistant',
    content: 'I have revised the Plan to Rev 2 applying all fixes.\n\n📄 Plan docs ready — [view]',
    planDocument: undefined, // omitted by model
    timestamp: Date.now() - 1000,
  });

  const storageUri = vscode.Uri.file('C:/Users/test/AppData/Roaming/Code/User/workspaceStorage/12345/openrouter');
  const prepared = await ArtifactDocumentManager.prepareArtifactFile(
    historyStore,
    'plan',
    turn2Id,
    undefined,
    storageUri
  );

  assert.ok(prepared, 'prepareArtifactFile should successfully recover the plan via active session history');
  assert.strictEqual(prepared?.content, authoritativePlan);
  assert.ok(prepared?.uri.fsPath.endsWith(`implementation_plan_${turn2Id}.md`));

  // Verify document can be opened without error
  const openedDoc = await ArtifactDocumentManager.openArtifactDocument(
    historyStore,
    'plan',
    turn2Id,
    undefined,
    storageUri
  );
  assert.ok(openedDoc, 'openArtifactDocument must return the document without failing');
});

test('ArtifactDocumentManager.prepareArtifactFile: extracts plan from raw message content when planDocument was un-extracted', async () => {
  const historyStore = new HistoryStore();
  const msgId = 'msg-raw-content-plan';
  const rawMarkdownPlan = '# Implementation Plan\n## Proposed Changes\n1. Add auth\n2. Add tests';

  await historyStore.appendMessage({
    id: msgId,
    role: 'assistant',
    content: `Here is the plan:\n\n\`\`\`plan\n${rawMarkdownPlan}\n\`\`\``,
    planDocument: undefined, // un-extracted
    timestamp: Date.now(),
  });

  const storageUri = vscode.Uri.file('C:/Users/test/AppData/Roaming/Code/User/workspaceStorage/12345/openrouter');
  const prepared = await ArtifactDocumentManager.prepareArtifactFile(
    historyStore,
    'plan',
    msgId,
    undefined,
    storageUri
  );

  assert.ok(prepared, 'prepareArtifactFile should extract plan from msg.content');
  assert.strictEqual(prepared?.content, rawMarkdownPlan);
});

test('ArtifactDocumentManager.prepareArtifactFile: falls back to active reviewer session artifactContent when session has no planDocument', async () => {
  const historyStore = new HistoryStore();
  const reviewerPlan = '# Reviewer Session Plan Document\n1. Critical fix';

  await historyStore.startNewReviewerSession('Review: Plan', {
    artifactType: 'plan',
    artifactContent: reviewerPlan,
  });

  const storageUri = vscode.Uri.file('C:/Users/test/AppData/Roaming/Code/User/workspaceStorage/12345/openrouter');
  const prepared = await ArtifactDocumentManager.prepareArtifactFile(
    historyStore,
    'plan',
    undefined,
    undefined,
    storageUri
  );

  assert.ok(prepared, 'prepareArtifactFile should recover the plan from active reviewer session');
  assert.strictEqual(prepared?.content, reviewerPlan);
});

test('extractArtifacts: omits redundant leading intent preamble when trailing response summary exists', () => {
  const innerPlan = `# Implementation Plan\n## Proposed Changes\n1. Add auth`;
  const leadingPreamble = `I'll apply all the reviewer fixes to the Phase 1 plan. Here's the fully revised plan addressing each finding (FIX-1 through FIX-9), with Resolved Risks mapping and an updated Verification Plan.`;
  const trailingResponse = `I have revised the implementation plan to resolve all nine review findings — including the SQLCipher/FTS5 spike, kill-safe autosave, key-loss recovery screen, full schema DDL, media lifecycle cleanup, migration policy, signing security, and testability revisions. Would you like me to proceed with this plan, or would you like to review or make adjustments first?`;

  const raw = `${leadingPreamble}\n\n\`\`\`plan\n${innerPlan}\n\`\`\`\n\n${trailingResponse}`;
  const result = extractArtifacts(raw);

  assert.strictEqual(result.planDocument, innerPlan);
  assert.ok(!result.chatSummary.includes(leadingPreamble), 'The leading intent preamble must be stripped from chatSummary');
  assert.ok(result.chatSummary.includes(trailingResponse), 'The trailing response summary must be preserved');
  assert.ok(result.chatSummary.includes('📄 Plan docs ready — [view]'));
});

test('extractArtifacts: strips <think> reasoning tags cleanly from chatSummary', () => {
  const innerPlan = `# Implementation Plan\n1. Do work`;
  const reasoning = `Thinking Process:\n1. Analyze requirements\n2. Figure out solution`;
  const response = `I have prepared the plan. Would you like me to proceed?`;

  const raw = `<think>\n${reasoning}\n</think>\n\n\`\`\`plan\n${innerPlan}\n\`\`\`\n\n${response}`;
  const result = extractArtifacts(raw);

  assert.strictEqual(result.planDocument, innerPlan);
  assert.ok(!result.chatSummary.includes('<think>'), 'Chat summary must not include <think> tags');
  assert.ok(!result.chatSummary.includes(reasoning), 'Chat summary must not include internal thinking text');
  assert.ok(result.chatSummary.includes(response), 'Chat summary must retain the actual response');
});

test('extractArtifacts: deduplicates multiple plan notice tokens when model manually emits one and fence is replaced', () => {
  const innerPlan = `# Implementation Plan\n1. Step A\n2. Step B`;
  const raw = `I have updated the plan.\n\nWould you like me to proceed?\n\n📄 Plan docs ready — [view]\n\n\`\`\`plan\n${innerPlan}\n\`\`\``;
  const result = extractArtifacts(raw);

  assert.strictEqual(result.planDocument, innerPlan);
  const matches = result.chatSummary.match(/📄\s*(?:Plan docs ready|Plan docs|Implementation plan ready|Plan ready)\s*(?:[—–-]\s*\[view\])?/gi);
  assert.strictEqual(matches?.length, 1, 'chatSummary must contain exactly one plan notice capsule');
  assert.ok(result.chatSummary.includes('Would you like me to proceed?'));
});

test('extractArtifacts: deduplicates repeated plan notice tokens in trailing text', () => {
  const innerPlan = `# Implementation Plan\n1. Step A`;
  const raw = `Updated plan.\n\n\`\`\`plan\n${innerPlan}\n\`\`\`\n\nWould you like to review?\n\n📄 Plan docs ready — [view]\n\n📄 Plan docs ready — [view]`;
  const result = extractArtifacts(raw);

  assert.strictEqual(result.planDocument, innerPlan);
  const matches = result.chatSummary.match(/📄\s*(?:Plan docs ready|Plan docs|Implementation plan ready|Plan ready)\s*(?:[—–-]\s*\[view\])?/gi);
  assert.strictEqual(matches?.length, 1, 'chatSummary must collapse duplicate trailing notices to exactly one');
});

test('extractArtifacts: deduplicates repeated walkthrough notice tokens cleanly', () => {
  const innerWalkthrough = `# Walkthrough\n1. All tests pass`;
  const raw = `Results ready.\n\n\`\`\`walkthrough\n${innerWalkthrough}\n\`\`\`\n\n📄 Results docs ready — [view]\n\n📄 Results docs ready — [view]`;
  const result = extractArtifacts(raw);

  assert.strictEqual(result.walkthroughDocument, innerWalkthrough);
  const matches = result.chatSummary.match(/📄\s*(?:Results docs ready|Results docs|Walkthrough result|Walkthrough ready|Result walkthrough)\s*(?:[—–-]\s*\[view\])?/gi);
  assert.strictEqual(matches?.length, 1, 'chatSummary must collapse duplicate walkthrough notices to exactly one');
});
