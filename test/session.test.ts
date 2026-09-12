import test from 'node:test';
import assert from 'node:assert';
import { HistoryStore } from '../src/conversation/historyStore';
import * as vscode from 'vscode';

test('HistoryStore: renameSession renames existing session and updates timestamp', async () => {
  // Create an in-memory mock storage
  const memoryFiles: Map<string, Uint8Array> = new Map();
  (vscode.workspace.fs as any).readFile = async (uri: any) => {
    const key = uri.fsPath || uri.path;
    if (memoryFiles.has(key)) {
      return memoryFiles.get(key);
    }
    throw new Error('File not found');
  };
  (vscode.workspace.fs as any).writeFile = async (uri: any, content: Uint8Array) => {
    const key = uri.fsPath || uri.path;
    memoryFiles.set(key, content);
  };

  const storageUri = vscode.Uri.file('C:/mock/storage');
  const store = new HistoryStore(storageUri as any);

  const { activeSession } = await store.loadSessions();
  assert.strictEqual(activeSession.title, 'New Chat');

  const oldUpdatedAt = activeSession.updatedAt;
  const success = await store.renameSession(activeSession.id, 'My Custom Refactoring Chat');
  assert.strictEqual(success, true);

  const { activeSession: updatedSession } = await store.loadSessions();
  assert.strictEqual(updatedSession.title, 'My Custom Refactoring Chat');
  assert.ok(updatedSession.updatedAt >= oldUpdatedAt);
});

test('HistoryStore: renameSession handles whitespace trimming and default fallback', async () => {
  const storageUri = vscode.Uri.file('C:/mock/storage-2');
  const store = new HistoryStore(storageUri as any);

  const { activeSession } = await store.loadSessions();
  await store.renameSession(activeSession.id, '   Feature Discussion \n with new lines  ');

  const { activeSession: updated } = await store.loadSessions();
  assert.strictEqual(updated.title, 'Feature Discussion   with new lines');

  // Empty or pure whitespace fallback
  await store.renameSession(activeSession.id, '     ');
  const { activeSession: fallbackSession } = await store.loadSessions();
  assert.strictEqual(fallbackSession.title, 'Untitled Chat');

  // Non-existent session id
  const falseResult = await store.renameSession('non-existent-id', 'New Title');
  assert.strictEqual(falseResult, false);
});

test('HistoryStore: getMessagesAfter and truncateAfter manage message pruning correctly', async () => {
  const memoryFiles: Map<string, Uint8Array> = new Map();
  (vscode.workspace.fs as any).readFile = async (uri: any) => {
    const key = uri.fsPath || uri.path;
    if (memoryFiles.has(key)) {
      return memoryFiles.get(key);
    }
    throw new Error('File not found');
  };
  (vscode.workspace.fs as any).writeFile = async (uri: any, content: Uint8Array) => {
    const key = uri.fsPath || uri.path;
    memoryFiles.set(key, content);
  };

  const storageUri = vscode.Uri.file('C:/mock/storage-truncate');
  const store = new HistoryStore(storageUri as any);

  await store.loadSessions();

  // Add a sequence of messages: user1 -> assistant1 -> user2 -> assistant2
  await store.appendMessage({ id: 'msg-u1', role: 'user', content: 'Turn 1 prompt', timestamp: 1000 });
  await store.appendMessage({ id: 'msg-a1', role: 'assistant', content: 'Turn 1 reply', timestamp: 1001 });
  await store.appendMessage({ id: 'msg-u2', role: 'user', content: 'Turn 2 prompt', timestamp: 1002 });
  await store.appendMessage({ id: 'msg-a2', role: 'assistant', content: 'Turn 2 reply', timestamp: 1003 });

  // 1. getMessagesAfter msg-u1 should return [msg-a1, msg-u2, msg-a2]
  const afterU1 = await store.getMessagesAfter('msg-u1');
  assert.strictEqual(afterU1.length, 3);
  assert.deepStrictEqual(afterU1.map((m) => m.id), ['msg-a1', 'msg-u2', 'msg-a2']);

  // 2. getMessagesAfter msg-a2 (last message) should return []
  const afterLast = await store.getMessagesAfter('msg-a2');
  assert.strictEqual(afterLast.length, 0);

  // 3. truncateAfter msg-u1 should prune msg-u1 and everything after it
  const truncRes = await store.truncateAfter('msg-u1');
  assert.strictEqual(truncRes.success, true);
  assert.strictEqual(truncRes.removedCount, 4);

  const historyAfterTrunc = await store.loadHistory();
  assert.strictEqual(historyAfterTrunc.length, 0);

  // 4. truncateAfter on a non-existent message is a safe no-op
  const noOpRes = await store.truncateAfter('msg-u1');
  assert.strictEqual(noOpRes.success, false);
  assert.strictEqual(noOpRes.removedCount, 0);
});

