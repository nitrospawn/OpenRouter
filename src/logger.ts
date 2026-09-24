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
const LOG_FILE_NAMES = ['log-today.txt', 'log-yesterday.txt', 'log-2daysago.txt'];

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

class DiagnosticLogger {
  private logDir: string | undefined;
  private todayLogPath: string | undefined;
  private buffer: string[] = [];
  private sessionStart = new Date();
  private writeQueue: Promise<void> = Promise.resolve();

  // -- Initialization --------------------------------------------------------

  initialize(globalStorageUri: vscode.Uri): void {
    this.logDir = globalStorageUri.fsPath;
    this._ensureLogDir();
    this._rotateIfNewDay();
    this.todayLogPath = path.join(this.logDir, LOG_FILE_NAMES[0]);
    this._writeHeaderIfEmpty();
    this.info('LOGGER', `OpenRouter started - log dir: ${this.logDir}`);
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
      `Generated : ${new Date().toLocaleString()}`,
      `Session   : ${this.sessionStart.toLocaleString()}`,
      '-'.repeat(60),
      '',
    ].join('\n');
    return header + this.buffer.join('\n');
  }

  /** Reads today full log file from disk and returns as string */
  getTodayFileLogsText(): string {
    if (!this.todayLogPath) {
      return 'Logger not initialized.';
    }
    try {
      return fs.readFileSync(this.todayLogPath, 'utf8');
    } catch {
      return 'Log file not found or could not be read.';
    }
  }

  /** Returns the path to today log file */
  getTodayLogFilePath(): string | undefined {
    return this.todayLogPath;
  }

  // -- Internal --------------------------------------------------------------

  private _log(level: LogLevel, tag: string, message: string): void {
    const now = new Date();
    const time = now.toTimeString().substring(0, 8); // HH:MM:SS
    const levelStr = level === 'INFO' ? 'INFO ' : level === 'WARN' ? 'WARN ' : level === 'ERROR' ? 'ERROR' : 'DEBUG';
    const line = `[${time}] [${levelStr}] [${tag.substring(0, 8).padEnd(8)}] ${message}`;

    // Add to in-memory ring buffer
    this.buffer.push(line);
    if (this.buffer.length > MAX_BUFFER_LINES) {
      this.buffer.shift();
    }

    // Write to disk asynchronously
    if (this.todayLogPath) {
      this.writeQueue = this.writeQueue.then(() => this._writeLine(line));
    }
  }

  private async _writeLine(line: string): Promise<void> {
    if (!this.todayLogPath) { return; }
    try {
      try {
        const stat = fs.statSync(this.todayLogPath);
        if (stat.size >= MAX_FILE_BYTES) {
          this._rotateSizeOverflow();
        }
      } catch {
        // file doesn't exist yet
      }
      fs.appendFileSync(this.todayLogPath, line + '\n', 'utf8');
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

  private _rotateIfNewDay(): void {
    if (!this.logDir) { return; }
    const paths = LOG_FILE_NAMES.map((n) => path.join(this.logDir!, n));
    try {
      if (fs.existsSync(paths[2])) { fs.unlinkSync(paths[2]); }
      if (fs.existsSync(paths[1])) { fs.renameSync(paths[1], paths[2]); }
      if (fs.existsSync(paths[0])) {
        const stat = fs.statSync(paths[0]);
        const fileDate = new Date(stat.mtime).toDateString();
        const today = new Date().toDateString();
        if (fileDate !== today) {
          fs.renameSync(paths[0], paths[1]);
        }
      }
    } catch {}
  }

  private _rotateSizeOverflow(): void {
    if (!this.logDir) { return; }
    const paths = LOG_FILE_NAMES.map((n) => path.join(this.logDir!, n));
    try {
      if (fs.existsSync(paths[2])) { fs.unlinkSync(paths[2]); }
      if (fs.existsSync(paths[1])) { fs.renameSync(paths[1], paths[2]); }
      if (fs.existsSync(paths[0])) { fs.renameSync(paths[0], paths[1]); }
      this.todayLogPath = paths[0];
      this._writeHeaderIfEmpty();
    } catch {}
  }

  private _writeHeaderIfEmpty(): void {
    if (!this.todayLogPath) { return; }
    try {
      const exists = fs.existsSync(this.todayLogPath);
      if (!exists || fs.statSync(this.todayLogPath).size === 0) {
        const header =
          `${'='.repeat(60)}\n` +
          ` OpenRouter Diagnostic Log - ${new Date().toDateString()}\n` +
          `${'='.repeat(60)}\n\n`;
        fs.writeFileSync(this.todayLogPath, header, 'utf8');
      }
    } catch {}
  }
}

// Singleton export
export const logger = new DiagnosticLogger();
