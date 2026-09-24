import test from 'node:test';
import assert from 'node:assert';
import { CommandRunner } from '../src/terminal/commandRunner';
import { TerminalOutputTracker } from '../src/terminal/terminalOutputTracker';
import { PermissionManager } from '../src/permissions/permissionManager';

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

test('ChildProcess: captures stdout and exitCode 0 on success', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('runTerminalCommand', 'allow');

  const res = await CommandRunner.executeCommand('node -e "console.log(\'hello_child_process\'); process.exit(0);"', manager);

  assert.strictEqual(res.executed, true);
  assert.strictEqual(res.cancelled, false);
  assert.strictEqual(res.exitCode, 0);
  assert.ok(res.stdout?.includes('hello_child_process'));
  assert.strictEqual(res.timedOut, false);

  const formatted = TerminalOutputTracker.getRecentOutputsFormatted();
  assert.ok(formatted.includes('hello_child_process'));
  assert.ok(formatted.includes('[Exit code: 0 (Success)]'));
});

test('ChildProcess: captures stderr and non-zero exitCode on failure', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('runTerminalCommand', 'allow');

  const res = await CommandRunner.executeCommand('node -e "console.error(\'error_child_process\'); process.exit(42);"', manager);

  assert.strictEqual(res.executed, true);
  assert.strictEqual(res.cancelled, false);
  assert.strictEqual(res.exitCode, 42);
  assert.ok(res.stderr?.includes('error_child_process'));
  assert.strictEqual(res.timedOut, false);

  const formatted = TerminalOutputTracker.getRecentOutputsFormatted();
  assert.ok(formatted.includes('error_child_process'));
  assert.ok(formatted.includes('[Exit code: 42 (Failed)]'));
});

test('ChildProcess: times out and terminates hanging process', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('runTerminalCommand', 'allow');

  const start = Date.now();
  const res = await CommandRunner.executeCommand(
    'node -e "setTimeout(() => {}, 10000);"',
    manager,
    undefined,
    { timeoutMs: 500 }
  );
  const elapsed = Date.now() - start;

  assert.strictEqual(res.timedOut, true);
  assert.ok(elapsed < 10000, `Expected elapsed < 10000ms, got ${elapsed}ms`);
});

test('ChildProcess: cancels and terminates process when AbortSignal fires', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('runTerminalCommand', 'allow');

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);

  const start = Date.now();
  const res = await CommandRunner.executeCommand(
    'node -e "setTimeout(() => {}, 10000);"',
    manager,
    undefined,
    { timeoutMs: 15000, abortSignal: controller.signal }
  );
  const elapsed = Date.now() - start;

  assert.strictEqual(res.cancelled, true);
  assert.ok(elapsed < 3000, `Expected cancellation in < 3000ms, got ${elapsed}ms`);
});

