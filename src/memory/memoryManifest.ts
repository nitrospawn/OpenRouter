import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from '../logger';

export interface MemoryManifestEntry {
  id: string;
  timestamp: number;
  dateStr: string;
  taskTitle: string;
  status: 'in_progress' | 'completed' | 'reverted';
  summary?: string;
  checkpointId?: string;
  affectedFiles?: string[];
}

export class MemoryManifest {
  private static readonly MANIFEST_DIR = '.openrouter';
  private static readonly MANIFEST_FILE = 'activity_log.md';
  private static readonly MAX_ENTRIES_ON_DISK = 100;
  private static readonly MAX_ENTRIES_IN_PROMPT = 15;

  /**
   * Retrieves the absolute Uri for .openrouter/activity_log.md in the current workspace.
   */
  public static getManifestUri(): vscode.Uri | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    return vscode.Uri.joinPath(workspaceFolders[0].uri, this.MANIFEST_DIR, this.MANIFEST_FILE);
  }

  /**
   * Records or updates a task in the manifest.
   * If an entry with the same id exists, it updates it. Otherwise, appends it.
   */
  public static async recordTask(entry: Partial<MemoryManifestEntry> & { id: string; taskTitle: string }): Promise<void> {
    const uri = this.getManifestUri();
    if (!uri) return;

    try {
      const entries = await this.readAllEntries();
      const existingIdx = entries.findIndex((e) => e.id === entry.id);

      const now = Date.now();
      const dateStr = new Date(now).toISOString().replace('T', ' ').substring(0, 16);

      const updatedEntry: MemoryManifestEntry = {
        id: entry.id,
        timestamp: entry.timestamp ?? (existingIdx !== -1 ? entries[existingIdx].timestamp : now),
        dateStr: entry.dateStr ?? (existingIdx !== -1 ? entries[existingIdx].dateStr : dateStr),
        taskTitle: entry.taskTitle,
        status: entry.status ?? (existingIdx !== -1 ? entries[existingIdx].status : 'in_progress'),
        summary: entry.summary ?? (existingIdx !== -1 ? entries[existingIdx].summary : undefined),
        checkpointId: entry.checkpointId ?? (existingIdx !== -1 ? entries[existingIdx].checkpointId : undefined),
        affectedFiles: entry.affectedFiles ?? (existingIdx !== -1 ? entries[existingIdx].affectedFiles : []),
      };

      if (existingIdx !== -1) {
        entries[existingIdx] = updatedEntry;
      } else {
        entries.push(updatedEntry);
      }

      await this.saveEntries(entries);
      logger.info('MEMORY', `Task ${updatedEntry.id} recorded with status "${updatedEntry.status}": ${updatedEntry.taskTitle}`);
    } catch (err: any) {
      logger.warn('MEMORY', `Failed to record task manifest: ${err.message}`);
    }
  }

  /**
   * Marks any manifest entry matching the specified checkpointId as reverted.
   */
  public static async markReverted(checkpointId: string): Promise<boolean> {
    const uri = this.getManifestUri();
    if (!uri || !checkpointId) return false;

    try {
      const entries = await this.readAllEntries();
      let matched = false;

      for (const entry of entries) {
        if (entry.checkpointId === checkpointId && entry.status !== 'reverted') {
          entry.status = 'reverted';
          matched = true;
          logger.info('MEMORY', `Marked task ${entry.id} as reverted (checkpoint: ${checkpointId.substring(0, 7)})`);
        }
      }

      if (matched) {
        await this.saveEntries(entries);
        return true;
      }
    } catch (err: any) {
      logger.warn('MEMORY', `Failed to mark task reverted: ${err.message}`);
    }
    return false;
  }

  /**
   * Formats the most recent active/reverted tasks for injection into the system prompt.
   * Returns empty string if no manifest exists or no entries are recorded.
   */
  public static async formatForPrompt(): Promise<string> {
    try {
      const entries = await this.readAllEntries();
      if (entries.length === 0) return '';

      // Take the most recent entries up to the limit
      const recent = entries.slice(-this.MAX_ENTRIES_IN_PROMPT);

      const lines = recent.map((e) => {
        const fileList = e.affectedFiles && e.affectedFiles.length > 0 ? ` (Files: ${e.affectedFiles.map((f) => path.basename(f)).join(', ')})` : '';
        const summary = e.summary ? ` — ${e.summary}` : '';

        if (e.status === 'reverted') {
          return `- ~~[${e.dateStr}] ${e.taskTitle}${summary}${fileList}~~ [REVERTED by user]`;
        } else if (e.status === 'in_progress') {
          return `- [${e.dateStr}] ⏳ IN PROGRESS: ${e.taskTitle}${summary}${fileList}`;
        } else {
          return `- [${e.dateStr}] ✓ COMPLETED: ${e.taskTitle}${summary}${fileList}`;
        }
      });

      return `\n\n<recent_workspace_activities>\n# Recent Workspace Activities & Task Manifest\nThe following tasks were previously undertaken in this workspace. Use this context to maintain continuity across sessions without re-implementing or conflicting with past work:\n${lines.join('\n')}\n</recent_workspace_activities>\n`;
    } catch {
      return '';
    }
  }

  /**
   * Reads and parses all entries from .openrouter/activity_log.md.
   */
  public static async readAllEntries(): Promise<MemoryManifestEntry[]> {
    const uri = this.getManifestUri();
    if (!uri) return [];

    try {
      const rawBytes = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder('utf-8').decode(rawBytes);
      return this.parseMarkdown(content);
    } catch {
      return [];
    }
  }

  /**
   * Serializes entries to Markdown and writes to .openrouter/activity_log.md.
   */
  private static async saveEntries(entries: MemoryManifestEntry[]): Promise<void> {
    const uri = this.getManifestUri();
    if (!uri) return;

    // Prune to rolling window
    const bounded = entries.slice(-this.MAX_ENTRIES_ON_DISK);

    let md = '# OpenRouter Workspace Activity Log & Model Memory\n\n';
    md += 'This manifest records high-level tasks completed, in progress, or reverted across chat sessions.\n\n';

    for (const e of bounded) {
      const jsonMeta = JSON.stringify({
        id: e.id,
        timestamp: e.timestamp,
        status: e.status,
        checkpointId: e.checkpointId,
        affectedFiles: e.affectedFiles,
      });

      if (e.status === 'reverted') {
        md += `- ~~[${e.dateStr}] ${e.taskTitle}${e.summary ? ` — ${e.summary}` : ''}~~ [REVERTED by user] <!-- META:${jsonMeta} -->\n`;
      } else if (e.status === 'in_progress') {
        md += `- [${e.dateStr}] ⏳ IN PROGRESS: ${e.taskTitle}${e.summary ? ` — ${e.summary}` : ''} <!-- META:${jsonMeta} -->\n`;
      } else {
        md += `- [${e.dateStr}] ✓ COMPLETED: ${e.taskTitle}${e.summary ? ` — ${e.summary}` : ''} <!-- META:${jsonMeta} -->\n`;
      }
    }

    const encoder = new TextEncoder();
    try {
      const parentDir = vscode.Uri.joinPath(uri, '..');
      await vscode.workspace.fs.createDirectory(parentDir);
    } catch {
      // ignore if already exists
    }
    await vscode.workspace.fs.writeFile(uri, encoder.encode(md));
  }

  /**
   * Parses Markdown lines containing embedded <!-- META:... --> comments into structured entries.
   */
  public static parseMarkdown(content: string): MemoryManifestEntry[] {
    const entries: MemoryManifestEntry[] = [];
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      if (!line.trim().startsWith('-')) continue;

      const metaMatch = /<!--\s*META:(.*?)\s*-->/.exec(line);
      let meta: Partial<MemoryManifestEntry> = {};
      if (metaMatch) {
        try {
          meta = JSON.parse(metaMatch[1]);
        } catch {
          // ignore malformed meta
        }
      }

      // Parse date: - [2026-09-24 22:30]
      const dateMatch = /\[(\d{4}-\d{2}-\d{2}[^\]]+)\]/.exec(line);
      const dateStr = dateMatch ? dateMatch[1] : '';

      // Determine status from line
      let status: 'in_progress' | 'completed' | 'reverted' = meta.status ?? 'completed';
      if (line.includes('[REVERTED by user]')) {
        status = 'reverted';
      } else if (line.includes('⏳ IN PROGRESS:')) {
        status = 'in_progress';
      } else if (line.includes('✓ COMPLETED:')) {
        status = 'completed';
      }

      // Extract task title and summary
      let cleaned = line
        .replace(/<!--.*?-->/g, '')
        .replace(/\[REVERTED by user\]/g, '')
        .replace(/^-\s*~~?/, '')
        .replace(/~~?\s*$/, '')
        .replace(/^-\s*/, '')
        .replace(/\[\d{4}-\d{2}-\d{2}[^\]]+\]\s*/, '')
        .replace(/(?:⏳ IN PROGRESS:|✓ COMPLETED:)\s*/, '')
        .trim();

      const parts = cleaned.split(' — ');
      const taskTitle = parts[0] || 'Task';
      const summary = parts.length > 1 ? parts.slice(1).join(' — ') : undefined;

      const id = meta.id || `task-${meta.timestamp || Date.now()}`;

      entries.push({
        id,
        timestamp: meta.timestamp || Date.now(),
        dateStr,
        taskTitle,
        status,
        summary,
        checkpointId: meta.checkpointId,
        affectedFiles: meta.affectedFiles || [],
      });
    }

    return entries;
  }
}
