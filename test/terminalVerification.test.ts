import test from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';
import { CommandRunner } from '../src/terminal/commandRunner';
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

test('Verification-triggered terminal command: must go through confirmation flow and halt if denied', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  // By default, runTerminalCommand is 'ask'
  assert.strictEqual(manager.getPermission('runTerminalCommand'), 'ask');

  const originalShowWarning = vscode.window.showWarningMessage;
  let dialogShown = false;

  // Mock user clicking 'Deny' on the confirmation dialog
  (vscode.window as any).showWarningMessage = async (msg: string, ...rest: any[]) => {
    dialogShown = true;
    assert.ok(msg.includes('npm test'));
    return 'Deny';
  };

  try {
    const res = await CommandRunner.executeCommand('npm test', manager);
    assert.strictEqual(dialogShown, true, 'Confirmation dialog must be shown for test verification command');
    assert.strictEqual(res.executed, false, 'Command must not execute when user denies confirmation');
    assert.strictEqual(res.cancelled, true, 'Command result must reflect cancellation');
  } finally {
    (vscode.window as any).showWarningMessage = originalShowWarning;
  }
});

test('Verification-triggered terminal command: executes only when user allows in confirmation dialog', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  const originalShowWarning = vscode.window.showWarningMessage;
  let dialogShown = false;

  // Mock user clicking 'Allow Once'
  (vscode.window as any).showWarningMessage = async (msg: string, ...rest: any[]) => {
    dialogShown = true;
    assert.ok(msg.includes('npm test -- --watch=false'));
    return 'Allow Once';
  };

  try {
    const res = await CommandRunner.executeCommand('npm test -- --watch=false', manager);
    assert.strictEqual(dialogShown, true);
    assert.strictEqual(res.executed, true);
    assert.strictEqual(res.cancelled, false);
  } finally {
    (vscode.window as any).showWarningMessage = originalShowWarning;
  }
});

test('Verification-triggered terminal command: blocked immediately if permission is denied', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  await manager.setPermission('runTerminalCommand', 'deny');

  const res = await CommandRunner.executeCommand('pytest', manager);
  assert.strictEqual(res.executed, false);
  assert.strictEqual(res.cancelled, true);
});
