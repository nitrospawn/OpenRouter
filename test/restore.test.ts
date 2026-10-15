import test from 'node:test';
import assert from 'node:assert';
import { ScopedRestore } from '../src/shadowGit/restore';
import { OpenRouterPanelProvider } from '../src/webview/panelProvider';
import { HistoryStore } from '../src/conversation/historyStore';
import * as vscode from 'vscode';
import { WebviewToHostMessage, HostToWebviewMessage } from '../src/webview/messages';

class MockShadowRepo {
  public executedCommands: string[][] = [];
  public diffResult: string = '';
  public workTree: string = 'C:/mock/workspace';

  public getWorkTree(): string {
    return this.workTree;
  }

  public async initialize(): Promise<boolean> {
    return true;
  }

  public async runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.executedCommands.push(args);
    if (args[0] === 'diff') {
      return { stdout: this.diffResult, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }
}

test('ScopedRestore: hard requirement — only touches files in the specified changeset', async () => {
  const mockRepo = new MockShadowRepo();
  const restore = new ScopedRestore(mockRepo as any);

  const checkpointId = 'commit-turn-1';
  const turn1AffectedFiles = ['src/components/button.ts'];

  // Other files created/modified in turn 2 and turn 3 that must NOT be touched
  const subsequentFiles = ['src/components/card.ts', 'src/utils/format.ts'];

  const result = await restore.restore(checkpointId, turn1AffectedFiles, true);

  assert.strictEqual(result.success, true);
  assert.strictEqual(mockRepo.executedCommands.length, 1);

  const checkoutCmd = mockRepo.executedCommands[0];
  assert.strictEqual(checkoutCmd[0], 'checkout');
  assert.strictEqual(checkoutCmd[1], checkpointId);
  assert.strictEqual(checkoutCmd[2], '--');
  assert.strictEqual(checkoutCmd[3], 'src/components/button.ts');

  // Verify none of the subsequent files are anywhere in the command arguments
  for (const file of subsequentFiles) {
    assert.strictEqual(
      checkoutCmd.includes(file),
      false,
      `Failure mode detected: Scoped restore touched out-of-changeset file: ${file}`
    );
  }
});

test('ScopedRestore: rejects empty affectedFiles array without executing git', async () => {
  const mockRepo = new MockShadowRepo();
  const restore = new ScopedRestore(mockRepo as any);

  const result = await restore.restore('commit-123', []);
  assert.strictEqual(result.success, false);
  assert.strictEqual(mockRepo.executedCommands.length, 0);
});

test('ScopedRestore: halts on drift detection when force is false', async () => {
  const mockRepo = new MockShadowRepo();
  // Simulate drift by returning non-empty diff
  mockRepo.diffResult = 'diff --git a/file.ts b/file.ts\n+ manual change';

  const restore = new ScopedRestore(mockRepo as any);
  const result = await restore.restore('commit-123', ['file.ts'], false);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.drifted, true);

  // Should have only run diff, not checkout
  const ranCheckout = mockRepo.executedCommands.some((cmd) => cmd[0] === 'checkout');
  assert.strictEqual(ranCheckout, false);
});

test('ScopedRestore: forces restore when force=true even if drift exists', async () => {
  const mockRepo = new MockShadowRepo();
  mockRepo.diffResult = 'diff --git a/file.ts b/file.ts\n+ manual change';

  const restore = new ScopedRestore(mockRepo as any);
  const result = await restore.restore('commit-123', ['file.ts'], true);

  assert.strictEqual(result.success, true);
  const ranCheckout = mockRepo.executedCommands.some((cmd) => cmd[0] === 'checkout');
  assert.strictEqual(ranCheckout, true);
});

test('ScopedRestore: cross-turn file isolation — manual edits to a file from Turn 1 are untouched when restoring Turn 2', async () => {
  // Scenario:
  // Turn 1 touched 'src/service.ts'.
  // User then manually edited 'src/service.ts' (e.g. content: "manual_edit_v2_12345").
  // Turn 2 touched 'src/utils.ts' with checkpoint 'commit-turn-2'.
  // User triggers an undo targeting Turn 2.
  // Requirement: 'src/service.ts' must be byte-for-byte preserved and NOT touched by the Turn 2 restore.

  const mockRepo = new MockShadowRepo();
  const fileContents = new Map<string, string>();

  // Turn 1 file with manual user edits
  const turn1ManualContent = 'export const serviceConfig = { version: "manual_edit_v2_12345", port: 8080 };';
  fileContents.set('src/service.ts', turn1ManualContent);

  // Turn 2 file state before restore
  fileContents.set('src/utils.ts', 'export const utils = "ai_modified_in_turn_2";');

  // Wire mock runGit to simulate realistic checkout behaviour scoped to arguments
  mockRepo.runGit = async (args: string[]) => {
    mockRepo.executedCommands.push(args);
    if (args[0] === 'checkout') {
      const commit = args[1];
      const targetFiles = args.slice(3); // after '--'
      for (const target of targetFiles) {
        if (target === 'src/utils.ts') {
          fileContents.set(target, 'export const utils = "restored_to_pre_turn_2";');
        } else {
          fileContents.set(target, `restored_from_${commit}`);
        }
      }
    }
    return { stdout: '', stderr: '' };
  };

  const restore = new ScopedRestore(mockRepo as any);
  const turn2AffectedFiles = ['src/utils.ts'];

  // Restore Turn 2
  const result = await restore.restore('commit-turn-2', turn2AffectedFiles, true);

  assert.strictEqual(result.success, true, 'Turn 2 restore must succeed');
  assert.strictEqual(mockRepo.executedCommands.length, 1, 'Only one checkout command should execute');

  const checkoutCmd = mockRepo.executedCommands[0];
  assert.strictEqual(checkoutCmd[0], 'checkout');
  assert.strictEqual(checkoutCmd[1], 'commit-turn-2');
  assert.strictEqual(checkoutCmd.includes('src/service.ts'), false, 'src/service.ts must NOT be in checkout arguments');

  // Hard assertion: src/service.ts content must be byte-for-byte identical to the manual edit
  assert.strictEqual(
    fileContents.get('src/service.ts'),
    turn1ManualContent,
    'src/service.ts content must be byte-for-byte preserved after Turn 2 restore'
  );
  // utils.ts was restored
  assert.strictEqual(
    fileContents.get('src/utils.ts'),
    'export const utils = "restored_to_pre_turn_2";',
    'src/utils.ts should be restored'
  );
});

test('ScopedRestore: deletion-drift — restoring an AI-deleted file halts with drifted: true if user manually recreated it with different content', async () => {
  // Scenario:
  // Turn 1 deleted 'config/auth.json'.
  // Checkpoint 'commit-turn-1' contains the file content prior to deletion: '{"auth": "v1_original"}'.
  // Later, user manually recreated 'config/auth.json' on disk with: '{"auth": "user_recreated_custom"}'.
  // User triggers undo for Turn 1 without force=true.
  // Requirement: drift detection detects that the recreated file differs from checkpoint, halts with drifted: true,
  // and does NOT overwrite or delete the user's recreated file.

  const mockRepo = new MockShadowRepo();
  const fsFiles = new Map<string, string>();

  // User's recreated file on disk
  const userRecreatedContent = '{"auth": "user_recreated_custom", "secret": "my-secret-key"}';
  fsFiles.set('config/auth.json', userRecreatedContent);

  // Mock runGit behavior:
  // When git diff commit-turn-1 -- config/auth.json runs, it reports a diff because user's recreated file differs
  mockRepo.runGit = async (args: string[]) => {
    mockRepo.executedCommands.push(args);
    if (args[0] === 'diff') {
      const commit = args[1];
      const file = args[3];
      if (file === 'config/auth.json' && commit === 'commit-turn-1') {
        // Non-empty diff output representing drift between commit and recreated file on disk
        return {
          stdout: `diff --git a/config/auth.json b/config/auth.json\n--- a/config/auth.json\n+++ b/config/auth.json\n@@ -1 +1 @@\n-{"auth": "v1_original"}\n+${userRecreatedContent}\n`,
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'checkout') {
      // Overwrite file on disk
      fsFiles.set('config/auth.json', '{"auth": "v1_original"}');
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const restore = new ScopedRestore(mockRepo as any);

  // 1. Attempt unforced restore (force = false)
  const unforcedResult = await restore.restore('commit-turn-1', ['config/auth.json'], false);

  assert.strictEqual(unforcedResult.success, false, 'Unforced restore must halt');
  assert.strictEqual(unforcedResult.drifted, true, 'Drifted flag must be true');

  // Verify checkout was NOT executed and user's recreated file was NOT overwritten
  const ranCheckout = mockRepo.executedCommands.some((cmd) => cmd[0] === 'checkout');
  assert.strictEqual(ranCheckout, false, 'git checkout must NOT be called when drifted and force=false');
  assert.strictEqual(
    fsFiles.get('config/auth.json'),
    userRecreatedContent,
    'User-recreated file must be byte-for-byte untouched when drift detected'
  );

  // 2. Forced restore (force = true) after user explicitly accepts the warning
  mockRepo.executedCommands = [];
  const forcedResult = await restore.restore('commit-turn-1', ['config/auth.json'], true);

  assert.strictEqual(forcedResult.success, true, 'Forced restore must succeed');
  const ranForcedCheckout = mockRepo.executedCommands.some((cmd) => cmd[0] === 'checkout');
  assert.strictEqual(ranForcedCheckout, true, 'git checkout must run when force=true');
  assert.strictEqual(
    fsFiles.get('config/auth.json'),
    '{"auth": "v1_original"}',
    'Forced restore replaces file with checkpoint content'
  );
});

test('UNDO_TURN end-to-end: historyStore is strictly NOT truncated if drift is cancelled or file restore fails', async () => {
  // Set up in-memory filesystem for HistoryStore
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
  (vscode.workspace.fs as any).createDirectory = async () => {};

  const storageUri = vscode.Uri.file('C:/mock/storage-undo-e2e');
  const historyStore = new HistoryStore(storageUri as any);
  await historyStore.loadSessions();

  // Populate conversation with multiple turns
  await historyStore.appendMessage({ id: 'msg-u1', role: 'user', content: 'Prompt 1', timestamp: 1000 });
  await historyStore.appendMessage({ id: 'msg-a1', role: 'assistant', content: 'Reply 1', timestamp: 1001 });
  await historyStore.appendMessage({ id: 'msg-u2', role: 'user', content: 'Prompt 2', timestamp: 1002 });
  await historyStore.appendMessage({ id: 'msg-a2', role: 'assistant', content: 'Reply 2', timestamp: 1003 });

  // Verify baseline history length
  let history = await historyStore.loadHistory();
  assert.strictEqual(history.length, 4);

  // Set up OpenRouterPanelProvider with mocked webview
  let onMessageListener: ((data: WebviewToHostMessage) => Promise<void>) | undefined;
  const postedMessages: HostToWebviewMessage[] = [];

  const mockWebview: any = {
    options: {},
    html: '',
    asWebviewUri: (uri: any) => uri,
    cspSource: 'mock-csp',
    onDidReceiveMessage: (listener: any) => {
      onMessageListener = listener;
    },
    postMessage: (msg: any) => {
      postedMessages.push(msg);
    },
  };
  const mockWebviewView: any = {
    webview: mockWebview,
  };

  const dummySecretStore: any = { getApiKey: async () => 'key' };
  const dummyPermissionManager: any = {};
  const dummyUsageStore: any = {};
  const extensionUri = vscode.Uri.file('C:/mock/extension');

  const provider = new OpenRouterPanelProvider(
    extensionUri as any,
    dummySecretStore,
    historyStore,
    dummyPermissionManager,
    dummyUsageStore,
    storageUri as any
  );

  provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
  assert.ok(onMessageListener, 'Webview message listener must be registered');

  // --- Scenario 1: Drift is detected and user CANCELS ---
  let forceRestoreCalled = false;
  (provider as any)._scopedRestore = {
    restore: async (_checkpointId: string, _files: string[], force?: boolean) => {
      if (force) {
        forceRestoreCalled = true;
        return { success: true };
      }
      return { success: false, drifted: true };
    },
  };
  (provider as any)._checkpointManager = {
    createCheckpoint: async () => 'cp-mock',
  };

  // Mock vscode.window.showWarningMessage:
  // 1st call: Pre-flight confirmation -> 'Continue'
  // 2nd call: Drift warning -> 'Cancel'
  let warningCallCount = 0;
  (vscode.window as any).showWarningMessage = async (msg: string, _options?: any, ...items: string[]) => {
    warningCallCount++;
    if (warningCallCount === 1) {
      assert.ok(msg.includes('This will undo this change and remove'), 'First dialog must be pre-flight confirmation');
      return 'Continue';
    }
    if (warningCallCount === 2) {
      assert.ok(msg.includes('manually modified'), 'Second dialog must be drift warning');
      return 'Cancel'; // User cancels!
    }
    return undefined;
  };

  postedMessages.length = 0;
  await onMessageListener!({
    type: 'UNDO_TURN',
    messageId: 'msg-u1',
    checkpointId: 'cp-turn-1',
    affectedFiles: ['src/service.ts'],
  });

  // Verify UNDO_RESULT reported Cancelled
  const cancelResult = postedMessages.find((m) => m.type === 'UNDO_RESULT');
  assert.ok(cancelResult, 'UNDO_RESULT must be sent');
  assert.strictEqual(cancelResult.success, false);
  assert.strictEqual(cancelResult.message, 'Cancelled');
  assert.strictEqual(forceRestoreCalled, false, 'Force restore must not be called when user cancels drift');

  // CRITICAL ASSERTION: All 4 messages must remain in historyStore (NONE pruned)
  history = await historyStore.loadHistory();
  assert.strictEqual(history.length, 4, 'historyStore must retain all 4 messages when drift is cancelled');
  assert.deepStrictEqual(history.map((m) => m.id), ['msg-u1', 'msg-a1', 'msg-u2', 'msg-a2']);

  // --- Scenario 2: Drift detected, user confirms ('Undo Anyway'), but force restore FAILS ---
  warningCallCount = 0;
  (vscode.window as any).showWarningMessage = async (msg: string, _options?: any, ...items: string[]) => {
    warningCallCount++;
    if (warningCallCount === 1) {
      return 'Continue';
    }
    if (warningCallCount === 2) {
      return 'Undo Anyway'; // User accepts risk
    }
    return undefined;
  };

  // ScopedRestore fails on both unforced (drifted) and forced restore
  (provider as any)._scopedRestore = {
    restore: async (_checkpointId: string, _files: string[], force?: boolean) => {
      if (!force) {
        return { success: false, drifted: true };
      }
      return { success: false }; // Force restore failed
    },
  };

  postedMessages.length = 0;
  await onMessageListener!({
    type: 'UNDO_TURN',
    messageId: 'msg-u1',
    checkpointId: 'cp-turn-1',
    affectedFiles: ['src/service.ts'],
  });

  // Verify UNDO_RESULT reported Failure
  const failResult = postedMessages.find((m) => m.type === 'UNDO_RESULT');
  assert.ok(failResult, 'UNDO_RESULT must be sent');
  assert.strictEqual(failResult.success, false);
  assert.strictEqual(failResult.message, 'Failed to revert workspace files.');

  // CRITICAL ASSERTION: All 4 messages must STILL remain untouched in historyStore
  history = await historyStore.loadHistory();
  assert.strictEqual(history.length, 4, 'historyStore must retain all 4 messages when file restore fails');
  assert.deepStrictEqual(history.map((m) => m.id), ['msg-u1', 'msg-a1', 'msg-u2', 'msg-a2']);

  // --- Scenario 3: Successful restore -> history IS truncated ---
  (vscode.window as any).showWarningMessage = async () => 'Continue';
  (provider as any)._scopedRestore = {
    restore: async () => ({ success: true }),
  };
  (provider as any)._shadowRepo = {
    runGit: async () => ({ stdout: '', stderr: '' }),
  };

  postedMessages.length = 0;
  await onMessageListener!({
    type: 'UNDO_TURN',
    messageId: 'msg-u1',
    checkpointId: 'cp-turn-1',
    affectedFiles: ['src/service.ts'],
  });

  const successResult = postedMessages.find((m) => m.type === 'UNDO_RESULT');
  assert.ok(successResult, 'UNDO_RESULT must be sent');
  assert.strictEqual(successResult.success, true);
  assert.strictEqual(successResult.truncatedAfterId, 'msg-u1');

  // Verify msg-u1 is also removed after successful restore
  history = await historyStore.loadHistory();
  assert.strictEqual(history.length, 0, 'historyStore must now be completely empty as the undone message is removed');
});

test('ScopedRestore: deletes newly created files that did not exist in the checkpoint commit while preserving other files', async () => {
  const os = await import('os');
  const fs = await import('fs');
  const path = await import('path');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-restore-newfile-test-'));
  try {
    const aiCreatedFile = 'ai_created.md';
    const userFile = 'user_created.md';

    const aiCreatedFullPath = path.join(tempDir, aiCreatedFile);
    const userFullPath = path.join(tempDir, userFile);

    fs.writeFileSync(aiCreatedFullPath, 'AI generated content');
    fs.writeFileSync(userFullPath, 'User original content');

    const mockRepo = new MockShadowRepo();
    mockRepo.workTree = tempDir;

    // Simulate real git checkout: fails when trying to checkout a file that never existed in commit
    mockRepo.runGit = async (args: string[]) => {
      mockRepo.executedCommands.push(args);
      if (args[0] === 'checkout') {
        const file = args[args.length - 1];
        if (file === aiCreatedFile || args.includes(aiCreatedFile) || args.some((a) => a.includes(aiCreatedFile))) {
          throw new Error(`error: pathspec '${aiCreatedFile}' did not match any file(s) known to git`);
        }
      }
      return { stdout: '', stderr: '' };
    };

    const restore = new ScopedRestore(mockRepo as any);
    const result = await restore.restore('cp-initial', [aiCreatedFile], true);

    assert.strictEqual(result.success, true, 'Restore must succeed when deleting newly created file');
    assert.strictEqual(fs.existsSync(aiCreatedFullPath), false, 'Newly created file must be deleted from disk on undo');
    assert.strictEqual(fs.existsSync(userFullPath), true, 'User file must remain completely untouched on disk');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ScopedRestore: restores pre-existing file with case mismatch (e.g. docs/future.md vs Docs/future.md) and does NOT delete it', async () => {
  const os = await import('os');
  const fs = await import('fs');
  const path = await import('path');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-restore-casemismatch-test-'));
  try {
    const gitKnownPath = 'Docs/future.md';
    const requestedPath = 'docs/future.md';

    const fullDiskPath = path.join(tempDir, 'Docs', 'future.md');
    fs.mkdirSync(path.dirname(fullDiskPath), { recursive: true });
    fs.writeFileSync(fullDiskPath, 'Pre-edit file content');

    const mockRepo = new MockShadowRepo();
    mockRepo.workTree = tempDir;

    // Simulate Git: exact 'docs/future.md' fails pathspec match, but case-insensitive ':(icase)docs/future.md' succeeds!
    mockRepo.runGit = async (args: string[]) => {
      mockRepo.executedCommands.push(args);
      if (args[0] === 'checkout') {
        const file = args[args.length - 1];
        if (file.includes(':(icase)')) {
          // Case-insensitive checkout succeeds!
          return { stdout: '', stderr: '' };
        }
        if (file === requestedPath || args.includes(requestedPath)) {
          throw new Error(`error: pathspec '${requestedPath}' did not match any file(s) known to git`);
        }
      }
      return { stdout: '', stderr: '' };
    };

    const restore = new ScopedRestore(mockRepo as any);
    const result = await restore.restore('cp-case-test', [requestedPath], true);

    assert.strictEqual(result.success, true, 'Restore must succeed using case-insensitive fallback');
    assert.strictEqual(fs.existsSync(fullDiskPath), true, 'Pre-existing file must NEVER be deleted on undo');

    // Verify case-insensitive checkout command was executed
    const ranIcaseCheckout = mockRepo.executedCommands.some(
      (cmd) => cmd[0] === 'checkout' && cmd.some((arg) => arg.includes(':(icase)'))
    );
    assert.strictEqual(ranIcaseCheckout, true, 'Case-insensitive checkout must be attempted when exact checkout fails');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Multi-turn undo with case-mismatch preserves preceding turn edits and does not revert to initial state', async () => {
  const os = await import('os');
  const fs = await import('fs');
  const path = await import('path');
  const { CheckpointManager } = await import('../src/shadowGit/checkpoint');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-multiturn-test-'));
  try {
    const requestedPath = 'docs/future.md';
    const fullDiskPath = path.join(tempDir, 'Docs', 'future.md');
    fs.mkdirSync(path.dirname(fullDiskPath), { recursive: true });

    // Initial content before Turn 1
    fs.writeFileSync(fullDiskPath, 'ORIGINAL_CONTENT\n');

    let stagedFiles: string[] = [];
    let commits: Array<{ id: string; content: string }> = [
      { id: 'commit-initial', content: 'ORIGINAL_CONTENT\n' },
    ];

    const mockRepo = new MockShadowRepo();
    mockRepo.workTree = tempDir;
    mockRepo.runGit = async (args: string[]) => {
      mockRepo.executedCommands.push(args);
      if (args[0] === 'add') {
        const fileArg = args[args.length - 1];
        if (fileArg.includes(':(icase)')) {
          stagedFiles.push(fileArg);
        }
      } else if (args[0] === 'commit') {
        const newCommitId = `commit-turn-${commits.length}`;
        const currentContent = fs.readFileSync(fullDiskPath, 'utf8');
        commits.push({ id: newCommitId, content: stagedFiles.length > 0 ? currentContent : commits[commits.length - 1].content });
        stagedFiles = [];
        return { stdout: '', stderr: '' };
      } else if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: commits[commits.length - 1].id, stderr: '' };
      } else if (args[0] === 'checkout') {
        const commitId = args[1];
        const match = commits.find((c) => c.id === commitId);
        if (match) {
          fs.writeFileSync(fullDiskPath, match.content);
        }
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const checkpointMgr = new CheckpointManager(mockRepo as any);
    const restore = new ScopedRestore(mockRepo as any);

    // Turn 1 applies edit: adds requirement
    fs.writeFileSync(fullDiskPath, 'ORIGINAL_CONTENT\n+ REQUIREMENT_A_ADDED\n');

    // Turn 2 begins: checkpoint created before Turn 2 edit
    const cpTurn2 = await checkpointMgr.createCheckpoint([requestedPath], 'Before Turn 2 edit');
    assert.ok(cpTurn2, 'Checkpoint before Turn 2 must be created');

    // Turn 2 applies edit: removes requirement A
    fs.writeFileSync(fullDiskPath, 'ORIGINAL_CONTENT\n');

    // User triggers Undo on Turn 2
    const undoRes = await restore.restore(cpTurn2!, [requestedPath], true);
    assert.strictEqual(undoRes.success, true, 'Turn 2 undo must succeed');

    // The restored file MUST have Turn 1's content (+ REQUIREMENT_A_ADDED), NOT the original content
    const finalContent = fs.readFileSync(fullDiskPath, 'utf8');
    assert.ok(
      finalContent.includes('+ REQUIREMENT_A_ADDED'),
      'Turn 2 undo must restore Turn 1 state, preserving added requirements rather than wiping to initial state'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('UNDO_TURN: successfully undoes a turn when stream was stopped mid-flight (0 subsequent messages in history)', async () => {
  const memoryFiles: Map<string, Uint8Array> = new Map();
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

  const storageUri = vscode.Uri.file('C:/mock/storage-undo-zero-subsequent');
  const historyStore = new HistoryStore(storageUri as any);
  await historyStore.loadSessions();

  // Turn was submitted by user, but aborted/stopped before assistant replied:
  await historyStore.appendMessage({
    id: 'msg-u-stopped',
    role: 'user',
    content: 'User prompt that got stopped mid flight',
    timestamp: 2000,
    checkpointId: 'cp-stopped',
    affectedFiles: ['src/stopped.ts'],
  });

  let history = await historyStore.loadHistory();
  assert.strictEqual(history.length, 1);

  let onMessageListener: ((data: WebviewToHostMessage) => Promise<void>) | undefined;
  const postedMessages: HostToWebviewMessage[] = [];

  const mockWebview: any = {
    options: {},
    html: '',
    asWebviewUri: (uri: any) => uri,
    cspSource: 'mock-csp',
    onDidReceiveMessage: (listener: any) => {
      onMessageListener = listener;
    },
    postMessage: (msg: any) => {
      postedMessages.push(msg);
    },
  };

  const dummySecretStore: any = { getApiKey: async () => 'key' };
  const dummyPermissionManager: any = {};
  const dummyUsageStore: any = {};
  const extensionUri = vscode.Uri.file('C:/mock/extension');

  const provider = new OpenRouterPanelProvider(
    extensionUri as any,
    dummySecretStore,
    historyStore,
    dummyPermissionManager,
    dummyUsageStore,
    storageUri as any
  );

  provider.resolveWebviewView({ webview: mockWebview } as any, {} as any, {} as any);

  let restoredFiles: string[] = [];
  (provider as any)._scopedRestore = {
    restore: async (_checkpointId: string, files: string[]) => {
      restoredFiles = files;
      return { success: true };
    },
  };
  (provider as any)._checkpointManager = {
    createCheckpoint: async () => 'cp-mock',
  };
  (provider as any)._shadowRepo = {
    runGit: async () => ({ stdout: '', stderr: '' }),
  };

  (vscode.window as any).showWarningMessage = async (msg: string) => {
    assert.ok(msg.includes('This will undo this change and remove'));
    return 'Continue';
  };

  await onMessageListener!({
    type: 'UNDO_TURN',
    messageId: 'msg-u-stopped',
    checkpointId: '',
    affectedFiles: [],
  });

  const undoResult = postedMessages.find((m) => m.type === 'UNDO_RESULT');
  assert.ok(undoResult, 'UNDO_RESULT must be posted');
  assert.strictEqual(undoResult.success, true);
  assert.strictEqual(undoResult.truncatedAfterId, 'msg-u-stopped');
  assert.deepStrictEqual(restoredFiles, ['src/stopped.ts'], 'Target message affectedFiles resolved from historyStore');

  // HistoryStore must now be completely empty
  history = await historyStore.loadHistory();
  assert.strictEqual(history.length, 0, 'Target message removed from historyStore so model context is completely wiped');
});

