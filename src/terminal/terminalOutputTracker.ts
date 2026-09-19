import * as vscode from 'vscode';
import { SecretScanner } from '../privacy/secretScanner';

export interface CapturedOutput {
  command: string;
  cwd: string;
  sanitizedOutput: string;
  timestamp: number;
}

export class TerminalOutputTracker {
  private static MAX_LENGTH = 10000;
  
  // Maps the active execution to its raw output buffer and metadata
  private static readonly activeExecutions = new Map<vscode.TerminalShellExecution, { rawBuffer: string; command: string; cwd: string }>();
  private static readonly recentOutputs: CapturedOutput[] = [];

  public static trackExecution(execution: vscode.TerminalShellExecution, commandLine: string, cwd: string) {
    this.activeExecutions.set(execution, { rawBuffer: '', command: commandLine, cwd });
    
    // Start reading the stream asynchronously. 
    // We intentionally don't await this so it processes in the background.
    this.startReading(execution).catch(() => {
      // Ignore stream errors
    });
  }

  private static async startReading(execution: vscode.TerminalShellExecution) {
    try {
      const stream = execution.read();
      for await (const data of stream) {
        const state = this.activeExecutions.get(execution);
        if (state) {
          state.rawBuffer += data;
        }
      }
    } finally {
      const state = this.activeExecutions.get(execution);
      if (state) {
        // Stream ended, command finished
        this.activeExecutions.delete(execution);

        // 1. Sanitize FULL output BEFORE truncation (so secrets aren't cut in half)
        const sanitized = SecretScanner.redact(state.rawBuffer).sanitized;

        // 2. Truncate if necessary (2000 head, 8000 tail)
        const finalOutput = this.truncate(sanitized);

        this.recentOutputs.push({
          command: state.command,
          cwd: state.cwd,
          sanitizedOutput: finalOutput,
          timestamp: Date.now()
        });

        // Keep only the last 3 completed outputs to prevent context bloating
        if (this.recentOutputs.length > 3) {
          this.recentOutputs.shift();
        }
      }
    }
  }

  private static truncate(text: string): string {
    if (text.length <= this.MAX_LENGTH) {
      return text;
    }
    const head = text.substring(0, 2000);
    const tail = text.substring(text.length - 8000);
    return `${head}\n\n...[output truncated due to size]...\n\n${tail}`;
  }

  /**
   * Returns formatted recent terminal outputs to be included in context.
   * This includes both completed commands and still-running commands.
   */
  public static getRecentOutputsFormatted(): string {
    const parts: string[] = [];

    // 1. Completed outputs
    for (const out of this.recentOutputs) {
      parts.push(`[Command executed at ${new Date(out.timestamp).toISOString()}]\n$ ${out.command}\n${out.sanitizedOutput}`);
    }

    // 2. Still running outputs (e.g. dev servers, watch processes)
    for (const state of this.activeExecutions.values()) {
      // 1. Sanitize FULL output BEFORE truncation
      const sanitized = SecretScanner.redact(state.rawBuffer).sanitized;
      // 2. Truncate
      const finalOutput = this.truncate(sanitized);
      parts.push(`[Command currently running]\n$ ${state.command}\n${finalOutput}`);
    }

    if (parts.length === 0) return '';

    return `\n\n--- Recent Terminal Outputs ---\n` +
           `Note: The following is real captured output from terminal commands executed recently. Use this to determine if commands succeeded, failed, or are still running.\n\n` +
           parts.join('\n\n--------------------\n\n');
  }
}
