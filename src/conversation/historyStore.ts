import * as vscode from 'vscode';

export interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: Array<{ name: string; dataUrl: string }>;
  model?: string;
  timestamp: number;
  checkpointId?: string;
  affectedFiles?: string[];
}

export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredChatMessage[];
}

export class HistoryStore {
  private static readonly HISTORY_FILE = 'chat_sessions.json';
  private static readonly LEGACY_FILE = 'chat_history.json';
  private sessions: ChatSession[] = [];
  private activeSessionId: string | null = null;
  private hasLoaded = false;

  constructor(private readonly storageUri?: vscode.Uri) {}

  private _createNewSession(firstMessageSnippet?: string): ChatSession {
    const id = `session-${Date.now()}`;
    let title = 'New Chat';
    if (firstMessageSnippet) {
      title = firstMessageSnippet.slice(0, 30).trim() || 'New Chat';
    }
    const session: ChatSession = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    this.sessions.unshift(session);
    this.activeSessionId = id;
    return session;
  }

  public async loadSessions(): Promise<{ activeSession: ChatSession; allSessions: ChatSessionMeta[] }> {
    if (!this.hasLoaded) {
      await this._loadFromDisk();
      this.hasLoaded = true;
    }

    if (this.sessions.length === 0) {
      this._createNewSession();
    }

    let active = this.sessions.find((s) => s.id === this.activeSessionId);
    if (!active) {
      active = this.sessions[0];
      this.activeSessionId = active.id;
    }

    const allSessions = this.sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
    }));

    return { activeSession: active, allSessions };
  }

  public async loadHistory(): Promise<StoredChatMessage[]> {
    const { activeSession } = await this.loadSessions();
    return activeSession.messages;
  }

  public async switchSession(sessionId: string): Promise<StoredChatMessage[]> {
    if (!this.hasLoaded) {
      await this.loadSessions();
    }
    const found = this.sessions.find((s) => s.id === sessionId);
    if (found) {
      this.activeSessionId = found.id;
      return found.messages;
    }
    return this.loadHistory();
  }

  public async startNewSession(): Promise<ChatSession> {
    if (!this.hasLoaded) {
      await this.loadSessions();
    }
    // If the active session is already completely empty, just reuse it
    const current = this.sessions.find((s) => s.id === this.activeSessionId);
    if (current && current.messages.length === 0) {
      return current;
    }

    const newSession = this._createNewSession();
    await this._saveToDisk();
    return newSession;
  }

  public async startNewSessionOnLaunch(): Promise<ChatSession> {
    if (!this.hasLoaded) {
      await this._loadFromDisk();
      this.hasLoaded = true;
    }

    if (this.sessions.length === 0) {
      const s = this._createNewSession();
      await this._saveToDisk();
      return s;
    }

    // If the latest session is already completely empty, reuse it
    const first = this.sessions[0];
    if (first && first.messages.length === 0) {
      this.activeSessionId = first.id;
      return first;
    }

    // Create a fresh new chat session for this launch
    const newSession = this._createNewSession();
    await this._saveToDisk();
    return newSession;
  }

  public async appendMessage(message: StoredChatMessage): Promise<void> {
    if (!this.hasLoaded) {
      await this.loadSessions();
    }

    let active = this.sessions.find((s) => s.id === this.activeSessionId);
    if (!active) {
      active = this._createNewSession(message.role === 'user' ? message.content : undefined);
    }

    // Auto-update title from first user message if still "New Chat"
    if (active.title === 'New Chat' && message.role === 'user' && message.content.trim()) {
      active.title = message.content.trim().slice(0, 32).replace(/[\r\n]+/g, ' ');
    }

    active.messages.push(message);
    active.updatedAt = Date.now();

    await this._saveToDisk();
  }

  public async tagTurnCheckpoint(messageId: string, checkpointId: string, affectedFiles: string[]): Promise<boolean> {
    if (!this.hasLoaded) {
      await this.loadSessions();
    }

    const active = this.sessions.find((s) => s.id === this.activeSessionId);
    if (!active) return false;

    const msg = active.messages.find((m) => m.id === messageId);
    if (msg) {
      msg.checkpointId = checkpointId;
      msg.affectedFiles = affectedFiles;
      active.updatedAt = Date.now();
      await this._saveToDisk();
      return true;
    }
    return false;
  }

  private _findMessageIndex(messages: StoredChatMessage[], messageId: string): number {
    let idx = messages.findIndex((m) => m.id === messageId);
    if (idx !== -1) return idx;

    const tsMatch = messageId.match(/^(\d+)/);
    if (tsMatch) {
      const targetTs = parseInt(tsMatch[1], 10);
      idx = messages.findIndex(
        (m) => m.role === 'user' && Math.abs((m.timestamp || 0) - targetTs) < 15000
      );
    }
    return idx;
  }

  public async getMessagesAfter(messageId: string): Promise<StoredChatMessage[]> {
    if (!this.hasLoaded) {
      await this.loadSessions();
    }
    const active = this.sessions.find((s) => s.id === this.activeSessionId);
    if (!active) return [];
    const idx = this._findMessageIndex(active.messages, messageId);
    if (idx === -1) return [];
    return active.messages.slice(idx + 1);
  }

  public async truncateAfter(messageId: string): Promise<{ success: boolean; removedCount: number }> {
    if (!this.hasLoaded) {
      await this.loadSessions();
    }
    const active = this.sessions.find((s) => s.id === this.activeSessionId);
    if (!active) return { success: false, removedCount: 0 };
    const idx = this._findMessageIndex(active.messages, messageId);
    if (idx === -1) {
      return { success: false, removedCount: 0 };
    }
    const removedCount = active.messages.length - idx;
    if (removedCount <= 0) {
      return { success: true, removedCount: 0 };
    }
    active.messages = active.messages.slice(0, idx);
    active.updatedAt = Date.now();
    await this._saveToDisk();
    return { success: true, removedCount };
  }

  public async renameSession(sessionId: string, newTitle: string): Promise<boolean> {
    if (!this.hasLoaded) {
      await this.loadSessions();
    }
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session) {
      const trimmed = newTitle.trim().replace(/[\r\n]+/g, ' ');
      session.title = trimmed || 'Untitled Chat';
      session.updatedAt = Date.now();
      await this._saveToDisk();
      return true;
    }
    return false;
  }

  public async deleteSession(sessionId: string): Promise<void> {
    if (!this.hasLoaded) {
      await this.loadSessions();
    }
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions.length > 0 ? this.sessions[0].id : null;
    }
    if (this.sessions.length === 0) {
      this._createNewSession();
    }
    await this._saveToDisk();
  }

  public async clearHistory(): Promise<void> {
    // Clears all chat sessions completely
    this.sessions = [];
    this.activeSessionId = null;
    this._createNewSession();
    await this._saveToDisk();
  }

  private async _loadFromDisk(): Promise<void> {
    if (!this.storageUri) {
      return;
    }

    const sessionsUri = vscode.Uri.joinPath(this.storageUri, HistoryStore.HISTORY_FILE);
    try {
      const data = await vscode.workspace.fs.readFile(sessionsUri);
      const json = JSON.parse(new TextDecoder().decode(data));
      if (Array.isArray(json)) {
        this.sessions = json;
        if (this.sessions.length > 0) {
          this.activeSessionId = this.sessions[0].id;
        }
        return;
      }
    } catch {
      // Sessions file doesn't exist yet, check for legacy single history file
    }

    // Migration from legacy chat_history.json
    try {
      const legacyUri = vscode.Uri.joinPath(this.storageUri, HistoryStore.LEGACY_FILE);
      const legData = await vscode.workspace.fs.readFile(legacyUri);
      const legJson = JSON.parse(new TextDecoder().decode(legData));
      if (Array.isArray(legJson) && legJson.length > 0) {
        const legacySession: ChatSession = {
          id: `session-migrated-${Date.now()}`,
          title: legJson[0]?.content ? legJson[0].content.slice(0, 30) : 'Previous Chat',
          createdAt: legJson[0]?.timestamp || Date.now(),
          updatedAt: Date.now(),
          messages: legJson,
        };
        this.sessions = [legacySession];
        this.activeSessionId = legacySession.id;
        await this._saveToDisk();
      }
    } catch {
      this.sessions = [];
    }
  }

  private async _saveToDisk(): Promise<void> {
    if (!this.storageUri) return;
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
      const fileUri = vscode.Uri.joinPath(this.storageUri, HistoryStore.HISTORY_FILE);
      const encoded = new TextEncoder().encode(JSON.stringify(this.sessions, null, 2));
      await vscode.workspace.fs.writeFile(fileUri, encoded);
    } catch (err) {
      console.error('Failed to save chat sessions to disk:', err);
    }
  }
}

