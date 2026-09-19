import * as vscode from 'vscode';
import { PermissionManager } from '../permissions/permissionManager';
import { UsageStore } from '../usage/usageStore';
import { ProjectResolver } from '../usage/projectResolver';
import { SecretScanner } from '../privacy/secretScanner';
import { TerminalOutputTracker } from './terminalOutputTracker';

export interface CommandExecutionResult {
  executed: boolean;
  cancelled: boolean;
  command: string;
  cwd: string;
  error?: string;
}

export class CommandRunner {
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
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const baseCwd = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : process.cwd();

    // Check if OpenRouter Terminal already exists and has active shellIntegration cwd
    let terminal = vscode.window.terminals.find((t) => t.name === 'OpenRouter Terminal');
    let effectiveCwd = baseCwd;
    if (terminal && (terminal as any).shellIntegration && (terminal as any).shellIntegration.cwd) {
      const shellCwd = (terminal as any).shellIntegration.cwd;
      effectiveCwd = typeof shellCwd === 'string' ? shellCwd : (shellCwd.fsPath || shellCwd.path || baseCwd);
    }

    const normalizedCmd = PermissionManager.normalizeCommand(command);
    const isDestructive = this.isDestructive(normalizedCmd);
    const suggestedReverse = this.getSuggestedReverse(normalizedCmd);

    // Single consolidated permission check
    const permStatus = await permissionManager.checkTerminalCommandPermission(
      normalizedCmd,
      effectiveCwd,
      isDestructive,
      suggestedReverse
    );

    if (permStatus === 'denied') {
      return { executed: false, cancelled: true, command: normalizedCmd, cwd: effectiveCwd };
    }

    // Run in VS Code integrated terminal
    if (!terminal) {
      terminal = vscode.window.createTerminal({
        name: 'OpenRouter Terminal',
        cwd: effectiveCwd,
      });
    }

    terminal.show();
    
    if (terminal.shellIntegration) {
      const execution = terminal.shellIntegration.executeCommand(normalizedCmd);
      TerminalOutputTracker.trackExecution(execution, normalizedCmd, effectiveCwd);
    } else {
      terminal.sendText(normalizedCmd);
    }

    // Log to local audit store with secrets redacted (PRD Phase 7 §7.1 / terminal audit requirement)
    if (usageStore) {
      const projectName = ProjectResolver.getActiveProjectName();
      const sanitizedCmdForAudit = SecretScanner.redact(normalizedCmd).sanitized;
      await usageStore.appendRecord({
        type: 'terminal_command',
        project: projectName,
        command: sanitizedCmdForAudit,
        cwd: effectiveCwd,
        cost: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    }

    return {
      executed: true,
      cancelled: false,
      command: normalizedCmd,
      cwd: effectiveCwd,
    };
  }
}

