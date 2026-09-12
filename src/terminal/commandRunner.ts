import * as vscode from 'vscode';
import { PermissionManager } from '../permissions/permissionManager';
import { ConfirmationDialogs } from '../permissions/confirmationDialogs';
import { UsageStore } from '../usage/usageStore';
import { ProjectResolver } from '../usage/projectResolver';
import { SecretScanner } from '../privacy/secretScanner';

export interface CommandExecutionResult {
  executed: boolean;
  cancelled: boolean;
  command: string;
  cwd: string;
  error?: string;
}

export class CommandRunner {
  private static allowedExactCommands: Set<string> = new Set();

  private static DESTRUCTIVE_PATTERNS = [
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|-rf|-fr)\b/i,
    /\bdel\s+\/[sS]\b/i,
    /\brmdir\s+\/[sS]\b/i,
    /\b(format|mkfs)\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-[a-zA-Z]*f\b/i,
    /\bdrop\s+(database|table)\b/i,
    /\bkill\s+-9\b/i,
    />\s*\/dev\/sd/i,
  ];

  public static isDestructive(command: string): boolean {
    return this.DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command.trim()));
  }

  public static getSuggestedReverse(command: string): string | undefined {
    const trimmed = command.trim();
    if (/^npm\s+(i|install)\s+(.+)$/i.test(trimmed)) {
      return trimmed.replace(/^npm\s+(i|install)/i, 'npm uninstall');
    }
    if (/^pnpm\s+add\s+(.+)$/i.test(trimmed)) {
      return trimmed.replace(/^pnpm\s+add/i, 'pnpm remove');
    }
    if (/^yarn\s+add\s+(.+)$/i.test(trimmed)) {
      return trimmed.replace(/^yarn\s+add/i, 'yarn remove');
    }
    if (/^pip\s+install\s+(.+)$/i.test(trimmed)) {
      return trimmed.replace(/^pip\s+install/i, 'pip uninstall -y');
    }
    return undefined;
  }

  /**
   * Sanitizes terminal output (e.g. env var echoes, curl token headers)
   * before it is sent back to the model as conversational follow-up context.
   */
  public static sanitizeCommandOutput(output: string): string {
    const res = SecretScanner.redact(output);
    return res.sanitized;
  }

  public static async executeCommand(
    command: string,
    permissionManager: PermissionManager,
    usageStore?: UsageStore
  ): Promise<CommandExecutionResult> {
    const permState = permissionManager.getPermission('runTerminalCommand');
    if (permState === 'deny') {
      vscode.window.showErrorMessage('Terminal commands are disabled in OpenRouter permissions.');
      return { executed: false, cancelled: true, command, cwd: '' };
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : process.cwd();

    const normalizedCmd = command.trim();
    const isDestructive = this.isDestructive(normalizedCmd);
    const suggestedReverse = this.getSuggestedReverse(normalizedCmd);

    // If not in allowedExactCommands, prompt
    if (!this.allowedExactCommands.has(normalizedCmd)) {
      const confirmed = await ConfirmationDialogs.confirmTerminalCommand(
        normalizedCmd,
        cwd,
        isDestructive,
        suggestedReverse
      );

      if (confirmed === 'deny') {
        vscode.window.showInformationMessage('Command execution cancelled.');
        return { executed: false, cancelled: true, command: normalizedCmd, cwd };
      }

      if (confirmed === 'allow_always') {
        this.allowedExactCommands.add(normalizedCmd);
      }
    }

    // Run in VS Code integrated terminal
    let terminal = vscode.window.terminals.find((t) => t.name === 'OpenRouter Terminal');
    if (!terminal) {
      terminal = vscode.window.createTerminal({
        name: 'OpenRouter Terminal',
        cwd,
      });
    }

    terminal.show();
    terminal.sendText(normalizedCmd);

    // Log to local audit store with secrets redacted (PRD Phase 7 §7.1 / terminal audit requirement)
    if (usageStore) {
      const projectName = ProjectResolver.getActiveProjectName();
      const sanitizedCmdForAudit = SecretScanner.redact(normalizedCmd).sanitized;
      await usageStore.appendRecord({
        type: 'terminal_command',
        project: projectName,
        command: sanitizedCmdForAudit,
        cwd,
      });
    }

    return {
      executed: true,
      cancelled: false,
      command: normalizedCmd,
      cwd,
    };
  }
}
