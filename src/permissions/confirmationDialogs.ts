import * as vscode from 'vscode';

export class ConfirmationDialogs {
  public static onPermissionPrompt?: () => void;
  public static async confirmFileEdit(filePath: string, isNewFile: boolean = false): Promise<'allow' | 'allow_session' | 'deny'> {
    this.onPermissionPrompt?.();
    const actionLabel = isNewFile ? 'create file' : 'modify file';
    const choice = await vscode.window.showWarningMessage(
      `OpenRouter wants to ${actionLabel}: ${filePath}`,
      { modal: true },
      'Allow Once',
      'Allow for this Session',
      'Deny'
    );

    if (choice === 'Allow Once') return 'allow';
    if (choice === 'Allow for this Session') return 'allow_session';
    return 'deny';
  }

  public static async confirmFileDelete(filePath: string): Promise<boolean> {
    this.onPermissionPrompt?.();
    const choice = await vscode.window.showWarningMessage(
      `Warning: OpenRouter wants to DELETE file: ${filePath}. This cannot be undone automatically!`,
      { modal: true },
      'Delete File',
      'Cancel'
    );
    return choice === 'Delete File';
  }

  public static async confirmTerminalCommand(
    command: string,
    cwd: string,
    isDestructive: boolean,
    suggestedReverse?: string
  ): Promise<'allow' | 'allow_always' | 'deny'> {
    this.onPermissionPrompt?.();
    let warningText = `Execute terminal command?\n\nCommand: ${command}\nDirectory: ${cwd}`;
    if (isDestructive) {
      warningText = `⚠️ CAUTION: Potentially destructive command detected!\n\nCommand: ${command}\nDirectory: ${cwd}`;
      if (suggestedReverse) {
        warningText += `\n\nSuggested reverse command if needed: ${suggestedReverse}`;
      }
    }

    const options = isDestructive
      ? ['Allow Once', 'Deny']
      : ['Allow Once', 'Always Allow This Exact Command', 'Deny'];

    const choice = await vscode.window.showWarningMessage(warningText, { modal: true }, ...options);

    if (choice === 'Allow Once') return 'allow';
    if (choice === 'Always Allow This Exact Command') return 'allow_always';
    return 'deny';
  }
}
