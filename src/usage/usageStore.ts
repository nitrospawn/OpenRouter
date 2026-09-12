import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type UsageEventType = 'chat_completion' | 'terminal_command' | 'summarization';

export interface UsageAuditRecord {
  id: string;
  timestamp: number;
  type: UsageEventType;
  project: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  command?: string;
  cwd?: string;
}

export interface SpendSummary {
  today: number;
  thisWeek: number;
  thisMonth: number;
  total: number;
}

export class UsageStore {
  private static readonly FILE_NAME = 'usage_audit_log.json';
  private inMemoryLog: UsageAuditRecord[] = [];
  private isLoaded = false;
  private logFilePath?: string;

  constructor(private readonly globalStorageUri?: vscode.Uri) {
    if (globalStorageUri) {
      this.logFilePath = path.join(globalStorageUri.fsPath, UsageStore.FILE_NAME);
    }
  }

  public async loadRecords(): Promise<UsageAuditRecord[]> {
    if (this.isLoaded) {
      return this.inMemoryLog;
    }

    if (!this.logFilePath) {
      this.isLoaded = true;
      return this.inMemoryLog;
    }

    try {
      if (fs.existsSync(this.logFilePath)) {
        const raw = fs.readFileSync(this.logFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.inMemoryLog = Array.isArray(parsed) ? parsed : [];
      } else {
        this.inMemoryLog = [];
      }
    } catch {
      this.inMemoryLog = [];
    }

    this.isLoaded = true;
    return this.inMemoryLog;
  }

  public async appendRecord(record: Omit<UsageAuditRecord, 'id' | 'timestamp'>): Promise<UsageAuditRecord> {
    if (!this.isLoaded) {
      await this.loadRecords();
    }

    const fullRecord: UsageAuditRecord = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
      ...record,
    };

    this.inMemoryLog.unshift(fullRecord); // latest first
    await this.persist();
    return fullRecord;
  }

  public async getSpendSummary(): Promise<SpendSummary> {
    const records = await this.loadRecords();
    const now = new Date();
    
    // Start of Today
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    
    // Start of This Week (Monday)
    const day = now.getDay();
    const diffToMonday = now.getDate() - day + (day === 0 ? -6 : 1);
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), diffToMonday).getTime();

    // Start of This Month
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    let today = 0;
    let thisWeek = 0;
    let thisMonth = 0;
    let total = 0;

    for (const r of records) {
      const cost = r.cost || 0;
      total += cost;
      if (r.timestamp >= startOfToday) {
        today += cost;
      }
      if (r.timestamp >= startOfWeek) {
        thisWeek += cost;
      }
      if (r.timestamp >= startOfMonth) {
        thisMonth += cost;
      }
    }

    return { today, thisWeek, thisMonth, total };
  }

  public async getDistinctProjects(): Promise<string[]> {
    const records = await this.loadRecords();
    const set = new Set<string>();
    for (const r of records) {
      if (r.project) {
        set.add(r.project);
      }
    }
    return Array.from(set);
  }

  public async getDistinctModels(): Promise<string[]> {
    const records = await this.loadRecords();
    const set = new Set<string>();
    for (const r of records) {
      if (r.model) {
        set.add(r.model);
      }
    }
    return Array.from(set);
  }

  public exportCsv(records: UsageAuditRecord[]): string {
    const headers = ['Timestamp', 'Type', 'Project', 'Model', 'Prompt Tokens', 'Completion Tokens', 'Total Tokens', 'Cost (USD)', 'Command', 'CWD'];
    const rows = records.map((r) => [
      new Date(r.timestamp).toISOString(),
      r.type,
      `"${(r.project || '').replace(/"/g, '""')}"`,
      `"${(r.model || '').replace(/"/g, '""')}"`,
      r.promptTokens || 0,
      r.completionTokens || 0,
      r.totalTokens || 0,
      (r.cost || 0).toFixed(6),
      `"${(r.command || '').replace(/"/g, '""')}"`,
      `"${(r.cwd || '').replace(/"/g, '""')}"`,
    ]);

    return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
  }

  public async clearUsageData(): Promise<void> {
    this.inMemoryLog = [];
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.logFilePath || !this.globalStorageUri) {
      return;
    }

    try {
      if (!fs.existsSync(this.globalStorageUri.fsPath)) {
        fs.mkdirSync(this.globalStorageUri.fsPath, { recursive: true });
      }
      fs.writeFileSync(this.logFilePath, JSON.stringify(this.inMemoryLog, null, 2), 'utf8');
    } catch (err) {
      console.error('[UsageStore] Failed to persist usage log:', err);
    }
  }
}
