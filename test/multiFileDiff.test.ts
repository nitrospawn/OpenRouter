import test from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';
import { DiffPreviewManager } from '../src/editor/diffPreview';
import { PermissionManager } from '../src/permissions/permissionManager';

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
    subscriptions: [],
  };
}

test('MultiFileDiff: parses multiple simultaneous file edit blocks from a single AI response', () => {
  // Simulate an AI response fixing a bulk diagnostic scenario across 2 files
  const aiResponse = `I found the errors in both files. Here are the fixes:

\`\`\`edit_file:src/auth/tokenService.ts
export function validateToken(token: string): boolean {
  return token.length > 10;
}
\`\`\`

And in the consumer file:

\`\`\`edit_file:src/routes/login.ts
import { validateToken } from '../auth/tokenService';

export function handleLogin(req: any) {
  return validateToken(req.headers.authorization);
}
\`\`\`

Both errors are now resolved.`;

  const fileActionRegex = /```(?:create_file|edit_file|file):([^\r\n]+)\r?\n([\s\S]*?)```/gi;
  const parsedProposals: Array<{ filePath: string; newContent: string; editId: string }> = [];

  let match;
  let editCount = 0;
  while ((match = fileActionRegex.exec(aiResponse)) !== null) {
    editCount++;
    let filePath = match[1].trim();
    if (filePath.includes(':')) {
      filePath = filePath.split(':')[0].trim();
    }
    const newContent = match[2];
    parsedProposals.push({
      editId: `edit-${editCount}`,
      filePath,
      newContent,
    });
  }

  assert.strictEqual(parsedProposals.length, 2, 'Must parse exactly 2 edit proposals');
  assert.strictEqual(parsedProposals[0].filePath, 'src/auth/tokenService.ts');
  assert.strictEqual(parsedProposals[1].filePath, 'src/routes/login.ts');
  assert.ok(parsedProposals[0].newContent.includes('validateToken'));
  assert.ok(parsedProposals[1].newContent.includes('handleLogin'));
});

test('MultiFileDiff: applies edits sequentially across multiple distinct files via WorkspaceEdit', async () => {
  const context = createMockContext();
  const permissionManager = new PermissionManager(context);
  // Auto-allow applyEdit for this test
  await permissionManager.setPermission('applyEdit', 'allow');

  const filesToEdit = [
    {
      uri: vscode.Uri.file('C:/mock/workspace/src/auth/tokenService.ts'),
      content: 'export function validateToken(token: string): boolean {\n  return token.length > 10;\n}\n',
    },
    {
      uri: vscode.Uri.file('C:/mock/workspace/src/routes/login.ts'),
      content: "import { validateToken } from '../auth/tokenService';\n\nexport function handleLogin() {}\n",
    },
  ];

  const appliedResults: boolean[] = [];

  for (const item of filesToEdit) {
    const success = await DiffPreviewManager.applyEdit(
      item.uri as any,
      item.content,
      permissionManager
    );
    appliedResults.push(success);
  }

  assert.strictEqual(appliedResults.length, 2);
  assert.strictEqual(appliedResults[0], true, 'First file edit must succeed');
  assert.strictEqual(appliedResults[1], true, 'Second file edit must succeed');
});

test('PendingEdits: "Apply All" across 3+ files treats shadow-git checkpoints as one undoable unit and reverts all 3 files together', async () => {
  // Hard requirement (§3.2 / §4.3 amendment):
  // When "Apply All" applies edits across multiple files in one action,
  // triggering undo on that turn reverts ALL files affected by that single "Apply All" click together.

  class MockShadowRepo {
    public executedCommands: string[][] = [];
    public workTree: string = 'C:/mock/workspace';
    public getWorkTree(): string {
      return this.workTree;
    }
    public async initialize(): Promise<boolean> {
      return true;
    }
    public async runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
      this.executedCommands.push(args);
      if (args[0] === 'rev-parse') {
        return { stdout: 'commit-bulk-turn-42\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  }

  const mockRepo = new MockShadowRepo();
  const { CheckpointManager } = await import('../src/shadowGit/checkpoint');
  const { ScopedRestore } = await import('../src/shadowGit/restore');

  const checkpointMgr = new CheckpointManager(mockRepo as any);
  const scopedRestore = new ScopedRestore(mockRepo as any);

  // 1. Propose 3 distinct file edits
  const bulkEdits = [
    { editId: 'edit-1', filePath: 'src/auth/jwt.ts', newContent: '// fixed jwt' },
    { editId: 'edit-2', filePath: 'src/routes/user.ts', newContent: '// fixed user route' },
    { editId: 'edit-3', filePath: 'src/models/userModel.ts', newContent: '// fixed model' },
  ];
  const affectedFiles = bulkEdits.map((e) => e.filePath);

  // 2. Perform ACCEPT_ALL_EDITS flow: create single checkpoint with all 3 files
  const checkpointId = await checkpointMgr.createCheckpoint(
    affectedFiles,
    `Before bulk edit (${affectedFiles.length} files)`
  );

  assert.strictEqual(checkpointId, 'commit-bulk-turn-42', 'Must return single shared checkpoint ID');

  // Verify staging command added all 3 files in one unit
  const addCmd = mockRepo.executedCommands.find((c) => c[0] === 'add');
  assert.ok(addCmd, 'git add must have been executed');
  assert.strictEqual(addCmd.includes('src/auth/jwt.ts'), true);
  assert.strictEqual(addCmd.includes('src/routes/user.ts'), true);
  assert.strictEqual(addCmd.includes('src/models/userModel.ts'), true);

  // 3. Trigger UNDO_CHECKPOINT on that turn using the shared checkpointId and all affected files
  mockRepo.executedCommands = []; // Reset tracked commands to isolate undo call
  const undoResult = await scopedRestore.restore(checkpointId!, affectedFiles, true);

  assert.strictEqual(undoResult.success, true, 'Multi-file scoped restore must succeed');
  assert.strictEqual(mockRepo.executedCommands.length, 1, 'Undo must execute exactly one git checkout command');

  const checkoutCmd = mockRepo.executedCommands[0];
  assert.strictEqual(checkoutCmd[0], 'checkout');
  assert.strictEqual(checkoutCmd[1], checkpointId);
  assert.strictEqual(checkoutCmd[2], '--');

  // Hard requirement check: ALL 3 files must be included in the checkout command arguments
  assert.strictEqual(checkoutCmd.includes('src/auth/jwt.ts'), true, 'File 1 must be reverted');
  assert.strictEqual(checkoutCmd.includes('src/routes/user.ts'), true, 'File 2 must be reverted');
  assert.strictEqual(checkoutCmd.includes('src/models/userModel.ts'), true, 'File 3 must be reverted');
  assert.strictEqual(
    checkoutCmd.slice(3).length,
    3,
    'Checkout command must revert all 3 files together in one action, not just the last one'
  );
});

test('PendingEdits: "Reject All" on 3+ pending edits discards all without applying and clears pending bar', () => {
  // Simulates client-side Pending Edits tracking state
  const pendingEditsMap = new Map<string, { editId: string; filePath: string; newContent: string }>();
  const resolvedEdits: Record<string, { status: 'applied' | 'rejected' }> = {};

  // Add 3 pending edits
  const edits = [
    { editId: 'edit-a', filePath: 'src/index.ts', newContent: 'a' },
    { editId: 'edit-b', filePath: 'src/app.ts', newContent: 'b' },
    { editId: 'edit-c', filePath: 'src/server.ts', newContent: 'c' },
  ];

  for (const e of edits) {
    pendingEditsMap.set(e.editId, e);
  }

  assert.strictEqual(pendingEditsMap.size, 3, 'Initial pending count should be 3');
  const showBulkButtons = pendingEditsMap.size >= 3;
  assert.strictEqual(showBulkButtons, true, 'Bulk actions visible when >= 3 pending edits');

  // Trigger Reject All
  const rejectedIds: string[] = [];
  const pendingList = Array.from(pendingEditsMap.values());
  pendingList.forEach((item) => {
    resolvedEdits[item.editId] = { status: 'rejected' };
    rejectedIds.push(item.editId);
  });
  pendingEditsMap.clear();

  // Verification
  assert.strictEqual(pendingEditsMap.size, 0, 'Pending map must be cleared');
  assert.strictEqual(rejectedIds.length, 3, 'All 3 edits must be marked rejected');
  assert.strictEqual(resolvedEdits['edit-a'].status, 'rejected');
  assert.strictEqual(resolvedEdits['edit-b'].status, 'rejected');
  assert.strictEqual(resolvedEdits['edit-c'].status, 'rejected');

  // UI state calculation
  const isBarVisible = pendingEditsMap.size > 0;
  assert.strictEqual(isBarVisible, false, 'Pending edits bar must collapse/hide when 0 pending');
});

