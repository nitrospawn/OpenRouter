import * as vscode from 'vscode';

export type PermissionCategory =
  | 'readActiveContext'
  | 'proposeEdit'
  | 'applyEdit'
  | 'createDeleteFiles'
  | 'runTerminalCommand'
  | 'readWorkspaceFiles';

export type PermissionState = 'allow' | 'allow_session' | 'ask' | 'deny';

export class PermissionManager {
  private static readonly STORAGE_KEY = 'openrouter.permissions';
  private sessionOverrides: Map<PermissionCategory, PermissionState> = new Map();

  constructor(private readonly context: vscode.ExtensionContext) {}

  public getPermission(category: PermissionCategory): PermissionState {
    // 1. Check in-memory session overrides first
    if (this.sessionOverrides.has(category)) {
      return this.sessionOverrides.get(category)!;
    }

    // 2. Check workspace-persisted settings
    const stored = this.context.workspaceState.get<Record<string, PermissionState>>(
      PermissionManager.STORAGE_KEY,
      {}
    );

    if (stored[category]) {
      return stored[category];
    }

    // 3. Defaults based on PRD §4.1
    switch (category) {
      case 'readActiveContext':
        return 'allow'; // Allowed automatically by default
      case 'proposeEdit':
        return 'ask'; // Always shown as diff preview first
      case 'applyEdit':
        return 'ask'; // Only after explicit Accept
      case 'createDeleteFiles':
        return 'ask'; // Explicit confirmation dialog every time
      case 'runTerminalCommand':
        return 'ask'; // Explicit confirmation dialog showing exact command
      case 'readWorkspaceFiles':
        return 'allow'; // Allowed automatically for workspace context
      default:
        return 'ask';
    }
  }

  public async setPermission(
    category: PermissionCategory,
    state: PermissionState
  ): Promise<void> {
    if (state === 'allow_session') {
      this.sessionOverrides.set(category, 'allow_session');
      return;
    }

    const stored = this.context.workspaceState.get<Record<string, PermissionState>>(
      PermissionManager.STORAGE_KEY,
      {}
    );
    stored[category] = state;
    await this.context.workspaceState.update(PermissionManager.STORAGE_KEY, stored);
  }

  public resetAll(): void {
    this.sessionOverrides.clear();
    this.context.workspaceState.update(PermissionManager.STORAGE_KEY, undefined);
  }

  public getAllStates(): Record<PermissionCategory, PermissionState> {
    const categories: PermissionCategory[] = [
      'readActiveContext',
      'proposeEdit',
      'applyEdit',
      'createDeleteFiles',
      'runTerminalCommand',
      'readWorkspaceFiles',
    ];

    const result: Partial<Record<PermissionCategory, PermissionState>> = {};
    for (const cat of categories) {
      result[cat] = this.getPermission(cat);
    }
    return result as Record<PermissionCategory, PermissionState>;
  }
}
