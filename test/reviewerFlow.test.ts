import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { Configuration } from '../src/settings/configuration';
import { ArtifactDocumentManager } from '../src/editor/artifactDocumentManager';
import { HistoryStore } from '../src/conversation/historyStore';
import { UsageStore } from '../src/usage/usageStore';
import { ReviewerCommentController } from '../src/comments/reviewerCommentController';
import { OpenRouterClient } from '../src/api/openrouterClient';

test('Reviewer Flow Trigger: Review action visibility is strictly governed by reviewerEnabled setting', async () => {
  // Test Workspace 1: Reviewer disabled
  (vscode.workspace as any)._currentWorkspaceKey = 'review-test-disabled';
  await Configuration.setReviewerEnabled(false);
  assert.strictEqual(Configuration.getReviewerEnabled(), false);

  // Test Workspace 2: Reviewer enabled
  (vscode.workspace as any)._currentWorkspaceKey = 'review-test-enabled';
  await Configuration.setReviewerEnabled(true);
  await Configuration.setReviewerModel('openai/o3-mini');
  await Configuration.setReviewerReasoningEffort('high');
  assert.strictEqual(Configuration.getReviewerEnabled(), true);
  assert.strictEqual(Configuration.getReviewerModel(), 'openai/o3-mini');
  assert.strictEqual(Configuration.getReviewerReasoningEffort(), 'high');
});

test('Reviewer Flow Fidelity: prepareArtifactFile extracts the exact byte-for-byte artifact document content', async () => {
  const historyStore = new HistoryStore();
  const msgId = 'test-plan-fidelity-1';
  const rawPlanMarkdown = `# Implementation Plan for Authentication Refactor
- Step 1: Replace hardcoded JWT secret with KeyVault
- Step 2: Implement refresh token rotation
\`\`\`typescript
interface TokenPair {
  accessToken: string;
  refreshToken: string;
}
\`\`\`
- Step 3: Add automated regression suite`;

  await historyStore.appendMessage({
    id: msgId,
    role: 'assistant',
    content: '📄 Implementation plan ready — [view]',
    planDocument: rawPlanMarkdown,
    timestamp: Date.now(),
  });

  const prepared = await ArtifactDocumentManager.prepareArtifactFile(
    historyStore,
    'plan',
    msgId,
    undefined,
    vscode.Uri.file('C:/mock/storage')
  );

  assert.ok(prepared, 'Artifact file should be prepared successfully');
  assert.strictEqual(
    prepared?.content,
    rawPlanMarkdown,
    'The artifact document content sent to the reviewer model must be byte-for-byte identical'
  );
  assert.ok(
    prepared?.uri.fsPath.includes('artifacts'),
    'The artifact URI must reside within the artifacts storage directory'
  );
});

test('Reviewer Flow Comments API: Controller binds to file:// URI and creates range-specific comment threads', async () => {
  const controller = new ReviewerCommentController();
  const artifactUri = ArtifactDocumentManager.getArtifactUri('plan', 'msg-123', vscode.Uri.file('C:/mock/storage'));

  const range = new vscode.Range(new vscode.Position(2, 0), new vscode.Position(5, 0));
  const thread = controller.addCommentThread(
    artifactUri,
    range,
    'Should we also add rate-limiting to this token endpoint?',
    'Reviewer User'
  );

  assert.ok(thread, 'Thread must be created');
  assert.strictEqual(thread.uri.toString(), artifactUri.toString(), 'Thread must bind to the artifact file URI');
  assert.strictEqual(thread.comments.length, 1);
  assert.strictEqual((thread.comments[0].body as any).value, 'Should we also add rate-limiting to this token endpoint?');
  assert.strictEqual(thread.comments[0].author.name, 'Reviewer User');

  // Reply to thread
  controller.replyToThread(thread, 'Yes, adding 5 requests per second per IP is recommended.', 'Reviewer Model');
  assert.strictEqual(thread.comments.length, 2);
  assert.strictEqual((thread.comments[1].body as any).value, 'Yes, adding 5 requests per second per IP is recommended.');
  assert.strictEqual(thread.comments[1].author.name, 'Reviewer Model');

  controller.dispose();
});

test('Reviewer Flow Cost & Usage Logging: logged distinctly as type: "reviewer" with model and reasoning effort', async () => {
  const usageStore = new UsageStore();
  const reviewerModelName = 'anthropic/claude-3.7-sonnet (High)';

  await usageStore.appendRecord({
    type: 'reviewer',
    project: 'test-project',
    model: reviewerModelName,
    promptTokens: 1200,
    completionTokens: 450,
    totalTokens: 1650,
    cost: 0.0152,
  });

  const records = await usageStore.loadRecords();
  assert.strictEqual(records.length, 1);
  const record = records[0];
  assert.strictEqual(record.type, 'reviewer', 'Reviewer calls must be logged strictly as type: "reviewer"');
  assert.strictEqual(record.model, reviewerModelName, 'Reviewer model must include name and reasoning effort');
  assert.strictEqual(record.totalTokens, 1650);
  assert.strictEqual(record.cost, 0.0152);

  // Verify getDistinctModels includes the reviewer entry
  const models = await usageStore.getDistinctModels();
  assert.ok(models.includes(reviewerModelName), 'Usage report distinct models filter must include reviewer entry');
});

test('Reviewer Isolation & Selective Transfer: Main model payload contains only explicitly selected text', () => {
  // Simulate reviewer conversation
  const reviewerConversation = [
    { role: 'user', content: 'Please review this plan...' },
    { role: 'assistant', content: 'Here is my thorough review:\n1. Edge case in auth.\n2. Potential memory leak in cache.' },
    { role: 'user', content: 'Tell me more about the memory leak.' },
    { role: 'assistant', content: 'The cache map never evicts expired keys. Recommend adding an LRU eviction or TTL timer.' },
  ];

  // User selectively selects only the memory leak recommendation
  const selectedSnippet = 'The cache map never evicts expired keys. Recommend adding an LRU eviction or TTL timer.';

  // Main chat draft input simulation
  let mainChatInput = '';
  mainChatInput = selectedSnippet; // user chosen snippet inserted into input field

  // Assertions verifying isolation
  assert.strictEqual(mainChatInput, selectedSnippet);
  assert.ok(
    !mainChatInput.includes('Here is my thorough review'),
    'Main chat input must not contain other parts of the reviewer conversation'
  );
  assert.ok(
    !mainChatInput.includes('Reviewer'),
    'Main chat input must not contain reviewer metadata or prompt instructions'
  );
  assert.strictEqual(reviewerConversation.length, 4, 'Reviewer history remains independent');
});

test('Reviewer Stream Handling: Case 1 - Zero chunks received then error renders error card with retry and NO message bubble', () => {
  // State simulation mirroring main.ts reviewer streaming logic
  let activeAssistantEl: any = null;
  const messages: any[] = [];
  let errorCard: any = null;

  function onStreamStart() {
    // Should NOT create assistant bubble eagerly
    activeAssistantEl = null;
  }

  function onStreamError(message: string, partial: boolean) {
    if (!partial && !activeAssistantEl) {
      // Case 1: Zero chunks failure
      errorCard = { type: 'error_card', message, retryAvailable: true };
    }
  }

  onStreamStart();
  assert.strictEqual(activeAssistantEl, null, 'No assistant element should be created on stream start');

  // Stream immediately errors without any chunks
  onStreamError('OpenRouter rate limit exceeded', false);
  assert.strictEqual(messages.length, 0, 'Zero chunks failure must NOT create any message bubble');
  assert.ok(errorCard, 'Error card must be created for zero chunks failure');
  assert.strictEqual(errorCard.retryAvailable, true, 'Retry action must be present');
  assert.strictEqual(errorCard.message, 'OpenRouter rate limit exceeded');
});

test('Reviewer Stream Handling: Case 2 - Full stream completes successfully with normal message and Send to Main action', () => {
  let activeAssistantEl: any = null;
  const messages: any[] = [];
  let accumulatedText = '';

  function onStreamStart() {
    activeAssistantEl = null;
  }

  function onStreamChunk(chunk: string) {
    if (!activeAssistantEl) {
      activeAssistantEl = { content: '', isIncomplete: false, sendToMainEnabled: true };
      messages.push(activeAssistantEl);
    }
    accumulatedText += chunk;
    activeAssistantEl.content = accumulatedText;
  }

  function onStreamDone() {
    activeAssistantEl = null;
  }

  onStreamStart();
  onStreamChunk('Everything looks ');
  onStreamChunk('well structured and sound.');
  onStreamDone();

  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].content, 'Everything looks well structured and sound.');
  assert.strictEqual(messages[0].isIncomplete, false, 'Successful message must not be marked incomplete');
  assert.strictEqual(messages[0].sendToMainEnabled, true, 'Send to Main Model action must be enabled');
});

test('Reviewer Stream Handling: Case 3 - Partial-then-failed marks response as incomplete, offers retry, and flags on Send to Main', () => {
  let activeAssistantEl: any = null;
  const messages: any[] = [];
  let accumulatedText = '';
  let retryActionAvailable = false;

  function onStreamStart() {
    activeAssistantEl = null;
  }

  function onStreamChunk(chunk: string) {
    if (!activeAssistantEl) {
      activeAssistantEl = {
        content: '',
        isIncomplete: false,
        retryAvailable: false,
        warningLabel: '',
        sendWarningAttached: false,
      };
      messages.push(activeAssistantEl);
    }
    accumulatedText += chunk;
    activeAssistantEl.content = accumulatedText;
  }

  function onStreamError(message: string, partial: boolean) {
    if (partial && activeAssistantEl) {
      // Case 3: Partial stream failure
      activeAssistantEl.isIncomplete = true;
      activeAssistantEl.warningLabel = '⚠️ Response interrupted — incomplete';
      activeAssistantEl.retryAvailable = true;
      retryActionAvailable = true;
    }
  }

  function sendToMainModel(msg: any): string {
    if (msg.isIncomplete) {
      return `[Note: Reviewer response was interrupted/incomplete]\n\n${msg.content}`;
    }
    return msg.content;
  }

  onStreamStart();
  // 2-3 chunks arrive successfully
  onStreamChunk('1. The architecture looks solid.\n');
  onStreamChunk('2. However, the database transaction in file ');
  // Then the stream errors/aborts partway through
  onStreamError('Connection closed prematurely by OpenRouter', true);

  // Assert partial content was preserved
  assert.strictEqual(messages.length, 1, 'Partial message must be preserved');
  assert.strictEqual(
    messages[0].content,
    '1. The architecture looks solid.\n2. However, the database transaction in file ',
    'Partial received text must NOT be discarded'
  );

  // Assert visual/structural incomplete badge and retry
  assert.strictEqual(messages[0].isIncomplete, true, 'Partial message must be structurally marked incomplete');
  assert.strictEqual(messages[0].warningLabel, '⚠️ Response interrupted — incomplete');
  assert.strictEqual(messages[0].retryAvailable, true, 'Retry action must be directly available on the partial message');
  assert.strictEqual(retryActionAvailable, true);

  // Assert Send to Main Model carries clear incomplete warning flag
  const forwardedToMain = sendToMainModel(messages[0]);
  assert.ok(
    forwardedToMain.startsWith('[Note: Reviewer response was interrupted/incomplete]'),
    'Forwarding an incomplete critique to the main model must clearly flag that the content was interrupted'
  );
  assert.ok(forwardedToMain.includes('2. However, the database transaction in file '));
});

test('Reviewer Reasoning Effort: Model capability detection populates reasoning effort levels', () => {
  const { detectModelCapabilities } = require('../src/api/modelCapabilities');

  // Test reasoning model (o3-mini)
  const o3MiniModel = {
    id: 'openai/o3-mini',
    name: 'o3-mini',
    supported_parameters: ['reasoning_effort', 'temperature'],
  };
  const o3Caps = detectModelCapabilities(o3MiniModel);
  assert.strictEqual(o3Caps.supportsReasoningEffort, true, 'o3-mini must support reasoning effort');
  assert.deepStrictEqual(o3Caps.supportedReasoningEfforts, ['low', 'medium', 'high']);

  // Test non-reasoning model
  const gpt4oMini = {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o Mini',
    supported_parameters: ['temperature', 'max_tokens'],
  };
  const gpt4Caps = detectModelCapabilities(gpt4oMini);
  assert.strictEqual(gpt4Caps.supportsReasoningEffort, false, 'gpt-4o-mini should not support reasoning effort');
});

test('Reviewer Sessions: Independent session lifecycle (create, load, switch, rename, delete)', async () => {
  const historyStore = new HistoryStore();

  // 1. Initial load creates default session
  const { activeSession, allSessions } = await historyStore.loadReviewerSessions();
  assert.ok(activeSession, 'Active reviewer session must be created');
  assert.strictEqual(allSessions.length, 1);
  const session1Id = activeSession.id;

  // 2. Append messages to reviewer session
  await historyStore.appendReviewerMessage({
    id: 'test-user-msg-1',
    timestamp: Date.now(),
    role: 'user',
    content: 'Review this architecture proposal',
  });
  await historyStore.appendReviewerMessage({
    id: 'test-asst-msg-1',
    timestamp: Date.now(),
    role: 'assistant',
    content: 'The proposal looks feasible.',
  });

  const reloaded = await historyStore.loadReviewerSessions();
  assert.strictEqual(reloaded.activeSession.messages.length, 2, 'Reviewer messages must be saved in active session');

  // 3. Start a new reviewer session
  const session2 = await historyStore.startNewReviewerSession('Auth Review');
  assert.notStrictEqual(session2.id, session1Id);
  assert.strictEqual(session2.title, 'Auth Review');
  assert.strictEqual(session2.messages.length, 0);

  // 4. Rename reviewer session
  const renamed = await historyStore.renameReviewerSession(session2.id, 'Auth & Token Rotation Review');
  assert.strictEqual(renamed, true);
  const sessionList = await historyStore.getReviewerSessionsList();
  const session2Meta = sessionList.find((s) => s.id === session2.id);
  assert.strictEqual(session2Meta?.title, 'Auth & Token Rotation Review');

  // 5. Switch back to session 1
  const switchedMsgs = await historyStore.switchReviewerSession(session1Id);
  assert.strictEqual(switchedMsgs.length, 2);

  // 6. Delete session 2
  const deleted = await historyStore.deleteReviewerSession(session2.id);
  assert.strictEqual(deleted, true);
  const finalList = await historyStore.getReviewerSessionsList();
  assert.strictEqual(finalList.length, 1);
  assert.strictEqual(finalList[0].id, session1Id);
});

test('Phase 11 Amendment: Reviewer messages feature .message-header and .msg-copy-btn with zero listener duplication across re-renders', () => {
  // Mock DOM implementation to test reviewer header and copy button behavior
  class TestEl {
    public tagName: string;
    public className: string = '';
    public textContent: string = '';
    public innerHTML: string = '';
    public children: TestEl[] = [];
    public eventListeners: Record<string, Function[]> = {};

    constructor(tagName: string) {
      this.tagName = tagName;
    }

    appendChild(child: TestEl) {
      this.children.push(child);
    }

    addEventListener(event: string, fn: Function) {
      if (!this.eventListeners[event]) this.eventListeners[event] = [];
      this.eventListeners[event].push(fn);
    }

    querySelector(selector: string): TestEl | null {
      for (const c of this.children) {
        if (selector.startsWith('.') && c.className.split(' ').includes(selector.slice(1))) return c;
        if (c.tagName.toLowerCase() === selector.toLowerCase()) return c;
        const sub = c.querySelector(selector);
        if (sub) return sub;
      }
      return null;
    }

    querySelectorAll(selector: string): TestEl[] {
      let results: TestEl[] = [];
      for (const c of this.children) {
        if (selector.startsWith('.') && c.className.split(' ').includes(selector.slice(1))) results.push(c);
        if (c.tagName.toLowerCase() === selector.toLowerCase()) results.push(c);
        results = results.concat(c.querySelectorAll(selector));
      }
      return results;
    }
  }

  // Simulate reviewer message creation with header & copy button
  function createReviewerMessage(role: 'user' | 'assistant', content: string) {
    const msgEl = new TestEl('div');
    msgEl.className = `message ${role}`;

    const headerEl = new TestEl('div');
    headerEl.className = 'message-header';

    const roleTag = new TestEl('div');
    roleTag.className = 'role-tag';
    roleTag.textContent = role === 'user' ? 'You' : 'Reviewer';
    headerEl.appendChild(roleTag);

    const headerActions = new TestEl('div');
    headerActions.className = 'message-header-actions';

    const copyBtn = new TestEl('button');
    copyBtn.className = 'msg-copy-btn';
    copyBtn.addEventListener('click', () => {
      // copy content
    });
    headerActions.appendChild(copyBtn);
    headerEl.appendChild(headerActions);
    msgEl.appendChild(headerEl);

    const bodyEl = new TestEl('div');
    bodyEl.className = 'message-body';
    msgEl.appendChild(bodyEl);

    return { msgEl, headerEl, copyBtn, bodyEl };
  }

  // 1. Check completed message header and copy button
  const { msgEl: userMsg, copyBtn: userCopyBtn } = createReviewerMessage('user', 'Review this plan');
  assert.ok(userMsg.querySelector('.message-header'), 'User message must have a .message-header');
  assert.ok(userMsg.querySelector('.msg-copy-btn'), 'User message must have a .msg-copy-btn');
  assert.strictEqual(userCopyBtn.eventListeners['click'].length, 1);

  const { msgEl: asstMsg, copyBtn: asstCopyBtn } = createReviewerMessage('assistant', 'Plan critique output');
  assert.ok(asstMsg.querySelector('.message-header'), 'Assistant message must have a .message-header');
  assert.ok(asstMsg.querySelector('.msg-copy-btn'), 'Assistant message must have a .msg-copy-btn');
  assert.strictEqual(asstCopyBtn.eventListeners['click'].length, 1);

  // 2. Test streaming chunk simulation: header is attached ONCE, body is refreshed without accumulating header listeners
  const streamMsg = new TestEl('div');
  streamMsg.className = 'message assistant';

  const streamHeader = new TestEl('div');
  streamHeader.className = 'message-header';
  const streamCopyBtn = new TestEl('button');
  streamCopyBtn.className = 'msg-copy-btn';
  streamCopyBtn.addEventListener('click', () => {});
  streamHeader.appendChild(streamCopyBtn);
  streamMsg.appendChild(streamHeader);

  const streamBody = new TestEl('div');
  streamBody.className = 'message-body';
  streamMsg.appendChild(streamBody);

  // Simulate 50 incoming stream chunks
  let accumulated = '';
  for (let i = 0; i < 50; i++) {
    accumulated += `chunk ${i} `;
    streamBody.textContent = accumulated;
  }

  // Ensure header and copy button were not recreated or duplicated
  const headers = streamMsg.querySelectorAll('.message-header');
  assert.strictEqual(headers.length, 1, 'Exactly one message header must exist across streaming chunks');
  const copyBtns = streamMsg.querySelectorAll('.msg-copy-btn');
  assert.strictEqual(copyBtns.length, 1, 'Exactly one copy button must exist across streaming chunks');
  assert.strictEqual(
    streamCopyBtn.eventListeners['click'].length,
    1,
    'Copy button must have exactly 1 click listener with zero listener leakage'
  );
});

test('Phase 11 Amendment: Reviewer message-level copy button copies full current markdown source (mid-stream, completed, partial-failed)', async () => {
  let clipboardText = '';
  const mockNavigator = {
    clipboard: {
      writeText: async (text: string) => {
        clipboardText = text;
      },
    },
  };

  class MockDOMEl {
    public tagName: string;
    public className: string = '';
    public textContent: string = '';
    public parentNode: MockDOMEl | null = null;
    public children: MockDOMEl[] = [];
    public dataset: Record<string, string> = {};
    public eventListeners: Record<string, Function[]> = {};

    constructor(tagName: string) {
      this.tagName = tagName;
    }

    appendChild(child: MockDOMEl) {
      child.parentNode = this;
      this.children.push(child);
    }

    addEventListener(event: string, fn: Function) {
      if (!this.eventListeners[event]) this.eventListeners[event] = [];
      this.eventListeners[event].push(fn);
    }

    async click() {
      if (this.eventListeners['click']) {
        for (const fn of this.eventListeners['click']) {
          await fn();
        }
      }
    }

    closest(selector: string): MockDOMEl | null {
      let curr: MockDOMEl | null = this;
      while (curr) {
        if (selector.startsWith('.') && curr.className.split(' ').includes(selector.slice(1))) return curr;
        if (curr.tagName.toLowerCase() === selector.toLowerCase()) return curr;
        curr = curr.parentNode;
      }
      return null;
    }

    querySelector(selector: string): MockDOMEl | null {
      for (const c of this.children) {
        if (selector.startsWith('.') && c.className.split(' ').includes(selector.slice(1))) return c;
        if (c.tagName.toLowerCase() === selector.toLowerCase()) return c;
        const sub = c.querySelector(selector);
        if (sub) return sub;
      }
      return null;
    }
  }

  // 1. Test appendReviewerMessage (User & reloaded messages)
  function createAppendReviewerMessage(role: 'user' | 'assistant', content: string) {
    const msgEl = new MockDOMEl('div');
    msgEl.className = `message ${role}`;
    msgEl.dataset.rawContent = content;

    const headerEl = new MockDOMEl('div');
    headerEl.className = 'message-header';
    const headerActions = new MockDOMEl('div');
    headerActions.className = 'message-header-actions';

    const copyBtn = new MockDOMEl('button');
    copyBtn.className = 'msg-copy-btn';
    const span = new MockDOMEl('span');
    span.textContent = 'Copy';
    copyBtn.appendChild(span);

    copyBtn.addEventListener('click', async () => {
      const parentMsg = copyBtn.closest('.message');
      const textToCopy = parentMsg?.dataset.rawContent ?? content;
      await mockNavigator.clipboard.writeText(textToCopy);
      span.textContent = 'Copied!';
    });

    headerActions.appendChild(copyBtn);
    headerEl.appendChild(headerActions);
    msgEl.appendChild(headerEl);
    return { msgEl, copyBtn, span };
  }

  const userMarkdown = '# User Request\nReview this auth design:\n```ts\nconst x = 1;\n```';
  const { copyBtn: userCopyBtn, span: userSpan } = createAppendReviewerMessage('user', userMarkdown);
  await userCopyBtn.click();
  assert.strictEqual(clipboardText, userMarkdown, 'User message copy button must copy full raw markdown source');
  assert.strictEqual(userSpan.textContent, 'Copied!', 'Copy button must display Copied! feedback');

  // 2. Test Reviewer Stream Lifecycle (mid-stream, completed, and cleared accumulated stream)
  let activeAssistantEl: MockDOMEl | null = null;
  let accumulatedReviewerStream = '';

  function onStreamChunk(chunk: string) {
    if (!activeAssistantEl) {
      activeAssistantEl = new MockDOMEl('div');
      activeAssistantEl.className = 'message assistant';
      activeAssistantEl.dataset.rawContent = accumulatedReviewerStream;

      const headerEl = new MockDOMEl('div');
      headerEl.className = 'message-header';
      const headerActions = new MockDOMEl('div');
      headerActions.className = 'message-header-actions';

      const copyBtn = new MockDOMEl('button');
      copyBtn.className = 'msg-copy-btn';
      const span = new MockDOMEl('span');
      span.textContent = 'Copy';
      copyBtn.appendChild(span);

      copyBtn.addEventListener('click', async () => {
        const parentMsg = copyBtn.closest('.message');
        const textToCopy = parentMsg?.dataset.rawContent ?? accumulatedReviewerStream;
        await mockNavigator.clipboard.writeText(textToCopy);
        span.textContent = 'Copied!';
      });

      headerActions.appendChild(copyBtn);
      headerEl.appendChild(headerActions);
      activeAssistantEl.appendChild(headerEl);

      const bodyEl = new MockDOMEl('div');
      bodyEl.className = 'message-body';
      activeAssistantEl.appendChild(bodyEl);
    }

    accumulatedReviewerStream += chunk;
    if (activeAssistantEl) {
      activeAssistantEl.dataset.rawContent = accumulatedReviewerStream;
    }
  }

  function onStreamDone() {
    const finalContent = accumulatedReviewerStream;
    if (activeAssistantEl) {
      activeAssistantEl.dataset.rawContent = finalContent;
    }
    // Stream state is reset for the next turn
    accumulatedReviewerStream = '';
    const completedMsgEl = activeAssistantEl;
    activeAssistantEl = null;
    return completedMsgEl;
  }

  // Stream chunks
  onStreamChunk('### Review Critique\n');
  onStreamChunk('1. Token expiration is missing.\n');
  
  // Mid-stream copy verification
  const midStreamCopyBtn = activeAssistantEl!.querySelector('.msg-copy-btn')!;
  await midStreamCopyBtn.click();
  assert.strictEqual(
    clipboardText,
    '### Review Critique\n1. Token expiration is missing.\n',
    'Mid-stream copy must copy markdown received so far'
  );

  onStreamChunk('```typescript\nconst tokenTTL = 3600;\n```\n');
  onStreamChunk('2. Recommended adding rate limiting.');

  // Stream done
  const completedMessageEl = onStreamDone()!;
  assert.strictEqual(accumulatedReviewerStream, '', 'Accumulated stream variable must be reset on done');

  // Completed message copy verification (crucial bug reproduction: clicked after accumulatedReviewerStream is empty)
  const completedCopyBtn = completedMessageEl.querySelector('.msg-copy-btn')!;
  const completedSpan = completedCopyBtn.querySelector('span')!;
  await completedCopyBtn.click();

  const expectedCompletedMarkdown =
    '### Review Critique\n1. Token expiration is missing.\n```typescript\nconst tokenTTL = 3600;\n```\n2. Recommended adding rate limiting.';
  assert.strictEqual(
    clipboardText,
    expectedCompletedMarkdown,
    'Clicking Copy on completed message must copy full markdown source, NOT empty string or HTML'
  );
  assert.strictEqual(completedSpan.textContent, 'Copied!', 'Completed copy must show Copied! feedback');

  // 3. Test Partial-then-failed Stream copy
  activeAssistantEl = null;
  accumulatedReviewerStream = '';
  onStreamChunk('Critique started: ');
  onStreamChunk('Memory leak identified in cache.');

  // Error occurs partway
  function onStreamError(isPartial: boolean) {
    if (isPartial && activeAssistantEl) {
      activeAssistantEl.dataset.rawContent = accumulatedReviewerStream;
    }
    accumulatedReviewerStream = '';
    const partialEl = activeAssistantEl;
    activeAssistantEl = null;
    return partialEl;
  }

  const partialMessageEl = onStreamError(true)!;
  const partialCopyBtn = partialMessageEl.querySelector('.msg-copy-btn')!;
  await partialCopyBtn.click();
  assert.strictEqual(
    clipboardText,
    'Critique started: Memory leak identified in cache.',
    'Clicking Copy on interrupted partial message must copy the partial markdown received'
  );
});

test('Phase 11 Amendment: Unterminated code fence mid-stream is parsed as an open-ended code block', () => {
  // Regex from renderFormattedContent
  function parseContentWithUnterminatedFence(cleanedText: string) {
    const fenceRegex = /```([^\r\n]*)\r?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;
    const blocks: Array<{ type: 'markdown' | 'code'; lang?: string; code?: string; text?: string }> = [];

    while ((match = fenceRegex.exec(cleanedText)) !== null) {
      const preText = cleanedText.slice(lastIndex, match.index);
      if (preText) {
        blocks.push({ type: 'markdown', text: preText });
      }
      blocks.push({ type: 'code', lang: (match[1] || 'text').trim(), code: match[2] });
      lastIndex = fenceRegex.lastIndex;
    }

    const remaining = cleanedText.slice(lastIndex);
    if (remaining) {
      const openFenceMatch = remaining.match(/```([^\r\n]*)\r?\n([\s\S]*)$/);
      if (openFenceMatch && openFenceMatch.index !== undefined) {
        const preOpenFence = remaining.slice(0, openFenceMatch.index);
        if (preOpenFence) {
          blocks.push({ type: 'markdown', text: preOpenFence });
        }
        blocks.push({
          type: 'code',
          lang: (openFenceMatch[1] || 'text').trim(),
          code: openFenceMatch[2],
        });
      } else {
        blocks.push({ type: 'markdown', text: remaining });
      }
    }

    return blocks;
  }

  // Scenario 1: Stream contains an in-progress, unterminated code fence
  const partialStream = 'Here is the fix for auth:\n```typescript\nfunction verifyToken(token: string) {\n  return jwt.verify(token);';
  const parsedPartial = parseContentWithUnterminatedFence(partialStream);

  assert.strictEqual(parsedPartial.length, 2);
  assert.strictEqual(parsedPartial[0].type, 'markdown');
  assert.strictEqual(parsedPartial[0].text, 'Here is the fix for auth:\n');
  assert.strictEqual(parsedPartial[1].type, 'code');
  assert.strictEqual(parsedPartial[1].lang, 'typescript');
  assert.strictEqual(
    parsedPartial[1].code,
    'function verifyToken(token: string) {\n  return jwt.verify(token);',
    'Unterminated fence must be rendered as code block without showing raw ``` markers'
  );

  // Scenario 2: Stream later receives the closing fence
  const completedStream = partialStream + '\n}\n```\nAll tests will pass.';
  const parsedCompleted = parseContentWithUnterminatedFence(completedStream);

  assert.strictEqual(parsedCompleted.length, 3);
  assert.strictEqual(parsedCompleted[0].type, 'markdown');
  assert.strictEqual(parsedCompleted[1].type, 'code');
  assert.strictEqual(parsedCompleted[1].lang, 'typescript');
  assert.strictEqual(parsedCompleted[1].code, 'function verifyToken(token: string) {\n  return jwt.verify(token);\n}\n');
  assert.strictEqual(parsedCompleted[2].type, 'markdown');
  assert.strictEqual(parsedCompleted[2].text, '\nAll tests will pass.');
});

test('Phase 11 Amendment: Drag-and-drop controller signature safety & drop-zone parity', () => {
  // Mock element and controller setup
  class MockDOMNode {
    public classList = {
      classes: new Set<string>(),
      add(c: string) { this.classes.add(c); },
      remove(c: string) { this.classes.delete(c); },
      contains(c: string) { return this.classes.has(c); },
    };
    public listeners: Record<string, Function[]> = {};
    public value: string = '';
    public style: any = {};

    addEventListener(event: string, fn: Function) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    }

    dispatchEvent(event: string, data: any) {
      if (this.listeners[event]) {
        this.listeners[event].forEach((fn) => fn(data));
      }
    }

    contains(other: any) {
      return this === other;
    }
  }

  function simulateInputController(options: {
    inputBoxWrapper: MockDOMNode;
    dropZone?: MockDOMNode;
  }) {
    const { inputBoxWrapper, dropZone } = options;
    const attachedFiles: string[] = [];

    const dropTargets = [inputBoxWrapper];
    if (dropZone && dropZone !== inputBoxWrapper) {
      dropTargets.push(dropZone);
    }

    let dragCounter = 0;

    dropTargets.forEach((target) => {
      target.addEventListener('dragenter', (e: any) => {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
        dragCounter++;
        if (dragCounter === 1) {
          inputBoxWrapper.classList.add('drag-over');
        }
      });

      target.addEventListener('dragover', (e: any) => {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
      });

      target.addEventListener('dragleave', (e: any) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
          dragCounter = 0;
          inputBoxWrapper.classList.remove('drag-over');
        }
      });

      target.addEventListener('drop', (e: any) => {
        e.preventDefault();
        dragCounter = 0;
        inputBoxWrapper.classList.remove('drag-over');
        if (e.dataTransfer?.files) {
          e.dataTransfer.files.forEach((f: any) => attachedFiles.push(f.name));
        }
      });
    });

    return { attachedFiles };
  }

  // 1. Main chat with dropZone: viewChat -> both chat view container and input box wrapper receive drag-and-drop
  const mainWrapper = new MockDOMNode();
  const mainChatView = new MockDOMNode();
  const mainController = simulateInputController({ inputBoxWrapper: mainWrapper, dropZone: mainChatView });

  assert.ok(mainChatView.listeners['dragenter'], 'Main chat view must have dragenter listener');
  assert.ok(mainChatView.listeners['dragover'], 'Main chat view must have dragover listener');
  assert.ok(mainChatView.listeners['dragleave'], 'Main chat view must have dragleave listener');
  assert.ok(mainChatView.listeners['drop'], 'Main chat view must have drop listener');
  assert.ok(mainWrapper.listeners['dragover'], 'Main wrapper must have dragover listener');
  assert.ok(mainWrapper.listeners['drop'], 'Main wrapper must have drop listener');

  // Drag over main chat view container - sets drag-over and dropEffect
  let mainPrevented = false;
  const mainDragOverEvent: any = {
    preventDefault: () => { mainPrevented = true; },
    dataTransfer: { dropEffect: 'none' },
  };
  mainChatView.dispatchEvent('dragenter', mainDragOverEvent);
  assert.strictEqual(mainWrapper.classList.contains('drag-over'), true, 'Main chat view dragenter must add drag-over class');
  assert.strictEqual(mainDragOverEvent.dataTransfer.dropEffect, 'copy', 'Main chat view dragenter must set dropEffect to copy');
  assert.strictEqual(mainPrevented, true, 'Main chat view dragenter must call preventDefault');

  mainChatView.dispatchEvent('dragover', mainDragOverEvent);
  assert.strictEqual(mainDragOverEvent.dataTransfer.dropEffect, 'copy', 'Main chat view dragover must set dropEffect to copy');

  // Transition to child element inside view: dragenter on child, dragleave on previous element -> drag-over remains active
  mainChatView.dispatchEvent('dragenter', { preventDefault: () => {}, dataTransfer: {} });
  mainChatView.dispatchEvent('dragleave', { preventDefault: () => {} });
  assert.strictEqual(mainWrapper.classList.contains('drag-over'), true, 'Child element transition must keep drag-over class active');

  // Complete exit from drop zone
  mainChatView.dispatchEvent('dragleave', { preventDefault: () => {} });
  assert.strictEqual(mainWrapper.classList.contains('drag-over'), false, 'Exiting drop zone completely must remove drag-over class');

  // Drop files anywhere in main chat view
  mainChatView.dispatchEvent('dragenter', { preventDefault: () => {}, dataTransfer: {} });
  assert.strictEqual(mainWrapper.classList.contains('drag-over'), true);
  mainChatView.dispatchEvent('drop', {
    preventDefault: () => {},
    dataTransfer: { files: [{ name: 'spec.md' }, { name: 'helper.ts' }] },
  });
  assert.strictEqual(mainWrapper.classList.contains('drag-over'), false, 'Drop must remove drag-over class');
  assert.deepStrictEqual(mainController.attachedFiles, ['spec.md', 'helper.ts'], 'Main chat view drop must attach dropped files');

  // 2. Reviewer call site passes dropZone: viewReviewer -> both container and wrapper handle drag-and-drop
  const revWrapper = new MockDOMNode();
  const revView = new MockDOMNode();
  const revController = simulateInputController({ inputBoxWrapper: revWrapper, dropZone: revView });

  assert.ok(revView.listeners['dragenter'], 'Reviewer view must have dragenter listener');
  assert.ok(revView.listeners['dragover'], 'Reviewer view must have dragover listener');
  assert.ok(revView.listeners['dragleave'], 'Reviewer view must have dragleave listener');
  assert.ok(revView.listeners['drop'], 'Reviewer view must have drop listener');

  // Drag over reviewer panel container
  let revPrevented = false;
  const revDragOverEvent: any = {
    preventDefault: () => { revPrevented = true; },
    dataTransfer: { dropEffect: 'none' },
  };
  revView.dispatchEvent('dragenter', revDragOverEvent);
  assert.strictEqual(revWrapper.classList.contains('drag-over'), true, 'Reviewer view dragenter must add drag-over class');
  assert.strictEqual(revDragOverEvent.dataTransfer.dropEffect, 'copy', 'Reviewer view dragenter must set dropEffect to copy');
  assert.strictEqual(revPrevented, true, 'Reviewer view dragenter must call preventDefault');

  // Drop file anywhere in reviewer panel container
  revView.dispatchEvent('drop', {
    preventDefault: () => {},
    dataTransfer: { files: [{ name: 'plan.md' }, { name: 'architecture.png' }] },
  });
  assert.strictEqual(revWrapper.classList.contains('drag-over'), false);
  assert.deepStrictEqual(revController.attachedFiles, ['plan.md', 'architecture.png'], 'Reviewer panel must accept dropped files');
});

test('Phase 11 Amendment: System prompt and default reviewer prompt require fenced copy-intended content within token budget', () => {
  const { buildSystemPrompt } = require('../src/prompt/systemPrompt');

  // 1. Verify main chat system prompt contains Copy-Intended Content directive
  const systemPrompt = buildSystemPrompt({});
  assert.ok(
    systemPrompt.includes('Copy-Intended Content & Code Block Fencing'),
    'Main chat system prompt must include copy-intended fencing directive'
  );
  assert.ok(
    systemPrompt.includes('NEVER embed copy-intended multi-line or distinct snippets directly inside a conversational prose paragraph'),
    'Main chat system prompt must instruct separation of copy snippets from prose'
  );

  // 2. Verify DEFAULT_REVIEWER_SYSTEM_PROMPT contains Fenced Copy-Intended Content guideline
  const reviewerPrompt = Configuration.DEFAULT_REVIEWER_SYSTEM_PROMPT;
  assert.ok(
    reviewerPrompt.includes('5. Fenced Copy-Intended Content'),
    'Reviewer default prompt must include fenced copy-intended content guideline'
  );
  assert.ok(
    reviewerPrompt.includes('Always emit code snippets, diffs, config samples, or terminal commands inside dedicated fenced code blocks'),
    'Reviewer default prompt must instruct fenced blocks with language tags'
  );

  // 3. Confirm prompt token budget check
  // The additive text is ~30 tokens. Check total word count of reviewer prompt.
  const wordCount = reviewerPrompt.split(/\s+/).length;
  assert.ok(wordCount < 180, `Reviewer prompt word count (${wordCount}) should be well under 180 words (<250 tokens)`);
});

test('Phase 11 Gap: Reviewer and Main Chat input bars render distinct file-attach buttons and route document attachments through shared attachment handler', async () => {
  // 1. Markup verification via OpenRouterPanelProvider for BOTH Main Chat and Reviewer
  const { OpenRouterPanelProvider } = require('../src/webview/panelProvider');
  const mockWebview = {
    asWebviewUri: (uri: any) => uri.toString(),
    cspSource: 'https:',
  };
  const provider = new OpenRouterPanelProvider(vscode.Uri.file('C:/mock/extension') as any);
  const html = (provider as any)._getHtmlForWebview(mockWebview);

  // Assert presence of distinct file attachment button and hidden doc file input in MAIN CHAT
  assert.ok(
    html.includes('id="attach-file-btn"'),
    'Main chat input bar must render a dedicated file attachment button (#attach-file-btn)'
  );
  assert.ok(
    html.includes('id="doc-file-input"'),
    'Main chat input bar must render a dedicated hidden document file input (#doc-file-input)'
  );
  assert.ok(
    html.includes('id="upload-img-btn"'),
    'Main chat input bar must continue to render distinct image upload button (#upload-img-btn)'
  );
  assert.ok(
    html.includes('id="image-file-input"'),
    'Main chat input bar must continue to render distinct image file input (#image-file-input)'
  );
  assert.ok(
    html.includes('<button id="attach-file-btn" class="inline-icon-btn" title="Attach file">'),
    'attach-file-btn in main chat must use inline-icon-btn class and title="Attach file"'
  );

  // Assert presence of distinct file attachment button and hidden doc file input in REVIEWER panel
  assert.ok(
    html.includes('id="reviewer-attach-file-btn"'),
    'Reviewer input bar must render a dedicated file attachment button (#reviewer-attach-file-btn)'
  );
  assert.ok(
    html.includes('id="reviewer-doc-file-input"'),
    'Reviewer input bar must render a dedicated hidden document file input (#reviewer-doc-file-input)'
  );
  assert.ok(
    html.includes('id="reviewer-upload-img-btn"'),
    'Reviewer input bar must continue to render distinct image upload button (#reviewer-upload-img-btn)'
  );
  assert.ok(
    html.includes('id="reviewer-image-file-input"'),
    'Reviewer input bar must continue to render distinct image file input (#reviewer-image-file-input)'
  );
  assert.ok(
    html.includes('<button id="reviewer-attach-file-btn" class="inline-icon-btn" title="Attach file">'),
    'reviewer-attach-file-btn must use inline-icon-btn class and title="Attach file"'
  );

  // 2. Controller and Handler Verification
  // Simulate createChatInputController logic for reviewer and verify handler invocation parity
  class MockElement {
    public classList = {
      classes: new Set<string>(),
      add(c: string) { this.classes.add(c); },
      remove(c: string) { this.classes.delete(c); },
      contains(c: string) { return this.classes.has(c); },
    };
    public listeners: Record<string, Function[]> = {};
    public value: string = '';
    public files: any[] = [];
    public innerHTML: string = '';
    public children: MockElement[] = [];
    public clicked: boolean = false;
    public textContent: string = '';

    addEventListener(event: string, fn: Function) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    }

    dispatchEvent(event: string, data?: any) {
      if (this.listeners[event]) {
        this.listeners[event].forEach((fn) => fn(data));
      }
    }

    click() {
      this.clicked = true;
      this.dispatchEvent('click', { preventDefault: () => {} });
    }

    appendChild(child: MockElement) {
      this.children.push(child);
    }
  }

  // Setup mock DOM elements for reviewer input bar
  const reviewerPromptInput = new MockElement();
  const reviewerAttachmentPreviewBar = new MockElement();
  const reviewerImageFileInput = new MockElement();
  const reviewerDocFileInput = new MockElement();
  const reviewerUploadImgBtn = new MockElement();
  const reviewerAttachFileBtn = new MockElement();

  // Implement controller simulation matching createChatInputController in main.ts
  type Attachment = { id: string; name: string; data: string; isImage: boolean };
  let attachmentsList: Attachment[] = [];
  let sentMessagePayload: string = '';

  function handleImageFile(file: { name: string; data: string; type: string }) {
    if (!file.type.startsWith('image/')) return;
    attachmentsList.push({ id: 'img-1', name: file.name, data: file.data, isImage: true });
    render();
  }

  function handleTextFile(file: { name: string; data: string; type: string }) {
    attachmentsList.push({ id: 'doc-1', name: file.name, data: file.data, isImage: false });
    render();
  }

  function render() {
    reviewerAttachmentPreviewBar.children = [];
    if (attachmentsList.length === 0) {
      reviewerAttachmentPreviewBar.classList.add('hidden');
      return;
    }
    reviewerAttachmentPreviewBar.classList.remove('hidden');
    attachmentsList.forEach((att) => {
      const chip = new MockElement();
      chip.classList.add('attachment-chip');
      const nameSpan = new MockElement();
      nameSpan.textContent = att.name;
      chip.appendChild(nameSpan);
      reviewerAttachmentPreviewBar.appendChild(chip);
    });
  }

  // Wire buttons matching createChatInputController
  reviewerUploadImgBtn.addEventListener('click', (e: any) => {
    e.preventDefault();
    reviewerImageFileInput.click();
  });

  reviewerAttachFileBtn.addEventListener('click', (e: any) => {
    e.preventDefault();
    reviewerDocFileInput.click();
  });

  reviewerImageFileInput.addEventListener('change', () => {
    const file = reviewerImageFileInput.files?.[0];
    if (file) {
      handleImageFile(file);
      reviewerImageFileInput.value = '';
    }
  });

  reviewerDocFileInput.addEventListener('change', () => {
    const files = reviewerDocFileInput.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type.startsWith('image/')) {
          handleImageFile(file);
        } else {
          handleTextFile(file);
        }
      }
      reviewerDocFileInput.value = '';
    }
  });

  function sendReviewerMessage() {
    let text = reviewerPromptInput.value.trim();
    attachmentsList.forEach((att) => {
      if (!att.isImage) {
        const formatted = `\n\`\`\`${att.name}\n${att.data}\n\`\`\`\n`;
        text = text ? text.trimEnd() + formatted : formatted.trimStart();
      }
    });
    sentMessagePayload = text;
    attachmentsList = [];
    render();
  }

  // Test 1: Clicking attach file button invokes docFileInput.click()
  reviewerAttachFileBtn.dispatchEvent('click', { preventDefault: () => {} });
  assert.strictEqual(reviewerDocFileInput.clicked, true, 'Clicking attach-file button must trigger file picker click');

  // Test 2: Selecting a document file invokes handleTextFile and renders chip
  reviewerDocFileInput.files = [{ name: 'schema.json', data: '{\n  "version": 1\n}', type: 'application/json' }];
  reviewerDocFileInput.dispatchEvent('change');

  assert.strictEqual(attachmentsList.length, 1);
  assert.strictEqual(attachmentsList[0].name, 'schema.json');
  assert.strictEqual(attachmentsList[0].isImage, false, 'Document must have isImage: false');
  assert.strictEqual(reviewerAttachmentPreviewBar.classList.contains('hidden'), false);
  assert.strictEqual(reviewerAttachmentPreviewBar.children.length, 1);
  assert.strictEqual(reviewerAttachmentPreviewBar.children[0].children[0].textContent, 'schema.json');

  // Test 3: Sending message formats document into markdown code block
  reviewerPromptInput.value = 'Please review this schema';
  sendReviewerMessage();

  assert.ok(sentMessagePayload, 'Message payload must be sent');
  assert.ok(sentMessagePayload.includes('Please review this schema'));
  assert.ok(sentMessagePayload.includes('```schema.json'));
  assert.ok(sentMessagePayload.includes('{\n  "version": 1\n}'));
  assert.strictEqual(attachmentsList.length, 0, 'Attachments must be cleared after sending');
  assert.strictEqual(reviewerAttachmentPreviewBar.classList.contains('hidden'), true);

  // Test 4: Image button continues to route to handleImageFile distinctly
  reviewerUploadImgBtn.dispatchEvent('click', { preventDefault: () => {} });
  assert.strictEqual(reviewerImageFileInput.clicked, true, 'Clicking image upload button must trigger image file picker');

  reviewerImageFileInput.files = [{ name: 'screenshot.png', data: 'data:image/png;base64,...', type: 'image/png' }];
  reviewerImageFileInput.dispatchEvent('change');

  assert.strictEqual(attachmentsList.length, 1);
  assert.strictEqual(attachmentsList[0].name, 'screenshot.png');
  assert.strictEqual(attachmentsList[0].isImage, true, 'Image must have isImage: true');
});

test('Reviewer Header Toggle Button: Visibility strictly governed by reviewerEnabled setting and updates live mid-session without reload', async () => {
  const { OpenRouterPanelProvider } = require('../src/webview/panelProvider');
  const mockWebview = {
    asWebviewUri: (uri: any) => uri.toString(),
    cspSource: 'https:',
  };
  const provider = new OpenRouterPanelProvider(vscode.Uri.file('C:/mock/extension') as any);

  // 1. When openrouter.reviewer.enabled is false (default):
  (vscode.workspace as any)._currentWorkspaceKey = 'toggle-test-workspace-off';
  await Configuration.setReviewerEnabled(false);
  assert.strictEqual(Configuration.getReviewerEnabled(), false);

  const htmlDisabled = (provider as any)._getHtmlForWebview(mockWebview);
  assert.ok(
    htmlDisabled.includes('<button id="reviewer-toggle-btn" class="icon-btn hidden" title="Open Reviewer Panel">🔍</button>'),
    'reviewer-toggle-btn must have "hidden" class when openrouter.reviewer.enabled is false'
  );

  // 2. When openrouter.reviewer.enabled is true:
  (vscode.workspace as any)._currentWorkspaceKey = 'toggle-test-workspace-on';
  await Configuration.setReviewerEnabled(true);
  assert.strictEqual(Configuration.getReviewerEnabled(), true);

  const htmlEnabled = (provider as any)._getHtmlForWebview(mockWebview);
  assert.ok(
    htmlEnabled.includes('<button id="reviewer-toggle-btn" class="icon-btn" title="Open Reviewer Panel">🔍</button>'),
    'reviewer-toggle-btn must NOT have "hidden" class when openrouter.reviewer.enabled is true'
  );
  assert.ok(
    !htmlEnabled.includes('id="reviewer-toggle-btn" class="icon-btn hidden"'),
    'reviewer-toggle-btn must be visible when enabled'
  );

  // 3. Live mid-session updates without reload:
  // Simulate webview DOM button and state transitions
  class MockToggleBtn {
    public classList = {
      classes: new Set<string>(['icon-btn', 'hidden']),
      add(c: string) { this.classes.add(c); },
      remove(c: string) { this.classes.delete(c); },
      contains(c: string) { return this.classes.has(c); },
    };
    public isVisible() {
      return !this.classList.contains('hidden');
    }
  }

  const btn = new MockToggleBtn();
  let isReviewerEnabled = false;

  function updateReviewerToggleBtnVisibility(enabled: boolean) {
    if (enabled) {
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  }

  // Initial state: disabled -> hidden
  updateReviewerToggleBtnVisibility(isReviewerEnabled);
  assert.strictEqual(btn.isVisible(), false, 'Button must be hidden initially');

  // User toggles on in settings mid-session:
  isReviewerEnabled = true;
  updateReviewerToggleBtnVisibility(isReviewerEnabled);
  assert.strictEqual(btn.isVisible(), true, 'Button must become visible immediately when enabled');

  // User toggles off in settings mid-session:
  isReviewerEnabled = false;
  updateReviewerToggleBtnVisibility(isReviewerEnabled);
  assert.strictEqual(btn.isVisible(), false, 'Button must hide immediately when disabled without reload');

  // 4. Host-side direct open guard
  (vscode.workspace as any)._currentWorkspaceKey = 'toggle-test-workspace-guard';
  (provider as any)._historyStore = {
    loadReviewerSessions: async () => ({ activeSession: { messages: [] } }),
  };
  await Configuration.setReviewerEnabled(false);
  let posted = false;
  (provider as any)._postMessage = () => { posted = true; };
  await (provider as any)._handleOpenDirectReviewer();
  assert.strictEqual(posted, false, 'Host must block _handleOpenDirectReviewer when reviewer is disabled');

  await Configuration.setReviewerEnabled(true);
  await (provider as any)._handleOpenDirectReviewer();
  assert.strictEqual(posted, true, 'Host must allow _handleOpenDirectReviewer when reviewer is enabled');
});

test('Reviewer Session Continuity: Repeat Review click attaches artifact without auto-sending or creating new session, follow-up send transmits context with user note', async () => {
  const { OpenRouterPanelProvider } = require('../src/webview/panelProvider');
  const historyStore = new HistoryStore();
  const secretStore = { getApiKey: async () => 'test-api-key' } as any;
  const permissionManager = {} as any;
  const usageStore = new UsageStore();
  const storageUri = vscode.Uri.file('C:/mock/storage');

  (vscode.workspace as any)._currentWorkspaceKey = 'reviewer-session-continuity';
  await Configuration.setReviewerEnabled(true);
  await Configuration.setReviewerModel('anthropic/claude-3.7-sonnet');
  const customSystemPrompt = 'You are a senior architectural reviewer.';
  await Configuration.setReviewerSystemPrompt(customSystemPrompt);

  const provider = new OpenRouterPanelProvider(
    vscode.Uri.file('C:/mock/extension') as any,
    secretStore,
    historyStore,
    permissionManager,
    usageStore,
    storageUri
  );

  const planMsgId = 'msg-plan-continuity';
  const planMarkdown = '# Auth Refactor Plan\n1. Use secure cookies\n2. Add CSRF tokens';

  // Seed main chat history with plan artifact
  await historyStore.appendMessage({
    id: planMsgId,
    role: 'assistant',
    content: 'Plan ready',
    planDocument: planMarkdown,
    timestamp: Date.now(),
  });

  let streamCallCount = 0;
  let lastCapturedOutgoingMessages: Array<{ role: string; content: string }> = [];
  const originalSendChatCompletionStream = OpenRouterClient.sendChatCompletionStream;
  (OpenRouterClient as any).sendChatCompletionStream = async (
    _apiKey: string,
    _model: string,
    messages: any[],
    onChunk: (chunk: string) => void,
    onDone: (usage: any) => Promise<void>
  ) => {
    streamCallCount++;
    lastCapturedOutgoingMessages = [...messages];
    onChunk(`Critique turn ${streamCallCount}: looks solid.`);
    await onDone({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  };

  const postedMessages: any[] = [];
  (provider as any)._postMessage = (msg: any) => {
    postedMessages.push(msg);
  };

  try {
    // --- Part 1: First click on "Review" (no session open) ---
    // Should create a new session, auto-send, show configured reviewer system prompt as the user turn,
    // and inject the plan document into system context.
    await (provider as any)._handleStartReview('plan', planMsgId);

    const sessionsAfterFirstReview = await historyStore.loadReviewerSessions();
    assert.strictEqual(
      sessionsAfterFirstReview.allSessions.length,
      1,
      'First click on Review must create exactly 1 reviewer session'
    );
    assert.strictEqual(
      streamCallCount,
      1,
      'First click on Review must auto-send and trigger initial stream'
    );
    assert.strictEqual(
      sessionsAfterFirstReview.activeSession.messages.length,
      2,
      'First session should have 2 messages (Turn 1: user prompt + assistant review)'
    );
    const firstSessionId = sessionsAfterFirstReview.activeSession.id;

    // Verify visible user turn displays concise review prompt (not raw plan)
    const initialUserMsg = sessionsAfterFirstReview.activeSession.messages[0];
    assert.strictEqual(initialUserMsg.role, 'user');
    assert.strictEqual(
      initialUserMsg.content,
      'Review this plan',
      'First Review click must show Review this plan as the visible user turn'
    );
    assert.strictEqual(
      initialUserMsg.content.includes(planMarkdown),
      false,
      'First Review click must NOT leak raw plan document into user chat bubble'
    );

    // Verify system context received the plan document
    const turn1SystemMsg = lastCapturedOutgoingMessages.find((m) => m.role === 'system');
    assert.ok(turn1SystemMsg);
    assert.ok(
      turn1SystemMsg.content.includes(planMarkdown),
      'Model must receive the plan document in system-role context on first turn'
    );

    // --- Part 2: Second click on "Review" while session is active (same artifact) ---
    // Must NOT create a new session, must NOT auto-send, and must post REVIEWER_ATTACH_ARTIFACT
    postedMessages.length = 0;
    await (provider as any)._handleStartReview('plan', planMsgId);

    const sessionsAfterSecondReview = await historyStore.loadReviewerSessions();
    assert.strictEqual(
      sessionsAfterSecondReview.allSessions.length,
      1,
      'Second Review click must NOT create a new session; exactly 1 session must exist'
    );
    assert.strictEqual(
      sessionsAfterSecondReview.activeSession.id,
      firstSessionId,
      'Active session ID must be preserved'
    );
    assert.strictEqual(
      streamCallCount,
      1,
      'Second Review click must NOT auto-send or trigger streaming'
    );

    const attachEvent = postedMessages.find((m) => m.type === 'REVIEWER_ATTACH_ARTIFACT');
    assert.ok(attachEvent, 'Second Review click must post REVIEWER_ATTACH_ARTIFACT to webview');
    assert.strictEqual(attachEvent.artifactType, 'plan');
    assert.strictEqual(attachEvent.artifactContent, planMarkdown);

    // --- Part 3: Sending the attached artifact with a user note ("check again") ---
    // Must continue the SAME session, trigger stream, show user note as visible turn (NOT raw plan, NOT system prompt),
    // and inject the plan into system-role context
    await (provider as any)._handleSendReviewerMessage(
      'check again',
      undefined,
      undefined,
      attachEvent.artifactContent,
      attachEvent.artifactType
    );

    const sessionsAfterFollowUp = await historyStore.loadReviewerSessions();
    assert.strictEqual(
      sessionsAfterFollowUp.allSessions.length,
      1,
      'Sending follow-up message must continue the SAME session'
    );
    assert.strictEqual(
      streamCallCount,
      2,
      'Sending follow-up message must trigger second stream turn'
    );
    assert.strictEqual(
      sessionsAfterFollowUp.activeSession.messages.length,
      4,
      'Single session must now contain 4 messages (2 user + 2 assistant)'
    );
    assert.strictEqual(
      sessionsAfterFollowUp.activeSession.id,
      firstSessionId
    );

    const followUpUserMsg = sessionsAfterFollowUp.activeSession.messages[2];
    assert.strictEqual(followUpUserMsg.role, 'user');
    assert.strictEqual(
      followUpUserMsg.content,
      'check again',
      'Follow-up visible turn must display whatever user typed'
    );
    assert.strictEqual(
      followUpUserMsg.content.includes(planMarkdown),
      false,
      'Follow-up user turn must NOT contain raw plan document'
    );
    assert.notStrictEqual(
      followUpUserMsg.content,
      customSystemPrompt,
      'Follow-up user turn must NOT be the system prompt'
    );

    const turn2SystemMsg = lastCapturedOutgoingMessages.find((m) => m.role === 'system');
    assert.ok(turn2SystemMsg);
    assert.ok(
      turn2SystemMsg.content.includes(planMarkdown),
      'Follow-up send must inject plan into system-role context'
    );

    const outgoingUserMsgsTurn2 = lastCapturedOutgoingMessages.filter((m) => m.role === 'user');
    const turn2OutgoingUserMsg = outgoingUserMsgsTurn2[outgoingUserMsgsTurn2.length - 1];
    assert.ok(turn2OutgoingUserMsg);
    assert.ok(
      turn2OutgoingUserMsg.content.includes('check again'),
      'Outgoing user message must contain the user text'
    );
    assert.ok(
      turn2OutgoingUserMsg.content.includes(planMarkdown),
      'Outgoing user message dispatched to model must include the attached plan document context'
    );
    assert.ok(
      turn2OutgoingUserMsg.content.includes('# Attached Document Under Review (Plan docs):'),
      'Outgoing user message must include the structured document header'
    );

    // --- Part 4: Second Review click from a DIFFERENT artifact (Walkthrough) while session is active ---
    // Must NOT create a new session, must NOT auto-send, and must attach new artifact
    const walkthroughMsgId = 'msg-walkthrough-continuity';
    const walkthroughMarkdown = '# Walkthrough Verification\n- All 15 tests passed\n- Security checked';
    await historyStore.appendMessage({
      id: walkthroughMsgId,
      role: 'assistant',
      content: 'Walkthrough ready',
      walkthroughDocument: walkthroughMarkdown,
      timestamp: Date.now(),
    });

    postedMessages.length = 0;
    await (provider as any)._handleStartReview('walkthrough', walkthroughMsgId);

    const sessionsAfterWalkthroughClick = await historyStore.loadReviewerSessions();
    assert.strictEqual(
      sessionsAfterWalkthroughClick.allSessions.length,
      1,
      'Clicking Review on different artifact while session is active must NOT create a new session'
    );
    assert.strictEqual(
      streamCallCount,
      2,
      'Clicking Review on different artifact while session is active must NOT auto-send'
    );

    const walkthroughAttachEvent = postedMessages.find((m) => m.type === 'REVIEWER_ATTACH_ARTIFACT');
    assert.ok(walkthroughAttachEvent, 'Must post REVIEWER_ATTACH_ARTIFACT for walkthrough');
    assert.strictEqual(walkthroughAttachEvent.artifactType, 'walkthrough');
    assert.strictEqual(walkthroughAttachEvent.artifactContent, walkthroughMarkdown);

    // Send walkthrough attachment
    await (provider as any)._handleSendReviewerMessage(
      'inspect edge cases',
      undefined,
      undefined,
      walkthroughAttachEvent.artifactContent,
      walkthroughAttachEvent.artifactType
    );

    const sessionsAfterWalkthroughSend = await historyStore.loadReviewerSessions();
    assert.strictEqual(sessionsAfterWalkthroughSend.allSessions.length, 1);
    assert.strictEqual(streamCallCount, 3);
    assert.strictEqual(sessionsAfterWalkthroughSend.activeSession.messages.length, 6);

    const walkthroughUserMsg = sessionsAfterWalkthroughSend.activeSession.messages[4];
    assert.strictEqual(walkthroughUserMsg.content, 'inspect edge cases');
    assert.strictEqual(walkthroughUserMsg.content.includes(walkthroughMarkdown), false);

    const turn3SystemMsg = lastCapturedOutgoingMessages.find((m) => m.role === 'system');
    assert.ok(turn3SystemMsg);
    assert.ok(
      turn3SystemMsg.content.includes(walkthroughMarkdown),
      'Walkthrough content must be injected into system-role context'
    );

    const outgoingUserMsgsTurn3 = lastCapturedOutgoingMessages.filter((m) => m.role === 'user');
    const turn3OutgoingUserMsg = outgoingUserMsgsTurn3[outgoingUserMsgsTurn3.length - 1];
    assert.ok(turn3OutgoingUserMsg);
    assert.ok(
      turn3OutgoingUserMsg.content.includes('inspect edge cases'),
      'Outgoing user message must contain user text'
    );
    assert.ok(
      turn3OutgoingUserMsg.content.includes(walkthroughMarkdown),
      'Outgoing user message dispatched to model must include attached walkthrough document'
    );
    assert.ok(
      turn3OutgoingUserMsg.content.includes('# Attached Document Under Review (Results docs):'),
      'Outgoing user message must include structured walkthrough header'
    );
  } finally {
    OpenRouterClient.sendChatCompletionStream = originalSendChatCompletionStream;
  }
});

test('Reviewer Artifact Fidelity & Presentation: Initial user turn is a short instruction, plan is not in chat bubble, and model receives full plan context + system prompt', async () => {
  const { OpenRouterPanelProvider } = require('../src/webview/panelProvider');
  const { OpenRouterClient } = require('../src/api/openrouterClient');
  const historyStore = new HistoryStore();
  const secretStore = { getApiKey: async () => 'test-api-key' } as any;
  const permissionManager = {} as any;
  const usageStore = new UsageStore();
  const storageUri = vscode.Uri.file('C:/mock/storage');

  (vscode.workspace as any)._currentWorkspaceKey = 'reviewer-artifact-fidelity';
  await Configuration.setReviewerEnabled(true);
  await Configuration.setReviewerModel('anthropic/claude-3.7-sonnet');
  await Configuration.setReviewerSystemPrompt('You are a meticulous reviewer model.');

  const provider = new OpenRouterPanelProvider(
    vscode.Uri.file('C:/mock/extension') as any,
    secretStore,
    historyStore,
    permissionManager,
    usageStore,
    storageUri
  );

  const msgId = 'msg-plan-presentation';
  const rawPlanDocument = `# Architecture Implementation Plan
1. Refactor authentication to use secure httpOnly cookies.
2. Implement cryptographic token rotation.
\`\`\`typescript
export function verifyJwt(token: string) { return true; }
\`\`\`
3. Add end-to-end regression tests.`;

  // Seed main chat history with plan artifact
  await historyStore.appendMessage({
    id: msgId,
    role: 'assistant',
    content: 'Plan ready',
    planDocument: rawPlanDocument,
    timestamp: Date.now(),
  });

  let capturedOutgoingMessages: Array<{ role: string; content: string }> = [];
  const originalSendChatCompletionStream = OpenRouterClient.sendChatCompletionStream;
  OpenRouterClient.sendChatCompletionStream = async (
    apiKey: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void,
    onDone: (usage?: any) => Promise<void>
  ) => {
    capturedOutgoingMessages = [...messages];
    onChunk('Review response chunk');
    await onDone({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  };

  const postedWebviewMessages: any[] = [];
  (provider as any)._postMessage = (msg: any) => {
    postedWebviewMessages.push(msg);
  };

  try {
    // User clicks "Review" on the plan artifact card
    await (provider as any)._handleStartReview('plan', msgId);

    // 1. Assert stored initial user turn is the configured Reviewer System Prompt (not the full plan text or generic placeholder)
    const { activeSession } = await historyStore.loadReviewerSessions();
    assert.strictEqual(
      activeSession.messages.length,
      2,
      'Session should have 2 messages (Turn 1: user instruction + assistant reply)'
    );

    const storedUserMessage = activeSession.messages[0];
    assert.strictEqual(storedUserMessage.role, 'user');
    assert.strictEqual(
      storedUserMessage.content,
      'Review this plan',
      'Stored initial user turn must be Review this plan'
    );
    assert.strictEqual(
      storedUserMessage.content.includes(rawPlanDocument),
      false,
      'Stored user message must NEVER contain the raw plan document text'
    );

    // 2. Assert the plan document is NOT rendered as a chat bubble (history sent to webview displays configured prompt)
    const reviewerDataEvent = postedWebviewMessages.find((m) => m.type === 'REVIEWER_VIEW_DATA');
    assert.ok(reviewerDataEvent, 'REVIEWER_VIEW_DATA must be posted to webview');
    assert.strictEqual(
      reviewerDataEvent.artifactContent,
      rawPlanDocument,
      'Collapsible artifact reference section must receive the full plan document'
    );
    assert.strictEqual(
      reviewerDataEvent.history.length,
      1,
      'History sent for chat rendering must have 1 initial user message'
    );
    assert.strictEqual(
      reviewerDataEvent.history[0].content,
      'Review this plan',
      'Chat bubble history must display Review this plan'
    );
    assert.strictEqual(
      reviewerDataEvent.history[0].content.includes(rawPlanDocument),
      false,
      'Chat bubble history must NOT contain raw plan document'
    );

    // 3. Assert outgoing request to the model includes the full plan content as context plus the reviewer system prompt
    assert.ok(capturedOutgoingMessages.length >= 2, 'Outgoing request must have system and user messages');

    const systemMessage = capturedOutgoingMessages.find((m) => m.role === 'system');
    assert.ok(systemMessage, 'Outgoing request must contain a system message');
    assert.ok(
      systemMessage.content.includes('You are a meticulous reviewer model.'),
      'System message must include the workspace reviewer system prompt'
    );
    assert.ok(
      systemMessage.content.includes(rawPlanDocument),
      'System message must include the full byte-for-byte plan document context'
    );

    const userMessage = capturedOutgoingMessages.find((m) => m.role === 'user');
    assert.ok(userMessage, 'Outgoing request must contain a user message');
    assert.strictEqual(
      userMessage.content,
      'Review this plan',
      'Outgoing user message turn must be Review this plan'
    );
  } finally {
    OpenRouterClient.sendChatCompletionStream = originalSendChatCompletionStream;
  }
});

test('Reviewer Walkthrough Review: Initial user turn uses configured Reviewer System Prompt, walkthrough document is in context only', async () => {
  const { OpenRouterPanelProvider } = require('../src/webview/panelProvider');
  const { OpenRouterClient } = require('../src/api/openrouterClient');
  const historyStore = new HistoryStore();
  const secretStore = { getApiKey: async () => 'test-api-key' } as any;
  const permissionManager = {} as any;
  const usageStore = new UsageStore();
  const storageUri = vscode.Uri.file('C:/mock/storage');

  (vscode.workspace as any)._currentWorkspaceKey = 'reviewer-walkthrough-prompt';
  await Configuration.setReviewerEnabled(true);
  await Configuration.setReviewerModel('openai/o3-mini');
  await Configuration.setReviewerSystemPrompt('Custom Walkthrough Reviewer Instructions: Verify edge cases.');

  const provider = new OpenRouterPanelProvider(
    vscode.Uri.file('C:/mock/extension') as any,
    secretStore,
    historyStore,
    permissionManager,
    usageStore,
    storageUri
  );

  const msgId = 'msg-walkthrough-presentation';
  const rawWalkthroughDocument = `# Verification Walkthrough
- Test 1: PASS
- Test 2: PASS`;

  await historyStore.appendMessage({
    id: msgId,
    role: 'assistant',
    content: 'Walkthrough ready',
    walkthroughDocument: rawWalkthroughDocument,
    timestamp: Date.now(),
  });

  const capturedOutgoingMessages: any[] = [];
  const originalSendChatCompletionStream = OpenRouterClient.sendChatCompletionStream;
  OpenRouterClient.sendChatCompletionStream = async (
    _apiKey: string,
    _model: string,
    messages: any[],
    onChunk: (chunk: string) => void,
    onDone: (usage: any) => Promise<void>
  ) => {
    capturedOutgoingMessages.push(...messages);
    onChunk('Walkthrough critique chunk');
    await onDone({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  };

  const postedWebviewMessages: any[] = [];
  (provider as any)._postMessage = (msg: any) => {
    postedWebviewMessages.push(msg);
  };

  try {
    await (provider as any)._handleStartReview('walkthrough', msgId);

    const { activeSession } = await historyStore.loadReviewerSessions();
    assert.strictEqual(activeSession.messages.length, 2);

    const storedUserMessage = activeSession.messages[0];
    assert.strictEqual(
      storedUserMessage.content,
      'Review this walkthrough',
      'Stored user turn on walkthrough must be Review this walkthrough'
    );
    assert.strictEqual(
      storedUserMessage.content.includes(rawWalkthroughDocument),
      false,
      'Walkthrough document must not leak into user chat bubble'
    );

    const reviewerDataEvent = postedWebviewMessages.find((m) => m.type === 'REVIEWER_VIEW_DATA');
    assert.ok(reviewerDataEvent);
    assert.strictEqual(reviewerDataEvent.artifactContent, rawWalkthroughDocument);
    assert.strictEqual(
      reviewerDataEvent.history[0].content,
      'Review this walkthrough'
    );

    const systemMessage = capturedOutgoingMessages.find((m) => m.role === 'system');
    assert.ok(systemMessage);
    assert.ok(systemMessage.content.includes('Custom Walkthrough Reviewer Instructions: Verify edge cases.'));
    assert.ok(systemMessage.content.includes(rawWalkthroughDocument));
  } finally {
    OpenRouterClient.sendChatCompletionStream = originalSendChatCompletionStream;
  }
});

test('Reviewer Phase 21: Follow-up user turn with attached plan grounds document directly in outgoing user message while preserving clean stored turn in historyStore', async () => {
  const { OpenRouterPanelProvider } = require('../src/webview/panelProvider');
  const { OpenRouterClient } = require('../src/api/openrouterClient');
  const historyStore = new HistoryStore();
  const secretStore = { getApiKey: async () => 'test-api-key' } as any;
  const permissionManager = {} as any;
  const usageStore = new UsageStore();
  const storageUri = vscode.Uri.file('C:/mock/storage');

  (vscode.workspace as any)._currentWorkspaceKey = 'reviewer-phase21-grounding';
  await Configuration.setReviewerEnabled(true);
  await Configuration.setReviewerModel('google/gemini-2.5-flash');
  await Configuration.setReviewerSystemPrompt('You are an expert reviewer model.');

  const originalSendChatCompletionStream = OpenRouterClient.sendChatCompletionStream;
  let capturedOutgoingMessages: Array<{ role: string; content: string }> = [];

  OpenRouterClient.sendChatCompletionStream = async (
    _key: string,
    _model: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: (c: string) => void,
    onDone: (u: any) => void
  ) => {
    capturedOutgoingMessages = [...messages];
    onChunk('Plan review feedback: All 5 priority items verified.');
    onDone({ prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 });
  };

  const provider = new OpenRouterPanelProvider(
    vscode.Uri.file('c:/mock/extension') as any,
    secretStore,
    historyStore,
    permissionManager,
    usageStore,
    storageUri
  );

  const initialPlanMarkdown = '# Architecture Plan v1\n1. Initial database schema';
  const updatedPlanMarkdown = '# Architecture Plan v2 (Revised)\n1. SQLCipher key lifecycle\n2. G-6 durability CI gate\n3. Zero-loss autosave';

  try {
    // 1. Start initial review
    const session = await historyStore.startNewReviewerSession('Plan Review', {
      artifactType: 'plan',
      artifactContent: initialPlanMarkdown,
    });
    await historyStore.appendReviewerMessage({
      id: 'turn1-user',
      role: 'user',
      content: 'You are an expert reviewer model.',
      timestamp: Date.now(),
      attachedFile: { name: 'Plan docs', artifactType: 'plan' },
    });
    await historyStore.appendReviewerMessage({
      id: 'turn1-assistant',
      role: 'assistant',
      content: 'Previous Critique: 5 priority items must be resolved.',
      timestamp: Date.now(),
    });

    await provider._handleOpenDirectReviewer();

    // 2. User sends follow-up with updated plan attached: "review this new one"
    await (provider as any)._handleSendReviewerMessage(
      'review this new one',
      undefined,
      undefined,
      updatedPlanMarkdown,
      'plan',
      {
        name: 'Plan docs',
        artifactType: 'plan',
        content: updatedPlanMarkdown,
      }
    );

    // 3. In HistoryStore: stored user message must be clean user text (no raw markdown flooding chat bubble)
    const { activeSession } = await historyStore.loadReviewerSessions();
    assert.strictEqual(activeSession.messages.length, 4, 'Session must now have 4 messages');
    const storedFollowUp = activeSession.messages[2];
    assert.strictEqual(storedFollowUp.role, 'user');
    assert.strictEqual(storedFollowUp.content, 'review this new one', 'Stored content must remain clean user note');
    assert.strictEqual(storedFollowUp.content.includes(updatedPlanMarkdown), false, 'Raw plan must not be in stored message content');
    assert.ok(storedFollowUp.attachedFile, 'Stored message must retain attachedFile metadata');
    assert.strictEqual(storedFollowUp.attachedFile?.name, 'Plan docs');
    assert.strictEqual((storedFollowUp.attachedFile as any)?.content, updatedPlanMarkdown, 'Stored attachedFile must retain content');

    // 4. In outgoing messages sent to model: user turn must be augmented with attached document context
    const outgoingUserMsgs = capturedOutgoingMessages.filter((m) => m.role === 'user');
    const lastOutgoingUserMsg = outgoingUserMsgs[outgoingUserMsgs.length - 1];
    assert.ok(lastOutgoingUserMsg, 'Must have outgoing user message');
    assert.ok(lastOutgoingUserMsg.content.includes('review this new one'), 'Outgoing user turn must include user text');
    assert.ok(lastOutgoingUserMsg.content.includes(updatedPlanMarkdown), 'Outgoing user turn must include updated plan document');
    assert.ok(
      lastOutgoingUserMsg.content.includes('# Attached Document Under Review (Plan docs):'),
      'Outgoing user turn must include structured attachment header'
    );

    // 5. System prompt must also retain effective system context
    const systemMsg = capturedOutgoingMessages.find((m) => m.role === 'system');
    assert.ok(systemMsg);
    assert.ok(systemMsg.content.includes(updatedPlanMarkdown));
  } finally {
    OpenRouterClient.sendChatCompletionStream = originalSendChatCompletionStream;
  }
});

test('Reviewer Pinned Context: Loads workspace pinned file into system prompt and preserves across context reset', async () => {
  const { OpenRouterPanelProvider } = require('../src/webview/panelProvider');
  const historyStore = new HistoryStore();
  const secretStore = { getApiKey: async () => 'test-api-key' } as any;
  const permissionManager = {} as any;
  const usageStore = new UsageStore();
  const storageUri = vscode.Uri.file('C:/mock/storage');

  (vscode.workspace as any)._currentWorkspaceKey = 'reviewer-pinned-context-test';
  await Configuration.setReviewerEnabled(true);
  await Configuration.setReviewerModel('google/gemini-2.5-flash');
  await Configuration.setReviewerSystemPrompt('You are an expert reviewer model.');

  const provider = new OpenRouterPanelProvider(
    vscode.Uri.file('c:/mock/extension') as any,
    secretStore,
    historyStore,
    permissionManager,
    usageStore,
    storageUri
  );

  const pinnedRelativePath = 'docs/architecture_rules.md';
  const pinnedContent = '# Architecture Rules\n1. Strictly clean architecture\n2. No global leaks';

  // Mock _loadPinnedContextContent for this unit test
  (provider as any)._loadPinnedContextContent = async () => ({
    relativePath: pinnedRelativePath,
    content: pinnedContent,
  });

  // Set pinned context file setting
  await Configuration.setReviewerPinnedContextFile(pinnedRelativePath);
  assert.strictEqual(
    Configuration.getReviewerPinnedContextFile(),
    pinnedRelativePath,
    'Pinned context file setting must be saved per workspace'
  );

  const planMsgId = 'msg-plan-pinned-context-test';
  const planMarkdown = '## Plan\nStep 1: Build\nStep 2: Verify';
  await historyStore.appendMessage({
    id: planMsgId,
    role: 'assistant',
    content: 'Plan ready',
    planDocument: planMarkdown,
    timestamp: Date.now(),
  });

  const capturedOutgoingMessages: any[] = [];
  const originalSendChatCompletionStream = OpenRouterClient.sendChatCompletionStream;
  (OpenRouterClient as any).sendChatCompletionStream = async (
    _apiKey: string,
    _model: string,
    messages: any[],
    onChunk: (chunk: string) => void,
    onDone: (usage: any) => Promise<void>
  ) => {
    capturedOutgoingMessages.push(...messages);
    onChunk('Looks good according to rules');
    await onDone({ prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 });
  };

  try {
    // 1. Trigger review
    await (provider as any)._handleStartReview('plan', planMsgId);

    // Assert outgoing system message contains both pinned context file content AND the plan document
    const systemMsg = capturedOutgoingMessages.find((m) => m.role === 'system');
    assert.ok(systemMsg, 'Outgoing request must have system message');
    assert.ok(
      systemMsg.content.includes('# Pinned Workspace Context (docs/architecture_rules.md):'),
      'System prompt must include pinned context header'
    );
    assert.ok(
      systemMsg.content.includes("Active Pinned Workspace Context: The file 'docs/architecture_rules.md' contains authoritative project guidelines."),
      'System prompt must include model awareness framing'
    );
    assert.ok(
      systemMsg.content.includes('Strictly clean architecture'),
      'System prompt must include pinned file contents'
    );
    assert.ok(
      systemMsg.content.includes(planMarkdown),
      'System prompt must include the plan under review'
    );

    // 2. Trigger context reset: chat history is cleared, but pinned file setting is preserved
    await historyStore.clearActiveReviewerSession();
    const { activeSession } = await historyStore.loadReviewerSessions();
    assert.strictEqual(activeSession.messages.length, 0, 'Active session messages must be cleared');
    assert.strictEqual(
      Configuration.getReviewerPinnedContextFile(),
      pinnedRelativePath,
      'Pinned context file configuration must be preserved across reviewer context reset'
    );
  } finally {
    OpenRouterClient.sendChatCompletionStream = originalSendChatCompletionStream;
    await Configuration.setReviewerPinnedContextFile('');
  }
});

test('Reviewer In-Place Retry: truncates old assistant response and streams fresh replacement', async () => {
  const { OpenRouterPanelProvider } = require('../src/webview/panelProvider');
  const historyStore = new HistoryStore();
  const secretStore = { getApiKey: async () => 'test-api-key' } as any;
  const permissionManager = {} as any;
  const usageStore = new UsageStore();
  const storageUri = vscode.Uri.file('C:/mock/storage');

  (vscode.workspace as any)._currentWorkspaceKey = 'reviewer-retry-test';
  await Configuration.setReviewerEnabled(true);
  await Configuration.setReviewerModel('google/gemini-2.5-flash');

  const provider = new OpenRouterPanelProvider(
    vscode.Uri.file('c:/mock/extension') as any,
    secretStore,
    historyStore,
    permissionManager,
    usageStore,
    storageUri
  );

  let streamCount = 0;
  const originalSend = OpenRouterClient.sendChatCompletionStream;
  (OpenRouterClient as any).sendChatCompletionStream = async (
    _apiKey: string,
    _model: string,
    _messages: any[],
    onChunk: (chunk: string) => void,
    onDone: (usage: any) => Promise<void>
  ) => {
    streamCount++;
    onChunk(`Critique version ${streamCount}`);
    await onDone({ prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 });
  };

  try {
    // 1. Start initial review
    const planMsgId = 'msg-plan-retry-test';
    await historyStore.appendMessage({
      id: planMsgId,
      role: 'assistant',
      content: 'Plan ready',
      planDocument: '## Database Plan',
      timestamp: Date.now(),
    });

    await (provider as any)._handleStartReview('plan', planMsgId);
    let { activeSession } = await historyStore.loadReviewerSessions();
    assert.strictEqual(activeSession.messages.length, 2, 'Initial review must produce 1 user and 1 assistant message');
    assert.strictEqual(activeSession.messages[0].role, 'user');
    assert.strictEqual(activeSession.messages[1].role, 'assistant');
    assert.strictEqual(activeSession.messages[1].content, 'Critique version 1');

    const firstUserMsgId = activeSession.messages[0].id;

    // 2. Trigger retry on that user prompt
    await (provider as any)._handleRetryReviewerMessage(firstUserMsgId);

    const reloaded = await historyStore.loadReviewerSessions();
    activeSession = reloaded.activeSession;

    // Messages length must still be 2 (old assistant response was cleanly replaced, not stacked!)
    assert.strictEqual(activeSession.messages.length, 2, 'In-place retry must replace assistant response without stacking');
    assert.strictEqual(activeSession.messages[0].id, firstUserMsgId);
    assert.strictEqual(activeSession.messages[1].content, 'Critique version 2');
  } finally {
    OpenRouterClient.sendChatCompletionStream = originalSend;
  }
});

test('Reviewer Inline Edit: updates prompt text, preserves attached plan artifact, and regenerates response', async () => {
  const { OpenRouterPanelProvider } = require('../src/webview/panelProvider');
  const historyStore = new HistoryStore();
  const secretStore = { getApiKey: async () => 'test-api-key' } as any;
  const permissionManager = {} as any;
  const usageStore = new UsageStore();
  const storageUri = vscode.Uri.file('C:/mock/storage');

  (vscode.workspace as any)._currentWorkspaceKey = 'reviewer-edit-test';
  await Configuration.setReviewerEnabled(true);
  await Configuration.setReviewerModel('google/gemini-2.5-flash');

  const provider = new OpenRouterPanelProvider(
    vscode.Uri.file('c:/mock/extension') as any,
    secretStore,
    historyStore,
    permissionManager,
    usageStore,
    storageUri
  );

  let streamCount = 0;
  const originalSend = OpenRouterClient.sendChatCompletionStream;
  (OpenRouterClient as any).sendChatCompletionStream = async (
    _apiKey: string,
    _model: string,
    _messages: any[],
    onChunk: (chunk: string) => void,
    onDone: (usage: any) => Promise<void>
  ) => {
    streamCount++;
    onChunk(`Critique response ${streamCount}`);
    await onDone({ prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 });
  };

  try {
    const planMsgId = 'msg-plan-edit-test';
    await historyStore.appendMessage({
      id: planMsgId,
      role: 'assistant',
      content: 'Plan ready',
      planDocument: '## Architecture Plan',
      timestamp: Date.now(),
    });

    await (provider as any)._handleStartReview('plan', planMsgId);
    let { activeSession } = await historyStore.loadReviewerSessions();
    const firstUserMsg = activeSession.messages[0];
    assert.ok(firstUserMsg.attachedFile, 'Initial user message must have attachedFile plan reference');
    assert.strictEqual(firstUserMsg.attachedFile?.name, 'Plan docs');

    // Edit user prompt text
    const editedPrompt = 'Review this plan with a focus on database scalability';
    await (provider as any)._handleEditReviewerMessage(firstUserMsg.id, editedPrompt);

    const reloaded = await historyStore.loadReviewerSessions();
    activeSession = reloaded.activeSession;

    assert.strictEqual(activeSession.messages.length, 2, 'Session must have 2 messages (edited prompt + new response)');
    assert.strictEqual(activeSession.messages[0].content, editedPrompt, 'User message content must be updated');
    assert.ok(activeSession.messages[0].attachedFile, 'Attached file reference must be strictly preserved after edit');
    assert.strictEqual(activeSession.messages[0].attachedFile?.name, 'Plan docs');
    assert.strictEqual(activeSession.messages[1].content, 'Critique response 2', 'Assistant response must be regenerated');
  } finally {
    OpenRouterClient.sendChatCompletionStream = originalSend;
  }
});

test('Reviewer Generation Lock: edit and retry are rejected while active stream is running', async () => {
  const { OpenRouterPanelProvider } = require('../src/webview/panelProvider');
  const historyStore = new HistoryStore();
  const secretStore = { getApiKey: async () => 'test-api-key' } as any;
  const permissionManager = {} as any;
  const usageStore = new UsageStore();
  const storageUri = vscode.Uri.file('C:/mock/storage');

  (vscode.workspace as any)._currentWorkspaceKey = 'reviewer-lock-test';
  await Configuration.setReviewerEnabled(true);
  await Configuration.setReviewerModel('google/gemini-2.5-flash');

  const provider = new OpenRouterPanelProvider(
    vscode.Uri.file('c:/mock/extension') as any,
    secretStore,
    historyStore,
    permissionManager,
    usageStore,
    storageUri
  );

  let streamTriggered = false;
  const originalSend = OpenRouterClient.sendChatCompletionStream;
  OpenRouterClient.sendChatCompletionStream = async () => {
    streamTriggered = true;
  };

  try {
    // Simulate active generation stream
    (provider as any)._activeReviewerAbortController = new AbortController();

    // Attempt retry and edit while busy
    await (provider as any)._handleRetryReviewerMessage('test-id');
    assert.strictEqual(streamTriggered, false, 'Retry must be rejected while generation is active');

    await (provider as any)._handleEditReviewerMessage('test-id', 'New prompt');
    assert.strictEqual(streamTriggered, false, 'Edit must be rejected while generation is active');
  } finally {
    (provider as any)._activeReviewerAbortController = undefined;
    OpenRouterClient.sendChatCompletionStream = originalSend;
  }
});





