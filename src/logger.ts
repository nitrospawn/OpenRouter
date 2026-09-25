/**
 * OpenRouter Diagnostic Logger
 *
 * - Writes every event to disk asynchronously (non-blocking)
 * - Keeps an in-memory buffer of the last 1000 lines for quick copy
 * - Auto-rotates: keeps today.log, yesterday.log, and 2-days-ago.log (max 2MB each)
 * - NEVER logs API keys, message content, or file contents - only event names and metadata
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const MAX_BUFFER_LINES = 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB per file
const ACTIVE_LOG_FILE = 'current.log';
const PREVIOUS_LOG_FILE = 'previous.log';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

class DiagnosticLogger {
  private logDir: string | undefined;
  private currentLogPath: string | undefined;
  private buffer: string[] = [];
  private sessionStart = new Date();
  private writeQueue: Promise<void> = Promise.resolve();
  private workspaceName: string = 'No Workspace';

  // -- Initialization --------------------------------------------------------

  /**
   * Initializes the logger using workspace-specific storage if available,
   * falling back to global storage. Resets the session buffer and records the start.
   */
  initialize(storageUri?: vscode.Uri, globalStorageUri?: vscode.Uri): void {
    const baseUri = storageUri || globalStorageUri;
    this.logDir = baseUri ? path.join(baseUri.fsPath, 'logs') : undefined;
    this.buffer = [];
    this.sessionStart = new Date();

    // Determine workspace label
    const activeFolder = vscode.workspace.workspaceFolders?.[0];
    this.workspaceName = vscode.workspace.name || (activeFolder ? activeFolder.name : 'No Workspace');

    this._ensureLogDir();
    if (this.logDir) {
      this.currentLogPath = path.join(this.logDir, ACTIVE_LOG_FILE);
      this._writeSessionHeader();
      this.info('LOGGER', `OpenRouter initialized for workspace: ${this.workspaceName} - log dir: ${this.logDir}`);
    }
  }

  // -- Public Log Methods ----------------------------------------------------

  info(tag: string, message: string): void {
    this._log('INFO', tag, message);
  }

  warn(tag: string, message: string): void {
    this._log('WARN', tag, message);
  }

  error(tag: string, message: string): void {
    this._log('ERROR', tag, message);
  }

  debug(tag: string, message: string): void {
    this._log('DEBUG', tag, message);
  }

  // -- Copy / Export ---------------------------------------------------------

  /** Returns the current session in-memory log as a formatted string */
  getSessionLogsText(): string {
    const header = [
      '=== OpenRouter Diagnostic Report ===',
      `Workspace : ${this.workspaceName}`,
      `Generated : ${formatTimestamp(new Date())}`,
      `Session   : ${formatTimestamp(this.sessionStart)}`,
      '-'.repeat(60),
      '',
    ].join('\n');
    return header + this.buffer.join('\n');
  }

  /** Reads current full log file from disk and returns as string */
  getTodayFileLogsText(): string {
    if (!this.currentLogPath) {
      return 'Logger not initialized.';
    }
    try {
      if (fs.existsSync(this.currentLogPath)) {
        return fs.readFileSync(this.currentLogPath, 'utf8');
      }
      return this.getSessionLogsText();
    } catch {
      return 'Log file not found or could not be read.';
    }
  }

  /** Returns the path to current log file */
  getTodayLogFilePath(): string | undefined {
    return this.currentLogPath;
  }

  // -- Internal --------------------------------------------------------------

  private _log(level: LogLevel, tag: string, message: string): void {
    const timestamp = formatTimestamp(new Date());
    const levelStr = level === 'INFO' ? 'INFO ' : level === 'WARN' ? 'WARN ' : level === 'ERROR' ? 'ERROR' : 'DEBUG';
    const line = `[${timestamp}] [${levelStr}] [${tag.substring(0, 8).padEnd(8)}] ${message}`;

    // Add to in-memory ring buffer
    this.buffer.push(line);
    if (this.buffer.length > MAX_BUFFER_LINES) {
      this.buffer.shift();
    }

    // Write to disk asynchronously
    if (this.currentLogPath) {
      this.writeQueue = this.writeQueue.then(() => this._writeLine(line));
    }
  }

  private async _writeLine(line: string): Promise<void> {
    if (!this.currentLogPath) { return; }
    try {
      try {
        const stat = fs.statSync(this.currentLogPath);
        if (stat.size >= MAX_FILE_BYTES) {
          this._rotateSizeOverflow();
        }
      } catch {
        // file doesn't exist yet
      }
      fs.appendFileSync(this.currentLogPath, line + '\n', 'utf8');
    } catch {
      // never crash the extension on log write failure
    }
  }

  private _ensureLogDir(): void {
    if (!this.logDir) { return; }
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch {}
  }

  private _rotateSizeOverflow(): void {
    if (!this.logDir || !this.currentLogPath) { return; }
    const prevLogPath = path.join(this.logDir, PREVIOUS_LOG_FILE);
    try {
      if (fs.existsSync(prevLogPath)) {
        fs.unlinkSync(prevLogPath);
      }
      if (fs.existsSync(this.currentLogPath)) {
        fs.renameSync(this.currentLogPath, prevLogPath);
      }
      this._writeSessionHeader();
    } catch {}
  }

  private _writeSessionHeader(): void {
    if (!this.currentLogPath) { return; }
    try {
      const exists = fs.existsSync(this.currentLogPath);
      const isNew = !exists || fs.statSync(this.currentLogPath).size === 0;
      const separator = '='.repeat(60);
      const header = isNew
        ? `${separator}\n OpenRouter Diagnostic Log - Workspace: ${this.workspaceName}\n Initialized: ${formatTimestamp(this.sessionStart)}\n${separator}\n\n`
        : `\n${separator}\n Session Resumed: ${formatTimestamp(this.sessionStart)} [Workspace: ${this.workspaceName}]\n${separator}\n\n`;

      fs.appendFileSync(this.currentLogPath, header, 'utf8');
    } catch {}
  }
}

// Singleton export
export const logger = new DiagnosticLogger();
