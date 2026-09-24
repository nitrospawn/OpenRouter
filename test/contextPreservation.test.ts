import test from 'node:test';
import assert from 'node:assert';
import { HistoryStore } from '../src/conversation/historyStore';
import { extractArtifacts } from '../src/prompt/responseParser';
import * as vscode from 'vscode';

function makePersistentStore(prefix: string): HistoryStore {
  const memoryFiles = new Map<string, Uint8Array>();
  (vscode.workspace.fs as any).readFile = async (uri: any) => {
    const key = uri.fsPath || uri.path;
    if (memoryFiles.has(key)) return memoryFiles.get(key);
    throw new Error('File not found');
  };
  (vscode.workspace.fs as any).writeFile = async (uri: any, content: Uint8Array) => {
    const key = uri.fsPath || uri.path;
    memoryFiles.set(key, content);
  };
  (vscode.workspace.fs as any).createDirectory = async () => {};
  const storageUri = vscode.Uri.file('C:/mock/storage-ctx-' + prefix);
  return new HistoryStore(storageUri as any);
}

test('Context Preservation: totalTokens is persisted on assistant message and promoted to lastTotalTokens on session', async () => {
  const store = makePersistentStore('tok-persist');
  await store.loadSessions();
  await store.appendMessage({ id: 'u1', role: 'user', content: 'Generate a plan', timestamp: 1000 });
  await store.appendMessage({ id: 'a1', role: 'assistant', content: '📄 Plan docs ready — [view]', planDocument: '# Plan\nStep 1\nStep 2\nStep 3', timestamp: 1001, totalTokens: 14250 });
  const { activeSession } = await store.loadSessions();
  assert.strictEqual(activeSession.lastTotalTokens, 14250);
  const msg = activeSession.messages.find((m) => m.id === 'a1');
  assert.ok(msg);
  assert.strictEqual(msg?.totalTokens, 14250);
});

test('Context Preservation: lastTotalTokens inferred from most recent message with totalTokens', async () => {
  const store = makePersistentStore('tok-infer');
  await store.loadSessions();
  await store.appendMessage({ id: 'u1', role: 'user', content: 'Question', timestamp: 1000 });
  await store.appendMessage({ id: 'a1', role: 'assistant', content: 'Plan here', planDocument: '# Plan\nDetails...', timestamp: 1001, totalTokens: 12500 });
  await store.appendMessage({ id: 'u2', role: 'user', content: 'Proceed', timestamp: 1002 });
  await store.appendMessage({ id: 'a2', role: 'assistant', content: 'Done!', timestamp: 1003, totalTokens: 18000 });
  const { activeSession } = await store.loadSessions();
  assert.strictEqual(activeSession.lastTotalTokens, 18000);
});

test('Context Preservation: planDocument and walkthroughDocument both stored in StoredChatMessage', async () => {
  const store = makePersistentStore('plan-wt-persist');
  await store.loadSessions();
  await store.appendMessage({ id: 'u1', role: 'user', content: 'Build it', timestamp: 1000 });
  await store.appendMessage({ id: 'a1', role: 'assistant', content: '📄 Plan docs ready — [view]', planDocument: '# Detailed Plan\nSection A\nSection B', walkthroughDocument: '# Walkthrough\nStep 1 done\nStep 2 done', timestamp: 1001, totalTokens: 9500 });
  const messages = await store.loadHistory();
  const a1 = messages.find((m) => m.id === 'a1');
  assert.ok(a1);
  assert.ok(a1?.planDocument?.includes('Section A'));
  assert.ok(a1?.walkthroughDocument?.includes('Step 1 done'));
});

test('Context Preservation: historyTokenEstimate accounts for planDocument length', () => {
  const history = [
    { role: 'user', content: 'Create a plan', planDocument: undefined, walkthroughDocument: undefined },
    { role: 'assistant', content: '📄 Plan docs ready — [view]', planDocument: 'A'.repeat(40000), walkthroughDocument: undefined },
  ];
  const estimateTokens = (s: string) => Math.ceil(s.length / 4);
  const legacyEstimate = history.reduce((acc, h) => acc + estimateTokens(h.content ?? ''), 0);
  const fixedEstimate = history.reduce((acc, h) => {
    let count = estimateTokens(h.content ?? '');
    if (h.planDocument) count += estimateTokens(h.planDocument);
    if (h.walkthroughDocument) count += estimateTokens(h.walkthroughDocument);
    return acc + count;
  }, 0);
  assert.ok(legacyEstimate < 20, 'Legacy estimate (' + legacyEstimate + ') should be tiny');
  assert.ok(fixedEstimate >= 10000, 'Fixed estimate (' + fixedEstimate + ') must include plan tokens');
});

test('Context Preservation: session switch restores lastTotalTokens accurately', async () => {
  const store = makePersistentStore('session-switch');
  await store.loadSessions();
  await store.appendMessage({ id: 'u1', role: 'user', content: 'Build me something', timestamp: 1000 });
  await store.appendMessage({ id: 'a1', role: 'assistant', content: '📄 Plan docs ready — [view]', planDocument: '# My Big Plan\nLots of details...', timestamp: 1001, totalTokens: 14200 });
  const { activeSession: session1 } = await store.loadSessions();
  const session1Id = session1.id;
  assert.strictEqual(session1.lastTotalTokens, 14200);
  await store.startNewSession();
  await store.appendMessage({ id: 'u2', role: 'user', content: 'Unrelated question', timestamp: 2000 });
  await store.appendMessage({ id: 'a2', role: 'assistant', content: 'Short answer', timestamp: 2001, totalTokens: 320 });
  const { activeSession: session2 } = await store.loadSessions();
  assert.notStrictEqual(session2.id, session1Id);
  assert.strictEqual(session2.lastTotalTokens, 320);
  await store.switchSession(session1Id);
  const { activeSession: restored } = await store.loadSessions();
  assert.strictEqual(restored.id, session1Id);
  assert.strictEqual(restored.lastTotalTokens, 14200);
});
