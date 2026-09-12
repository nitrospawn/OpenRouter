import test from 'node:test';
import assert from 'node:assert';
import { PermissionManager, PermissionCategory, PermissionState } from '../src/permissions/permissionManager';

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

test('PermissionManager: returns default permission states according to PRD §4.1', () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  assert.strictEqual(manager.getPermission('readActiveContext'), 'allow');
  assert.strictEqual(manager.getPermission('proposeEdit'), 'ask');
  assert.strictEqual(manager.getPermission('applyEdit'), 'ask');
  assert.strictEqual(manager.getPermission('createDeleteFiles'), 'ask');
  assert.strictEqual(manager.getPermission('runTerminalCommand'), 'ask');
  assert.strictEqual(manager.getPermission('readWorkspaceFiles'), 'allow');
});

test('PermissionManager: persists updated permission in workspace state', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  await manager.setPermission('applyEdit', 'allow');
  assert.strictEqual(manager.getPermission('applyEdit'), 'allow');

  // Verify another manager instance with the same context reads persisted state
  const manager2 = new PermissionManager(context);
  assert.strictEqual(manager2.getPermission('applyEdit'), 'allow');
});

test('PermissionManager: handles session-scoped overrides without polluting workspace state', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  await manager.setPermission('runTerminalCommand', 'allow_session');
  assert.strictEqual(manager.getPermission('runTerminalCommand'), 'allow_session');

  // In another manager instance without the in-memory override, default remains 'ask'
  const manager2 = new PermissionManager(context);
  assert.strictEqual(manager2.getPermission('runTerminalCommand'), 'ask');
});

test('PermissionManager: resetAll clears both session overrides and stored permissions', async () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  await manager.setPermission('applyEdit', 'allow');
  await manager.setPermission('runTerminalCommand', 'allow_session');

  manager.resetAll();

  assert.strictEqual(manager.getPermission('applyEdit'), 'ask');
  assert.strictEqual(manager.getPermission('runTerminalCommand'), 'ask');
});
