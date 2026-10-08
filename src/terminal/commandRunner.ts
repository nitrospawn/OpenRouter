import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PermissionManager } from '../permissions/permissionManager';
import { UsageStore } from '../usage/usageStore';
import { ProjectResolver } from '../usage/projectResolver';
import { SecretScanner } from '../privacy/secretScanner';
import { TerminalOutputTracker } from './terminalOutputTracker';
import { isReadOnly, getInspectionDescription } from './commandClassifier';
import { logger } from '../logger';

export interface CommandExecutionResult {
  executed: boolean;
  cancelled: boolean;
  command: string;
  cwd: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
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

  private static outputChannel: vscode.OutputChannel | undefined;

  public static getOutputChannel(): vscode.OutputChannel | undefined {
    if (!this.outputChannel && typeof vscode?.window?.createOutputChannel === 'function') {
      try {
        this.outputChannel = vscode.window.createOutputChannel('OpenRouter: Terminal');
      } catch {
        // Ignore in environments without window/UI
      }
    }
    return this.outputChannel;
  }

  public static isDestructive(command: string): boolean {
    return this.DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command.trim()));
  }

  public static isReadOnly(command: string): boolean {
    return isReadOnly(command);
  }

  public static getInspectionDescription(command: string): string {
    return getInspectionDescription(command);
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

  /**
   * Spawns a background child process to execute the command, capturing
   * stdout, stderr, and exit status code with timeout and process-tree cleanup.
   */
  private static runChildProcess(
    command: string,
    cwd: string,
    timeoutMs: number = 120000,
    abortSignal?: AbortSignal
  ): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled?: boolean;
    error?: string;
  }> {
    return new Promise((resolve) => {
      if (abortSignal?.aborted) {
        return resolve({
          exitCode: null,
          stdout: '',
          stderr: 'Command cancelled by user',
          timedOut: false,
          cancelled: true,
        });
      }

      const isWin = process.platform === 'win32';
      const outputChannel = this.getOutputChannel();
      outputChannel?.appendLine(`\n[${new Date().toLocaleTimeString()}] Executing: ${command}`);
      outputChannel?.appendLine(`[Directory]: ${cwd}`);
      logger.info('TERM', `Executing command: ${command.length > 80 ? command.substring(0, 80) + '...' : command} (cwd: ${cwd})`);

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const maxBuffer = 1024 * 512; // 512 KB cap to avoid memory exhaustion

      let timer: NodeJS.Timeout | undefined;

      const spawnCwd = fs.existsSync(cwd) ? cwd : process.cwd();

      let tempScriptPath: string | undefined;
      let child: cp.ChildProcess;

      // On Windows, cmd.exe /c only executes the first line of a multiline string.
      // To ensure every line executes in proper sequence with environment and directory preservation,
      // write multiline commands to a temporary batch script in os.tmpdir().
      if (isWin && command.includes('\n')) {
        try {
          const randSuffix = Math.random().toString(36).substring(2, 8);
          tempScriptPath = path.join(os.tmpdir(), `openrouter-cmd-${Date.now()}-${randSuffix}.cmd`);
          const scriptBody = `@echo off\r\n${command.replace(/\r?\n/g, '\r\n')}\r\n`;
          fs.writeFileSync(tempScriptPath, scriptBody, { encoding: 'utf-8' });
          child = cp.spawn('cmd.exe', ['/d', '/c', tempScriptPath], {
            cwd: spawnCwd,
            windowsHide: true,
            env: { ...process.env },
          });
        } catch {
          child = cp.spawn(command, {
            cwd: spawnCwd,
            shell: true,
            env: { ...process.env },
            windowsHide: true,
          });
        }
      } else {
        child = cp.spawn(command, {
          cwd: spawnCwd,
          shell: true,
          env: { ...process.env },
          windowsHide: true,
        });
      }

      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (abortSignal && onAbort) {
          abortSignal.removeEventListener('abort', onAbort);
        }
        if (tempScriptPath) {
          try {
            if (fs.existsSync(tempScriptPath)) {
              fs.unlinkSync(tempScriptPath);
            }
          } catch {
            // ignore cleanup failure
          }
          tempScriptPath = undefined;
        }
      };

      if (abortSignal) {
        onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          outputChannel?.appendLine(`[Cancelled]: Command execution cancelled by user.`);
          logger.warn('TERM', `Command cancelled by user: ${command.substring(0, 60)}`);
          try {
            if (isWin && child.pid) {
              // Immediately and forcefully terminate child process and all descendants
              cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
              // If this was a gradle command, stop the gradle daemon so java.exe doesn't linger
              if (/\bgradlew(\.bat)?\b/i.test(command) || /\bgradle\b/i.test(command)) {
                cp.spawn('cmd.exe', ['/c', 'gradlew.bat', '--stop'], { cwd: spawnCwd, windowsHide: true, stdio: 'ignore' });
              }
            } else if (child.pid) {
              child.kill('SIGKILL');
            }
          } catch {
            try {
              child.kill();
            } catch {
              // ignore
            }
          }
          resolve({
            exitCode: null,
            stdout,
            stderr: (stderr ? stderr + '\n' : '') + 'Command cancelled by user',
            timedOut: false,
            cancelled: true,
          });
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          outputChannel?.appendLine(`[Timeout]: Command timed out after ${timeoutMs}ms. Terminating process...`);
          logger.warn('TERM', `Command timed out after ${timeoutMs}ms: ${command.substring(0, 60)}`);
          try {
            if (isWin && child.pid) {
              cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
              if (/\bgradlew(\.bat)?\b/i.test(command) || /\bgradle\b/i.test(command)) {
                cp.spawn('cmd.exe', ['/c', 'gradlew.bat', '--stop'], { cwd: spawnCwd, windowsHide: true, stdio: 'ignore' });
              }
            } else if (child.pid) {
              child.kill('SIGKILL');
            }
          } catch {
            try {
              child.kill();
            } catch {
              // ignore
            }
          }

          // Failsafe: if child process does not emit 'close' within 2000ms after kill signal, force resolve
          setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            outputChannel?.appendLine(`[Timeout]: Forced resolve after process termination.`);
            logger.warn('TERM', `Forced resolve on timeout for command: ${command.substring(0, 60)}`);
            resolve({
              exitCode: null,
              stdout,
              stderr: (stderr ? stderr + '\n' : '') + `Command timed out after ${timeoutMs}ms`,
              timedOut: true,
            });
          }, 2000);
        }, timeoutMs);
      }

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        outputChannel?.append(text);
        if (stdout.length < maxBuffer) {
          stdout += text;
        }
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        outputChannel?.append(text);
        if (stderr.length < maxBuffer) {
          stderr += text;
        }
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        outputChannel?.appendLine(`[Error]: ${err.message}`);
        logger.error('TERM', `Command spawn error: ${err.message}`);
        resolve({
          exitCode: null,
          stdout,
          stderr,
          timedOut,
          error: err.message,
        });
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        const codeMsg = timedOut ? 'Timed out' : `Exit code: ${code}`;
        outputChannel?.appendLine(`[Finished]: ${codeMsg}`);
        if (timedOut) {
          logger.warn('TERM', `Command finished: timed out — ${command.substring(0, 60)}`);
        } else if (code !== 0) {
          logger.warn('TERM', `Command finished with exit code ${code}: ${command.substring(0, 60)}`);
        } else {
          logger.info('TERM', `Command finished OK (exit 0): ${command.substring(0, 60)}`);
        }
        resolve({
          exitCode: code,
          stdout,
          stderr,
          timedOut,
        });
      });
    });
  }

  public static async executeCommand(
    command: string,
    permissionManager: PermissionManager,
    usageStore?: UsageStore,
    options?: {
      timeoutMs?: number;
      interactiveInTerminal?: boolean;
      abortSignal?: AbortSignal;
    }
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
      return {
        executed: false,
        cancelled: true,
        command: normalizedCmd,
        cwd: effectiveCwd,
        exitCode: null,
        stdout: '',
        stderr: '',
      };
    }

    // Interactive execution fallback requested by user
    if (options?.interactiveInTerminal) {
      if (!terminal) {
        terminal = vscode.window.createTerminal({
          name: 'OpenRouter Terminal',
          cwd: effectiveCwd,
        });
      }
      terminal.show();
      terminal.sendText(normalizedCmd);

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

    // Standard execution via child_process for reliable stdout, stderr, and exit status
    const timeoutMs = options?.timeoutMs ?? 120000;
    const res = await this.runChildProcess(normalizedCmd, effectiveCwd, timeoutMs, options?.abortSignal);

    // Automated Filesystem Verification for file moves/copies/creations/deletions
    if (res.exitCode === 0 && !res.timedOut && !res.error) {
      const fsVerify = this.verifyFileSystemEffects(normalizedCmd, effectiveCwd);
      if (!fsVerify.success) {
        res.exitCode = 1;
        const verifyErrorMsg = `[Filesystem Verification Failed]: ${fsVerify.error}`;
        res.stderr = (res.stderr ? res.stderr + '\n' : '') + verifyErrorMsg;
        res.error = fsVerify.error;
      }
    }

    const sanitizedStdout = this.sanitizeCommandOutput(res.stdout);
    const sanitizedStderr = this.sanitizeCommandOutput(res.stderr);

    // Track completed output with status and exit code
    TerminalOutputTracker.recordExecutionResult({
      command: normalizedCmd,
      cwd: effectiveCwd,
      exitCode: res.exitCode,
      stdout: sanitizedStdout,
      stderr: sanitizedStderr,
      timedOut: res.timedOut,
      error: res.error,
    });

    // Log to local audit store with secrets redacted
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
      executed: !res.error || res.stdout.length > 0 || res.exitCode !== null,
      cancelled: Boolean(res.cancelled),
      command: normalizedCmd,
      cwd: effectiveCwd,
      exitCode: res.exitCode,
      stdout: sanitizedStdout,
      stderr: sanitizedStderr,
      timedOut: res.timedOut,
      error: res.error,
    };
  }

  /**
   * Performs post-command filesystem verification for file-mutating terminal operations
   * (e.g. move, mv, copy, cp, mkdir, md, del, rm).
   * If an expected target was not created, moved, or deleted, returns success: false with a clear explanation.
   */
  public static verifyFileSystemEffects(
    command: string,
    initialCwd: string
  ): { success: boolean; error?: string } {
    try {
      const rawLines = command.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      let currentDir = initialCwd;

      for (const rawLine of rawLines) {
        // Split subcommands if chained with &&, &, or ;
        const subCommands = rawLine.split(/\s*(?:&&|&|;)\s*/).map((s) => s.trim()).filter((s) => s.length > 0);

        for (const line of subCommands) {
          // Track cd / cd /d directory changes
          const cdMatch = line.match(/^cd(?:\s+\/d)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
          if (cdMatch) {
            const rawTarget = cdMatch[1] || cdMatch[2] || cdMatch[3];
            if (rawTarget) {
              currentDir = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(currentDir, rawTarget);
            }
            continue;
          }

          // Check mkdir / md
          const mkdirMatch = line.match(/^(?:mkdir|md)\s+(?:(?:\/[a-zA-Z0-9]+\s+)|(?:2>nul\s+))*(?:"([^"]+)"|'([^']+)'|(\S+))/i);
          if (mkdirMatch) {
            const rawDir = (mkdirMatch[1] || mkdirMatch[2] || mkdirMatch[3] || '').replace(/2>nul/i, '').trim();
            if (rawDir) {
              const resolvedDir = path.isAbsolute(rawDir) ? rawDir : path.resolve(currentDir, rawDir);
              if (!fs.existsSync(resolvedDir)) {
                return {
                  success: false,
                  error: `Expected directory "${rawDir}" was not created on disk (resolved path: ${resolvedDir}).`,
                };
              }
            }
            continue;
          }

          // Check move / mv
          const moveMatch = line.match(/^(?:move|mv)\s+(?:(?:(?:\/[a-zA-Z0-9]+|-[a-zA-Z0-9]+)\s+))*(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
          if (moveMatch) {
            const src = moveMatch[1] || moveMatch[2] || moveMatch[3];
            const dst = moveMatch[4] || moveMatch[5] || moveMatch[6];
            if (src && dst) {
              const resolvedDst = path.isAbsolute(dst) ? dst : path.resolve(currentDir, dst);
              let exists = fs.existsSync(resolvedDst);
              if (exists) {
                try {
                  if (fs.statSync(resolvedDst).isDirectory()) {
                    const insideFile = path.join(resolvedDst, path.basename(src));
                    if (!fs.existsSync(insideFile)) {
                      exists = false;
                    }
                  }
                } catch {
                  // ignore stat error
                }
              }
              if (!exists) {
                return {
                  success: false,
                  error: `Expected moved file or directory at "${dst}" was not found after execution (resolved path: ${resolvedDst}).`,
                };
              }
            }
            continue;
          }

          // Check copy / cp
          const copyMatch = line.match(/^(?:copy|cp)\s+(?:(?:(?:\/[a-zA-Z0-9]+|-[a-zA-Z0-9]+)\s+))*(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
          if (copyMatch) {
            const src = copyMatch[1] || copyMatch[2] || copyMatch[3];
            const dst = copyMatch[4] || copyMatch[5] || copyMatch[6];
            if (src && dst) {
              const resolvedDst = path.isAbsolute(dst) ? dst : path.resolve(currentDir, dst);
              let exists = fs.existsSync(resolvedDst);
              if (exists) {
                try {
                  if (fs.statSync(resolvedDst).isDirectory()) {
                    const insideFile = path.join(resolvedDst, path.basename(src));
                    if (!fs.existsSync(insideFile)) {
                      exists = false;
                    }
                  }
                } catch {
                  // ignore stat error
                }
              }
              if (!exists) {
                return {
                  success: false,
                  error: `Expected copied file or directory at "${dst}" was not found after execution (resolved path: ${resolvedDst}).`,
                };
              }
            }
            continue;
          }

          // Check del / rm
          const delMatch = line.match(/^(?:del|rm)\s+(?:(?:(?:\/[a-zA-Z0-9]+|-[a-zA-Z0-9]+)\s+))*(?:"([^"]+)"|'([^']+)'|(\S+))/i);
          if (delMatch) {
            const target = delMatch[1] || delMatch[2] || delMatch[3];
            if (target && !target.includes('*') && !target.includes('?')) {
              const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(currentDir, target);
              if (fs.existsSync(resolvedTarget)) {
                return {
                  success: false,
                  error: `Expected deleted file or directory "${target}" still exists after execution (resolved path: ${resolvedTarget}).`,
                };
              }
            }
          }
        }
      }

      return { success: true };
    } catch {
      // In case of unexpected verification parsing issue, do not fail benign commands
      return { success: true };
    }
  }
}


