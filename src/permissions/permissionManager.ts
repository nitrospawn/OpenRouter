import * as vscode from 'vscode';
import { ConfirmationDialogs } from './confirmationDialogs';

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
  private static readonly STORAGE_KEY_ALLOWED_COMMANDS = 'openrouter.permissions.allowedCommands';
  private sessionOverrides: Map<PermissionCategory, PermissionState> = new Map();
  private sessionAllowedCommands: Set<string> = new Set();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Normalizes terminal commands so that whitespace variations, line ending differences,
   * and shell prompt symbols do not cause spurious mismatches.
   * Collapses redundant spaces/tabs outside quotes while preserving literal strings inside quotes.
   */
  public static normalizeCommand(command: string): string {
    if (!command) return '';
    let cmd = command.trim();
    // Normalize line endings to \n
    cmd = cmd.replace(/\r\n/g, '\n');
    // Strip leading shell prompt sigils (e.g., "$ npm test" or "# npm test")
    cmd = cmd.replace(/^\s*[$#]\s+/, '');

    const lines = cmd.split('\n').map((line) => {
      let inSingle = false;
      let inDouble = false;
      let result = '';
      let lastWasSpace = false;

      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'" && !inDouble) {
          inSingle = !inSingle;
          result += ch;
          lastWasSpace = false;
        } else if (ch === '"' && !inSingle) {
          inDouble = !inDouble;
          result += ch;
          lastWasSpace = false;
        } else if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
          if (!lastWasSpace) {
            result += ' ';
            lastWasSpace = true;
          }
        } else {
          result += ch;
          lastWasSpace = false;
        }
      }
      return result.trim();
    });

    return lines.filter((l) => l.length > 0).join('\n').trim();
  }

  /**
   * Normalizes a working directory path for consistent comparison.
   */
  public static normalizeCwd(cwd?: string): string {
    if (!cwd) return '';
    return cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  /**
   * Computes the composite key for an exact command approval bound to a working directory.
   */
  public static getCommandCompositeKey(command: string, cwd?: string): string {
    const normCmd = PermissionManager.normalizeCommand(command);
    const normCwd = PermissionManager.normalizeCwd(cwd);
    return `${normCwd}::${normCmd}`;
  }

  /**
   * Checks whether an exact command string has been approved for execution in the given cwd.
   */
  public isExactCommandAllowed(command: string, cwd?: string): boolean {
    const key = PermissionManager.getCommandCompositeKey(command, cwd);
    if (this.sessionAllowedCommands.has(key)) {
      return true;
    }

    const stored = this.context.workspaceState.get<string[]>(
      PermissionManager.STORAGE_KEY_ALLOWED_COMMANDS,
      []
    );
    return stored.includes(key);
  }

  /**
   * Persists an exact command approval bound to the given cwd in workspace state and session cache.
   */
  public async allowExactCommand(command: string, cwd?: string): Promise<void> {
    const key = PermissionManager.getCommandCompositeKey(command, cwd);
    this.sessionAllowedCommands.add(key);

    const stored = this.context.workspaceState.get<string[]>(
      PermissionManager.STORAGE_KEY_ALLOWED_COMMANDS,
      []
    );
    if (!stored.includes(key)) {
      stored.push(key);
      await this.context.workspaceState.update(
        PermissionManager.STORAGE_KEY_ALLOWED_COMMANDS,
        stored
      );
    }
  }

  public getAllowedExactCommands(): string[] {
    const stored = this.context.workspaceState.get<string[]>(
      PermissionManager.STORAGE_KEY_ALLOWED_COMMANDS,
      []
    );
    return Array.from(new Set([...this.sessionAllowedCommands, ...stored]));
  }

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

    // Clear any active session override for this category so the persistent setting takes effect immediately
    this.sessionOverrides.delete(category);

    const stored = {
      ...this.context.workspaceState.get<Record<string, PermissionState>>(
        PermissionManager.STORAGE_KEY,
        {}
      ),
    };
    stored[category] = state;
    await this.context.workspaceState.update(PermissionManager.STORAGE_KEY, stored);
  }

  public resetAll(): void {
    this.sessionOverrides.clear();
    this.sessionAllowedCommands.clear();
    this.context.workspaceState.update(PermissionManager.STORAGE_KEY, undefined);
    this.context.workspaceState.update(PermissionManager.STORAGE_KEY_ALLOWED_COMMANDS, undefined);
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

  /**
   * Consolidated permission check for running a terminal command.
   * Respects runTerminalCommand category state ('deny' -> blocks, 'allow'/'allow_session' -> bypasses dialog),
   * exact-command approvals for the given cwd (bypasses dialog), and prompts if unapproved.
   */
  public async checkTerminalCommandPermission(
    command: string,
    cwd: string,
    isDestructive: boolean,
    suggestedReverse?: string
  ): Promise<'allowed' | 'denied'> {
    const permState = this.getPermission('runTerminalCommand');
    if (permState === 'deny') {
      vscode.window.showErrorMessage('Terminal commands are disabled in OpenRouter permissions.');
      return 'denied';
    }

    // Explicit 'allow' or 'allow_session' skips the confirmation dialog entirely
    if (permState === 'allow' || permState === 'allow_session') {
      return 'allowed';
    }

    // Exact command approved previously in this specific cwd skips confirmation
    if (!isDestructive && this.isExactCommandAllowed(command, cwd)) {
      return 'allowed';
    }

    // Otherwise prompt the user with modal dialog
    const confirmed = await ConfirmationDialogs.confirmTerminalCommand(
      command,
      cwd,
      isDestructive,
      suggestedReverse
    );

    if (confirmed === 'deny') {
      vscode.window.showInformationMessage('Command execution cancelled.');
      return 'denied';
    }

    if (confirmed === 'allow_always') {
      await this.allowExactCommand(command, cwd);
    }

    return 'allowed';
  }

  /**
   * Consolidated permission check for applying edits or creating files.
   * Differentiates between modifying existing files (applyEdit) and creating new files (createDeleteFiles).
   */
  public async checkApplyEditPermission(
    filePath: string,
    isNewFile: boolean
  ): Promise<'allowed' | 'denied'> {
    if (isNewFile) {
      const createPerm = this.getPermission('createDeleteFiles');
      if (createPerm === 'deny') {
        vscode.window.showErrorMessage('Creating files is currently disabled in OpenRouter permissions.');
        return 'denied';
      }
      if (createPerm === 'allow') {
        return 'allowed';
      }
    }

    const editPerm = this.getPermission('applyEdit');
    if (editPerm === 'deny') {
      vscode.window.showErrorMessage('Applying edits is currently disabled in OpenRouter permissions.');
      return 'denied';
    }

    if (editPerm === 'allow' || editPerm === 'allow_session') {
      // If creating a new file and createDeleteFiles is set to 'ask', prompt specifically for file creation
      if (isNewFile) {
        const createPerm = this.getPermission('createDeleteFiles');
        if (createPerm === 'ask') {
          const confirmed = await ConfirmationDialogs.confirmFileEdit(filePath, true);
          if (confirmed === 'deny') {
            vscode.window.showInformationMessage('File creation cancelled.');
            return 'denied';
          }
          if (confirmed === 'allow_session') {
            await this.setPermission('createDeleteFiles', 'allow_session');
          }
          return 'allowed';
        }
      }
      return 'allowed';
    }

    // Default 'ask'
    const confirmed = await ConfirmationDialogs.confirmFileEdit(filePath, isNewFile);
    if (confirmed === 'deny') {
      vscode.window.showInformationMessage(isNewFile ? 'File creation cancelled.' : 'Edit cancelled.');
      return 'denied';
    }

    if (confirmed === 'allow_session') {
      await this.setPermission('applyEdit', 'allow_session');
      if (isNewFile) {
        await this.setPermission('createDeleteFiles', 'allow_session');
      }
    }

    return 'allowed';
  }

  /**
   * Consolidated check for reading context (readActiveContext / readWorkspaceFiles).
   */
  public checkReadContextPermission(category: 'readActiveContext' | 'readWorkspaceFiles'): boolean {
    return this.getPermission(category) !== 'deny';
  }
}

