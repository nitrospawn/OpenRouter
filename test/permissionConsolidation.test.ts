import test from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';
import { PermissionManager } from '../src/permissions/permissionManager';
import { CommandRunner } from '../src/terminal/commandRunner';
import { DiffPreviewManager } from '../src/editor/diffPreview';
import { DiagnosticManager } from '../src/diagnostics/diagnosticManager';
import { ContextReader } from '../src/editor/contextReader';
import { OpenRouterPanelProvider } from '../src/webview/panelProvider';
import { WebviewToHostMessage, HostToWebviewMessage } from '../src/webview/messages';
import { buildSystemPrompt } from '../src/prompt/systemPrompt';

class MockMemento {
  private data: Map<string, any> = new Map();
  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
  }
  public async update(key: string, value: any): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }
  public keys(): readonly string[] {
    return Array.from(this.data.keys());
  }
}

function createMockContext(): any {
  return {
    workspaceState: new MockMemento(),
    globalState: new MockMemento(),
  };
}

test('PermissionManager: command and cwd normalization handles whitespace, CRLF, prompt sigils, and quotes', () => {
  // 1. Whitespace, CRLF, prompt sigils
  assert.strictEqual(PermissionManager.normalizeCommand('  npm test  '), 'npm test');
  assert.strictEqual(PermissionManager.normalizeCommand('npm test\r\n'), 'npm test');
  assert.strictEqual(PermissionManager.normalizeCommand('$ npm test'), 'npm test');
  assert.strictEqual(PermissionManager.normalizeCommand('#  npm test --coverage'), 'npm test --coverage');
  assert.strictEqual(PermissionManager.normalizeCommand('npm   test   --flag'), 'npm test --flag');

  // 2. Preserves spaces inside quotes
  const quotedCmd = 'echo "hello    world" --msg \'foo   bar\'';
  assert.strictEqual(PermissionManager.normalizeCommand(quotedCmd), 'echo "hello    world" --msg \'foo   bar\'');

  // 3. Multi-line command normalization
  const multiLine = '  npm install \r\n\r\n   npm test  \r\n';
  assert.strictEqual(PermissionManager.normalizeCommand(multiLine), 'npm install\nnpm test');

  // 4. CWD normalization
  assert.strictEqual(PermissionManager.normalizeCwd('C:\\Users\\Project\\App\\'), 'c:/users/project/app');
  assert.strictEqual(PermissionManager.normalizeCwd('/home/user/project///'), '/home/user/project');
});

test('PermissionManager: exact command approval persists in workspaceState and survives new instance', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  const cwd = 'C:/mock/workspace';

  assert.strictEqual(manager.isExactCommandAllowed('npm test', cwd), false);

  await manager.allowExactCommand('npm test', cwd);
  assert.strictEqual(manager.isExactCommandAllowed('npm test', cwd), true);
  // Matches normalized variations
  assert.strictEqual(manager.isExactCommandAllowed('  npm   test \r\n', cwd), true);
  assert.strictEqual(manager.isExactCommandAllowed('$ npm test', cwd), true);

  // Survives fresh PermissionManager reading the same workspaceState
  const manager2 = new PermissionManager(context);
  assert.strictEqual(manager2.isExactCommandAllowed('npm test', cwd), true);

  // resetAll clears exact commands as well as permissions
  manager.resetAll();
  assert.strictEqual(manager.isExactCommandAllowed('npm test', cwd), false);
  assert.strictEqual(manager2.isExactCommandAllowed('npm test', cwd), false);
});

test('Trigger Path 1 & 6 (Fresh message / Inline terminal command): respects runTerminalCommand = allow without confirmation dialog', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  // Set category to allow
  await manager.setPermission('runTerminalCommand', 'allow');

  const originalShowWarning = vscode.window.showWarningMessage;
  let dialogShown = false;
  (vscode.window as any).showWarningMessage = async () => {
    dialogShown = true;
    return 'Deny';
  };

  try {
    const res = await CommandRunner.executeCommand('npm test', manager);
    assert.strictEqual(dialogShown, false, 'Confirmation dialog must NOT be shown when permission is allow');
    assert.strictEqual(res.executed, true);
    assert.strictEqual(res.cancelled, false);
  } finally {
    (vscode.window as any).showWarningMessage = originalShowWarning;
  }
});

test('Trigger Path 2 (Undo auto-fill and resend): skips confirmation dialog for pre-approved exact command', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  const cwd = 'C:/mock/workspace';

  // Step 1: Pre-approve command on turn 1 via "Always Allow This Exact Command"
  await manager.allowExactCommand('npm run build', cwd);

  // Step 2: User undoes turn, message is resent, AI returns command with formatting variance
  const reconstructedCmd = '  $ npm   run build \r\n';

  const originalShowWarning = vscode.window.showWarningMessage;
  let dialogShown = false;
  (vscode.window as any).showWarningMessage = async () => {
    dialogShown = true;
    return 'Deny';
  };

  try {
    const res = await CommandRunner.executeCommand(reconstructedCmd, manager);
    assert.strictEqual(dialogShown, false, 'Pre-approved command reconstructed after undo must skip confirmation');
    assert.strictEqual(res.executed, true);
  } finally {
    (vscode.window as any).showWarningMessage = originalShowWarning;
  }
});

test('CWD Context Sensitivity: approve command in directory A, cd to directory B in same terminal -> must prompt again', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  const dirA = 'C:/mock/workspace/dirA';
  const dirB = 'C:/mock/workspace/dirB';

  // Create an active terminal in window.terminals with shellIntegration cwd = dirA
  const mockTerminal: any = {
    name: 'OpenRouter Terminal',
    show: () => {},
    sendText: (_cmd: string) => {},
    shellIntegration: {
      cwd: { fsPath: dirA },
      executeCommand: (_cmd: string) => ({ read: async function* () {} }),
    },
  };
  (vscode.window.terminals as any[]) = [mockTerminal];

  const originalShowWarning = vscode.window.showWarningMessage;
  let dialogCount = 0;
  let lastDialogAction: string = 'Always Allow This Exact Command';

  (vscode.window as any).showWarningMessage = async (msg: string, ..._rest: any[]) => {
    dialogCount++;
    assert.ok(msg.includes('npm test'));
    return lastDialogAction;
  };

  try {
    // 1. First execution in dirA -> prompts user, user picks "Always Allow This Exact Command"
    lastDialogAction = 'Always Allow This Exact Command';
    const res1 = await CommandRunner.executeCommand('npm test', manager);
    assert.strictEqual(dialogCount, 1, 'First execution in dirA must prompt');
    assert.strictEqual(res1.executed, true);

    // 2. Re-run in dirA -> skips confirmation dialog
    const res2 = await CommandRunner.executeCommand('npm test', manager);
    assert.strictEqual(dialogCount, 1, 'Re-run in dirA must NOT prompt again');
    assert.strictEqual(res2.executed, true);

    // 3. User cd's to dirB in the same terminal session
    mockTerminal.shellIntegration.cwd = { fsPath: dirB };

    // 4. Attempt the same command again in dirB -> MUST prompt again, not silently reuse dirA approval
    lastDialogAction = 'Deny';
    const res3 = await CommandRunner.executeCommand('npm test', manager);
    assert.strictEqual(dialogCount, 2, 'Execution in dirB MUST prompt again even if approved in dirA');
    assert.strictEqual(res3.executed, false, 'Command must be cancelled when user denies prompt in dirB');
    assert.strictEqual(res3.cancelled, true);
  } finally {
    (vscode.window as any).showWarningMessage = originalShowWarning;
    (vscode.window.terminals as any[]) = [];
  }
});

test('Trigger Path 3 & 4 (Apply Edit & Apply All): allow state skips dialog, allow_session persists for current session', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  // Step 1: Default is 'ask'. When user selects 'Allow for this Session'
  const originalShowWarning = vscode.window.showWarningMessage;
  let dialogCount = 0;
  (vscode.window as any).showWarningMessage = async () => {
    dialogCount++;
    return 'Allow for this Session';
  };

  try {
    // First edit prompts and sets allow_session
    const status1 = await manager.checkApplyEditPermission('src/app.ts', false);
    assert.strictEqual(status1, 'allowed');
    assert.strictEqual(dialogCount, 1);
    assert.strictEqual(manager.getPermission('applyEdit'), 'allow_session');

    // Second edit in same session skips dialog
    const status2 = await manager.checkApplyEditPermission('src/routes.ts', false);
    assert.strictEqual(status2, 'allowed');
    assert.strictEqual(dialogCount, 1, 'Subsequent edit in allow_session must skip dialog');

    // Confirm allow_session persists in-memory only without polluting workspaceState
    const manager2 = new PermissionManager(context);
    assert.strictEqual(manager2.getPermission('applyEdit'), 'ask', 'New manager/window session must revert to ask');
  } finally {
    (vscode.window as any).showWarningMessage = originalShowWarning;
  }
});

test('Trigger Path 5 (File Creation vs Apply Edit): createDeleteFiles = deny blocks creating new files', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  // Even if applyEdit is 'allow'
  await manager.setPermission('applyEdit', 'allow');
  // If createDeleteFiles is 'deny'
  await manager.setPermission('createDeleteFiles', 'deny');

  // Applying edit to existing file succeeds
  const existingStatus = await manager.checkApplyEditPermission('src/existing.ts', false);
  assert.strictEqual(existingStatus, 'allowed');

  // Creating new file is blocked
  const newStatus = await manager.checkApplyEditPermission('src/newFile.ts', true);
  assert.strictEqual(newStatus, 'denied');
});

test('Trigger Path 7 (Automated verification test command): skips dialog when permission is allow', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('runTerminalCommand', 'allow');

  const res = await CommandRunner.executeCommand('pytest -v', manager);
  assert.strictEqual(res.executed, true);
  assert.strictEqual(res.cancelled, false);
});

test('Trigger Path 8, 9, 10 (Diagnostics QuickFix and Token Expansion): respects read permissions', () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  assert.strictEqual(manager.checkReadContextPermission('readActiveContext'), true);
  assert.strictEqual(manager.checkReadContextPermission('readWorkspaceFiles'), true);

  // Deny readActiveContext
  manager.setPermission('readActiveContext', 'deny');
  assert.strictEqual(manager.checkReadContextPermission('readActiveContext'), false);
  assert.strictEqual(DiagnosticManager.getCurrentFileDiagnostics(manager).length, 0);
  assert.strictEqual(ContextReader.getActiveEditorContext(manager).hasContext, false);

  // Deny readWorkspaceFiles
  manager.setPermission('readWorkspaceFiles', 'deny');
  assert.strictEqual(manager.checkReadContextPermission('readWorkspaceFiles'), false);
  assert.strictEqual(DiagnosticManager.getAllWorkspaceDiagnostics(manager).length, 0);
});

function setupProviderForTesting(permissionManager: PermissionManager) {
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
  const mockWebviewView: any = { webview: mockWebview };

  const dummySecretStore: any = { getApiKey: async () => 'key' };
  const dummyHistoryStore: any = {
    loadHistory: async () => [],
    tagTurnCheckpoint: async () => {},
    appendMessage: async (msg: any) => msg,
  };
  const dummyUsageStore: any = { appendRecord: async () => {} };
  const extensionUri = vscode.Uri.file('C:/mock/extension');
  const storageUri = vscode.Uri.file('C:/mock/storage');

  const provider = new OpenRouterPanelProvider(
    extensionUri as any,
    dummySecretStore,
    dummyHistoryStore,
    permissionManager,
    dummyUsageStore,
    storageUri as any
  );

  const checkpointCalls: { files: string[]; message: string }[] = [];
  (provider as any)._checkpointManager = {
    createCheckpoint: async (files: string[], message: string) => {
      checkpointCalls.push({ files, message });
      return 'cp-' + Date.now();
    },
  };

  provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);

  return {
    provider,
    postedMessages,
    checkpointCalls,
    sendMessage: async (data: WebviewToHostMessage) => {
      assert.ok(onMessageListener, 'onMessageListener must be registered');
      await onMessageListener(data);
    },
    handleAutoExecution: async (content: string) => {
      await (provider as any)._handleAutoExecution(content);
    },
  };
}

test('UI Trigger Pipeline: ACCEPT_EDIT with applyEdit = allow skips confirmation dialog and applies edit', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('applyEdit', 'allow');

  const originalWarning = vscode.window.showWarningMessage;
  let dialogShown = false;
  (vscode.window as any).showWarningMessage = async () => {
    dialogShown = true;
    return 'Deny';
  };

  try {
    const harness = setupProviderForTesting(manager);
    await harness.sendMessage({
      type: 'ACCEPT_EDIT',
      editId: 'edit-allow-1',
      filePath: 'src/file1.ts',
      newContent: 'const a = 1;',
    });

    assert.strictEqual(dialogShown, false, 'Dialog must NOT be shown when applyEdit is allow');
    assert.strictEqual(harness.checkpointCalls.length, 1, 'Checkpoint must be created before edit application');
    const appliedMsg = harness.postedMessages.find((m: any) => m.type === 'EDIT_APPLIED') as any;
    assert.ok(appliedMsg, 'EDIT_APPLIED message must be posted back to webview');
    assert.strictEqual(appliedMsg.editId, 'edit-allow-1');
    assert.strictEqual(appliedMsg.success, true);
  } finally {
    (vscode.window as any).showWarningMessage = originalWarning;
  }
});

test('UI Trigger Pipeline: ACCEPT_EDIT with applyEdit = deny refuses immediately without dialog or checkpoint', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('applyEdit', 'deny');

  const originalWarning = vscode.window.showWarningMessage;
  const originalError = vscode.window.showErrorMessage;
  let dialogShown = false;
  let errorMessageShown = false;

  (vscode.window as any).showWarningMessage = async () => {
    dialogShown = true;
    return 'Deny';
  };
  (vscode.window as any).showErrorMessage = async (msg: string) => {
    errorMessageShown = true;
  };

  try {
    const harness = setupProviderForTesting(manager);
    await harness.sendMessage({
      type: 'ACCEPT_EDIT',
      editId: 'edit-deny-1',
      filePath: 'src/file2.ts',
      newContent: 'const b = 2;',
    });

    assert.strictEqual(dialogShown, false, 'Dialog must NOT be shown when applyEdit is deny');
    assert.strictEqual(harness.checkpointCalls.length, 0, 'No checkpoint must be created when edit is denied');
    assert.strictEqual(errorMessageShown, true, 'Error notification must explain edit was denied by permissions');
    const appliedMsg = harness.postedMessages.find((m: any) => m.type === 'EDIT_APPLIED') as any;
    assert.ok(appliedMsg, 'EDIT_APPLIED message must be posted back to webview');
    assert.strictEqual(appliedMsg.editId, 'edit-deny-1');
    assert.strictEqual(appliedMsg.success, false);
  } finally {
    (vscode.window as any).showWarningMessage = originalWarning;
    (vscode.window as any).showErrorMessage = originalError;
  }
});

test('UI Trigger Pipeline: ACCEPT_EDIT with applyEdit = ask displays dialog and respects user choice', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  // Default is 'ask'

  const originalWarning = vscode.window.showWarningMessage;

  try {
    // 1. User denies
    let dialogCount = 0;
    (vscode.window as any).showWarningMessage = async () => {
      dialogCount++;
      return 'Deny';
    };

    const harness1 = setupProviderForTesting(manager);
    await harness1.sendMessage({
      type: 'ACCEPT_EDIT',
      editId: 'edit-ask-deny',
      filePath: 'src/file3.ts',
      newContent: 'const c = 3;',
    });

    assert.strictEqual(dialogCount, 1, 'Confirmation dialog must be shown when applyEdit is ask');
    assert.strictEqual(harness1.checkpointCalls.length, 0, 'No checkpoint when user clicks Deny');
    const msgDeny = harness1.postedMessages.find((m: any) => m.type === 'EDIT_APPLIED') as any;
    assert.strictEqual(msgDeny.success, false);

    // 2. User allows once
    (vscode.window as any).showWarningMessage = async () => {
      dialogCount++;
      return 'Allow Once';
    };

    const harness2 = setupProviderForTesting(manager);
    await harness2.sendMessage({
      type: 'ACCEPT_EDIT',
      editId: 'edit-ask-allow',
      filePath: 'src/file3.ts',
      newContent: 'const c = 3;',
    });

    assert.strictEqual(dialogCount, 2, 'Confirmation dialog must prompt again for next edit');
    assert.strictEqual(harness2.checkpointCalls.length, 1, 'Checkpoint created when user approves');
    const msgAllow = harness2.postedMessages.find((m: any) => m.type === 'EDIT_APPLIED') as any;
    assert.strictEqual(msgAllow.success, true);
  } finally {
    (vscode.window as any).showWarningMessage = originalWarning;
  }
});

test('UI Trigger Pipeline: ACCEPT_ALL_EDITS with applyEdit = deny refuses upfront with no checkpoint or dialog', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('applyEdit', 'deny');

  const originalWarning = vscode.window.showWarningMessage;
  let dialogShown = false;
  (vscode.window as any).showWarningMessage = async () => {
    dialogShown = true;
    return 'Deny';
  };

  try {
    const harness = setupProviderForTesting(manager);
    await harness.sendMessage({
      type: 'ACCEPT_ALL_EDITS',
      edits: [
        { editId: 'bulk-1', filePath: 'src/a.ts', newContent: '1' },
        { editId: 'bulk-2', filePath: 'src/b.ts', newContent: '2' },
      ],
    });

    assert.strictEqual(dialogShown, false, 'No dialog must be shown for denied bulk edit');
    assert.strictEqual(harness.checkpointCalls.length, 0, 'No checkpoint created for denied bulk edit');
    const appliedMsgs = harness.postedMessages.filter((m: any) => m.type === 'EDIT_APPLIED') as any[];
    assert.strictEqual(appliedMsgs.length, 2);
    assert.ok(appliedMsgs.every((m) => m.success === false));
  } finally {
    (vscode.window as any).showWarningMessage = originalWarning;
  }
});

test('UI Trigger Pipeline: ACCEPT_ALL_EDITS with applyEdit = allow applies all with single checkpoint and no dialog', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('applyEdit', 'allow');

  const originalWarning = vscode.window.showWarningMessage;
  let dialogShown = false;
  (vscode.window as any).showWarningMessage = async () => {
    dialogShown = true;
    return 'Deny';
  };

  try {
    const harness = setupProviderForTesting(manager);
    await harness.sendMessage({
      type: 'ACCEPT_ALL_EDITS',
      edits: [
        { editId: 'bulk-1', filePath: 'src/a.ts', newContent: '1' },
        { editId: 'bulk-2', filePath: 'src/b.ts', newContent: '2' },
      ],
    });

    assert.strictEqual(dialogShown, false, 'No dialog when applyEdit is allow');
    assert.strictEqual(harness.checkpointCalls.length, 1, 'Single unified checkpoint must be created');
    assert.strictEqual(harness.checkpointCalls[0].files.length, 2);
    const appliedMsgs = harness.postedMessages.filter((m: any) => m.type === 'EDIT_APPLIED') as any[];
    assert.strictEqual(appliedMsgs.length, 2);
    assert.ok(appliedMsgs.every((m) => m.success === true));
  } finally {
    (vscode.window as any).showWarningMessage = originalWarning;
  }
});

test('UI Trigger Pipeline: ACCEPT_ALL_EDITS with applyEdit = ask prompts ONCE for the entire batch', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  const originalWarning = vscode.window.showWarningMessage;
  let dialogCount = 0;
  (vscode.window as any).showWarningMessage = async () => {
    dialogCount++;
    return 'Apply All';
  };

  try {
    const harness = setupProviderForTesting(manager);
    await harness.sendMessage({
      type: 'ACCEPT_ALL_EDITS',
      edits: [
        { editId: 'bulk-1', filePath: 'src/a.ts', newContent: '1' },
        { editId: 'bulk-2', filePath: 'src/b.ts', newContent: '2' },
        { editId: 'bulk-3', filePath: 'src/c.ts', newContent: '3' },
      ],
    });

    assert.strictEqual(dialogCount, 1, 'Bulk edit must prompt user exactly ONCE, not per file');
    assert.strictEqual(harness.checkpointCalls.length, 1, 'Single unified checkpoint created');
    const appliedMsgs = harness.postedMessages.filter((m: any) => m.type === 'EDIT_APPLIED') as any[];
    assert.strictEqual(appliedMsgs.length, 3);
    assert.ok(appliedMsgs.every((m) => m.success === true));
  } finally {
    (vscode.window as any).showWarningMessage = originalWarning;
  }
});

test('Session Override Lifecycle: setPermission clearing session override immediately updates UI trigger behavior', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  // 1. Session override is set to allow_session
  await manager.setPermission('applyEdit', 'allow_session');
  assert.strictEqual(manager.getPermission('applyEdit'), 'allow_session');

  // 2. User changes setting in settings UI to 'deny'
  await manager.setPermission('applyEdit', 'deny');
  assert.strictEqual(manager.getPermission('applyEdit'), 'deny', 'setPermission must clear preceding allow_session');

  // 3. UI trigger message must now deny immediately without dialog or checkpoint
  const originalWarning = vscode.window.showWarningMessage;
  let dialogShown = false;
  (vscode.window as any).showWarningMessage = async () => {
    dialogShown = true;
    return 'Allow Once';
  };

  try {
    const harness = setupProviderForTesting(manager);
    await harness.sendMessage({
      type: 'ACCEPT_EDIT',
      editId: 'override-cleared-test',
      filePath: 'src/override.ts',
      newContent: 'const x = 99;',
    });

    assert.strictEqual(dialogShown, false, 'Dialog must NOT be shown after setting changed to deny');
    assert.strictEqual(harness.checkpointCalls.length, 0, 'No checkpoint when denied');
    const appliedMsg = harness.postedMessages.find((m: any) => m.type === 'EDIT_APPLIED') as any;
    assert.strictEqual(appliedMsg.success, false);
  } finally {
    (vscode.window as any).showWarningMessage = originalWarning;
  }
});

test('PRD §4.1 Defaults: Fresh workspace initializes with updated default permission states', () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  assert.strictEqual(manager.getPermission('readActiveContext'), 'allow', 'readActiveContext must default to allow');
  assert.strictEqual(manager.getPermission('applyEdit'), 'ask', 'applyEdit must default to ask');
  assert.strictEqual(manager.getPermission('runTerminalCommand'), 'ask', 'runTerminalCommand must default to ask');
  assert.strictEqual(manager.getPermission('readWorkspaceFiles'), 'allow', 'readWorkspaceFiles must default to allow');
});

test('PRD §4.1 Persistence: User-configured permission states persist and are never silently reset to defaults', async () => {
  const context = createMockContext();
  const manager1 = new PermissionManager(context);

  await manager1.setPermission('readWorkspaceFiles', 'deny');
  await manager1.setPermission('applyEdit', 'allow');

  const manager2 = new PermissionManager(context);
  assert.strictEqual(manager2.getPermission('readWorkspaceFiles'), 'deny');
  assert.strictEqual(manager2.getPermission('applyEdit'), 'allow');
});

test('Allow = Zero Manual Interaction: applyEdit = allow automatically applies edit, checkpoints, and posts chat summary', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('applyEdit', 'allow');

  const harness = setupProviderForTesting(manager);
  await harness.handleAutoExecution('```edit_file:src/auth.ts\nconst token = "secure";\n```');

  // Checkpoint created
  assert.strictEqual(harness.checkpointCalls.length, 1);
  assert.strictEqual(harness.checkpointCalls[0].files[0], 'src/auth.ts');

  // Summary message posted to chat
  const summaryMsg = harness.postedMessages.find(
    (m: any) => m.type === 'MESSAGE_RECEIVED' && m.message.content.includes('Applied')
  ) as any;
  assert.ok(summaryMsg, 'Chat summary message must be posted');
  assert.ok(summaryMsg.message.content.includes('auth.ts'));

  // EDIT_APPLIED posted with success: true
  const appliedMsg = harness.postedMessages.find((m: any) => m.type === 'EDIT_APPLIED') as any;
  assert.ok(appliedMsg);
  assert.strictEqual(appliedMsg.success, true);
});

test('Allow = Zero Manual Interaction: runTerminalCommand = allow automatically runs command and posts chat summary', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('runTerminalCommand', 'allow');

  const originalWarning = vscode.window.showWarningMessage;
  let dialogShown = false;
  (vscode.window as any).showWarningMessage = async () => {
    dialogShown = true;
    return 'Deny';
  };

  try {
    const harness = setupProviderForTesting(manager);
    await harness.handleAutoExecution('```bash\nnpm run build\n```');

    assert.strictEqual(dialogShown, false, 'No dialog must be shown when runTerminalCommand is allow');

    const summaryMsg = harness.postedMessages.find(
      (m: any) => m.type === 'MESSAGE_RECEIVED' && m.message.content.includes('Ran in terminal')
    ) as any;
    assert.ok(summaryMsg, 'Chat summary message must be posted for executed command');
    assert.ok(summaryMsg.message.content.includes('npm run build'));
  } finally {
    (vscode.window as any).showWarningMessage = originalWarning;
  }
});

test('Ask Mode: does NOT auto-apply edits or auto-run terminal commands', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  // Default is 'ask' for both

  const harness = setupProviderForTesting(manager);
  await harness.handleAutoExecution('```edit_file:src/manual.ts\nconst x = 1;\n```\n```bash\npytest\n```');

  assert.strictEqual(harness.checkpointCalls.length, 0, 'No checkpoints under Ask mode');
  const autoApplied = harness.postedMessages.filter((m: any) => m.type === 'EDIT_APPLIED');
  assert.strictEqual(autoApplied.length, 0, 'No automatic edit application under Ask mode');
  const chatMsgs = harness.postedMessages.filter((m: any) => m.type === 'MESSAGE_RECEIVED');
  assert.strictEqual(chatMsgs.length, 0, 'No auto-execution chat summaries under Ask mode');
});

test('Allow Safety: malformed SEARCH/REPLACE block fails safely with error in chat and no file wiped', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('applyEdit', 'allow');

  const harness = setupProviderForTesting(manager);
  // Malformed SEARCH block with missing exact match or invalid block
  await harness.handleAutoExecution('```edit_file:src/broken.ts\n<<<< SEARCH\nnonexistent target content in empty file\n====\nreplacement\n>>>>\n```');

  const errorMsg = harness.postedMessages.find(
    (m: any) => m.type === 'MESSAGE_RECEIVED' && m.message.content.includes('Failed to auto-apply edit')
  ) as any;
  assert.ok(errorMsg, 'Error message must be posted to chat explaining edit failure');
  const appliedMsg = harness.postedMessages.find((m: any) => m.type === 'EDIT_APPLIED') as any;
  assert.ok(appliedMsg);
  assert.strictEqual(appliedMsg.success, false, 'EDIT_APPLIED must report failure safely');
});

test('Live Mid-Session Updates: loosening from ask to allow immediately affects next action without reload', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  const harness = setupProviderForTesting(manager);

  // Turn 1: applyEdit is 'ask' -> does NOT auto-apply
  await harness.handleAutoExecution('```edit_file:src/turn1.ts\nconst t1 = 1;\n```');
  assert.strictEqual(harness.checkpointCalls.length, 0);

  // Mid-session update: user changes applyEdit to 'allow'
  // (TOGGLE_PERMISSION cycles: allow -> ask -> deny -> allow)
  await harness.sendMessage({ type: 'TOGGLE_PERMISSION', category: 'applyEdit' }); // ask -> deny
  await harness.sendMessage({ type: 'TOGGLE_PERMISSION', category: 'applyEdit' }); // deny -> allow
  assert.strictEqual(manager.getPermission('applyEdit'), 'allow');

  // Verify SETTINGS_DATA was actively pushed to webview
  const settingsPushed = harness.postedMessages.filter((m: any) => m.type === 'SETTINGS_DATA').pop() as any;
  assert.ok(settingsPushed);
  assert.strictEqual(settingsPushed.permissions.applyEdit, 'allow');

  // Turn 2: in same active conversation, next action auto-applies immediately
  await harness.handleAutoExecution('```edit_file:src/turn2.ts\nconst t2 = 2;\n```');
  assert.strictEqual(harness.checkpointCalls.length, 1);
  assert.strictEqual(harness.checkpointCalls[0].files[0], 'src/turn2.ts');
});

test('Live Mid-Session Updates: tightening from allow to ask immediately pauses next action without reload', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('applyEdit', 'allow');
  const harness = setupProviderForTesting(manager);

  // Turn 1: under allow -> auto-applies
  await harness.handleAutoExecution('```edit_file:src/first.ts\nconst a = 1;\n```');
  assert.strictEqual(harness.checkpointCalls.length, 1);

  // Mid-session update: user changes applyEdit to 'ask'
  await harness.sendMessage({ type: 'TOGGLE_PERMISSION', category: 'applyEdit' });
  assert.strictEqual(manager.getPermission('applyEdit'), 'ask');

  // Turn 2: next action does NOT auto-apply
  await harness.handleAutoExecution('```edit_file:src/second.ts\nconst b = 2;\n```');
  assert.strictEqual(harness.checkpointCalls.length, 1, 'No new checkpoints created under tightened Ask setting');
});

test('Pending Edits Lifecycle on Mode Switch: already-pending edit remains pending and applies with zero dialog under Allow', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  // Initially 'ask'
  const harness = setupProviderForTesting(manager);

  // User changes applyEdit to 'allow' mid-session
  await manager.setPermission('applyEdit', 'allow');

  // When user clicks Apply on the pre-existing pending edit:
  const originalWarning = vscode.window.showWarningMessage;
  let dialogShown = false;
  (vscode.window as any).showWarningMessage = async () => {
    dialogShown = true;
    return 'Deny';
  };

  try {
    await harness.sendMessage({
      type: 'ACCEPT_EDIT',
      editId: 'pre-existing-edit',
      filePath: 'src/pending.ts',
      newContent: 'const resolved = true;',
    });

    assert.strictEqual(dialogShown, false, 'Pre-existing pending edit applies with 0 dialogs under newly set Allow state');
    assert.strictEqual(harness.checkpointCalls.length, 1);
    const appliedMsg = harness.postedMessages.find((m: any) => m.type === 'EDIT_APPLIED') as any;
    assert.strictEqual(appliedMsg.success, true);
  } finally {
    (vscode.window as any).showWarningMessage = originalWarning;
  }
});

test('Ambient Read Permissions: readActiveContext and readWorkspaceFiles have zero manual interaction under allow', () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  assert.strictEqual(manager.checkReadContextPermission('readActiveContext'), true);
  assert.strictEqual(manager.checkReadContextPermission('readWorkspaceFiles'), true);

  const originalActiveEditor = vscode.window.activeTextEditor;
  try {
    (vscode.window as any).activeTextEditor = {
      document: {
        uri: vscode.Uri.file('C:/mock/workspace/active.ts'),
        fileName: 'C:/mock/workspace/active.ts',
        languageId: 'typescript',
        getText: () => 'const active = true;',
      },
      selection: { isEmpty: true },
    };
    assert.strictEqual(ContextReader.getActiveEditorContext(manager).hasContext, true);
  } finally {
    (vscode.window as any).activeTextEditor = originalActiveEditor;
  }
});

test('Deny Mode: proposed edit under applyEdit = deny does not modify disk, creates no checkpoint, and visibly informs user that edit was not applied', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('applyEdit', 'deny');

  const harness = setupProviderForTesting(manager);
  const modelOutputClaimingSuccess = "Added the comment 'say my name' to ty.py:\n```edit_file:src/ty.py\n# say my name\n```\nLet me know if you need anything else!";

  await harness.handleAutoExecution(modelOutputClaimingSuccess);

  // 1. Assert no checkpoints created
  assert.strictEqual(harness.checkpointCalls.length, 0, 'No checkpoint must be created under Deny');

  // 2. Assert visible correction message posted to chat
  const correctionMsg = harness.postedMessages.find(
    (m: any) => m.type === 'MESSAGE_RECEIVED' && m.message.content.includes('This edit was not applied — Code edits permission is currently set to Denied.')
  ) as any;
  assert.ok(correctionMsg, 'Chat state must visibly post a clear message that the edit was NOT applied due to permissions');

  // 3. Assert EDIT_APPLIED posted with success: false
  const appliedMsg = harness.postedMessages.find((m: any) => m.type === 'EDIT_APPLIED') as any;
  assert.ok(appliedMsg, 'EDIT_APPLIED event must be posted');
  assert.strictEqual(appliedMsg.success, false, 'EDIT_APPLIED must report success: false');
});

test('Deny Mode: multiple proposed edits under applyEdit = deny post file-specific denial notices', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('applyEdit', 'deny');

  const harness = setupProviderForTesting(manager);
  const multiEditOutput = "```edit_file:src/auth.ts\nconst auth = true;\n```\n```edit_file:src/utils.ts\nconst util = true;\n```";

  await harness.handleAutoExecution(multiEditOutput);

  assert.strictEqual(harness.checkpointCalls.length, 0);

  const deniedMsgs = harness.postedMessages.filter(
    (m: any) => m.type === 'MESSAGE_RECEIVED' && m.message.content.includes('was not applied — Code edits permission is currently set to Denied.')
  );
  assert.strictEqual(deniedMsgs.length, 2, 'Must post denial notice for each proposed edit');
  assert.ok(deniedMsgs[0].message.content.includes('auth.ts'));
  assert.ok(deniedMsgs[1].message.content.includes('utils.ts'));

  const appliedMsgs = harness.postedMessages.filter((m: any) => m.type === 'EDIT_APPLIED');
  assert.strictEqual(appliedMsgs.length, 2);
  assert.strictEqual(appliedMsgs[0].success, false);
  assert.strictEqual(appliedMsgs[1].success, false);
});

test('Deny Mode: proposed terminal command under runTerminalCommand = deny does not execute and posts visible denial notice', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('runTerminalCommand', 'deny');

  const harness = setupProviderForTesting(manager);
  await harness.handleAutoExecution("I ran tests:\n```bash\nnpm test\n```");

  const deniedMsg = harness.postedMessages.find(
    (m: any) => m.type === 'MESSAGE_RECEIVED' && m.message.content.includes('Terminal command `npm test` was not executed — Terminal commands permission is currently set to Denied.')
  ) as any;
  assert.ok(deniedMsg, 'Must post visible denial notice for blocked terminal command');
});

test('System Prompt: informs model not to claim edits were applied when applyEdit is deny', () => {
  const prompt = buildSystemPrompt({
    permissions: { applyEdit: 'deny' },
  });

  assert.ok(prompt.includes('Permission Constraint: Code Edits are DENIED'));
  assert.ok(prompt.includes('NEVER assert, claim, or imply that you have modified, edited, or updated files on disk'));
});
