import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandRunner } from '../src/terminal/commandRunner';
import { PermissionManager } from '../src/permissions/permissionManager';
import { ChatMessageItem } from '../src/webview/messages';
import { StoredChatMessage } from '../src/conversation/historyStore';

class MockMemento {
  private data: Map<string, any> = new Map();
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

test('Multiline Command Execution: executes every line sequentially on Windows', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('runTerminalCommand', 'allow');

  const multilineCmd = [
    'node -e "console.log(\'step_one_completed\');"',
    'node -e "console.log(\'step_two_completed\');"',
    'node -e "console.log(\'step_three_completed\');"',
  ].join('\n');

  const res = await CommandRunner.executeCommand(multilineCmd, manager);

  assert.strictEqual(res.executed, true);
  assert.strictEqual(res.exitCode, 0);
  assert.ok(res.stdout?.includes('step_one_completed'), 'Expected step 1 in output');
  assert.ok(res.stdout?.includes('step_two_completed'), 'Expected step 2 in output');
  assert.ok(res.stdout?.includes('step_three_completed'), 'Expected step 3 in output');
});

test('Filesystem Verification: passes when target directory and moved files exist', async () => {
  const testDir = path.join(os.tmpdir(), `fs-verify-pass-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const subDir = path.join(testDir, 'targetDir');
  fs.mkdirSync(subDir, { recursive: true });
  const movedFile = path.join(subDir, 'moved.txt');
  fs.writeFileSync(movedFile, 'hello');

  try {
    const cmd = `cd "${testDir}"\nmkdir targetDir 2>nul\nmove /Y file.txt "targetDir\\moved.txt"`;
    const check = CommandRunner.verifyFileSystemEffects(cmd, testDir);
    assert.strictEqual(check.success, true);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('Filesystem Verification: catches missing move destination and fails verification', async () => {
  const testDir = path.join(os.tmpdir(), `fs-verify-fail-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });

  try {
    const cmd = `cd "${testDir}"\nmove /Y "source.txt" "nonexistent_target\\output.txt"`;
    const check = CommandRunner.verifyFileSystemEffects(cmd, testDir);
    assert.strictEqual(check.success, false);
    assert.ok(check.error?.includes('nonexistent_target'));
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('Filesystem Verification: catches missing mkdir directory and fails verification', async () => {
  const testDir = path.join(os.tmpdir(), `fs-verify-mkdir-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });

  try {
    const cmd = `mkdir "missing_directory_12345"`;
    const check = CommandRunner.verifyFileSystemEffects(cmd, testDir);
    assert.strictEqual(check.success, false);
    assert.ok(check.error?.includes('missing_directory_12345'));
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('ChatMessageItem & StoredChatMessage: support isAutoRetry flag', () => {
  const chatItem: ChatMessageItem = {
    id: 'test-retry-id',
    role: 'user',
    content: 'The previous terminal command failed...',
    timestamp: Date.now(),
    isAutoRetry: true,
  };

  const storedItem: StoredChatMessage = {
    id: 'test-retry-id',
    role: 'user',
    content: 'The previous terminal command failed...',
    timestamp: Date.now(),
    isAutoRetry: true,
  };

  assert.strictEqual(chatItem.isAutoRetry, true);
  assert.strictEqual(storedItem.isAutoRetry, true);
});
