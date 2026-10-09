import * as vscode from 'vscode';

export interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: Array<{ name: string; dataUrl: string }>;
  model?: string;
  timestamp: number;
  executionDurationMs?: number;
  checkpointId?: string;
  affectedFiles?: string[];
  planDocument?: string;
  walkthroughDocument?: string;
  attachedFile?: {
    name: string;
    uri?: string;
    filePath?: string;
    artifactType?: 'plan' | 'walkthrough';
  };
  isAutoRetry?: boolean;
  isAutoFollowUp?: boolean;
  isIntermediateStep?: boolean;
  userTypedText?: string;
  attachments?: any[];
  totalTokens?: number;
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
  artifactType?: 'plan' | 'walkthrough' | 'standalone';
  artifactMessageId?: string;
  artifactContent?: string;
  lastTotalTokens?: number;
}

export class HistoryStore {
  private static readonly HISTORY_FILE = 'chat_sessions.json';
  private static readonly LEGACY_FILE = 'chat_history.json';
  private static readonly REVIEWER_FILE = 'reviewer_sessions.json';
  private sessions: ChatSession[] = [];
  private activeSessionId: string | null = null;
  private hasLoaded = false;

  private reviewerSessions: ChatSession[] = [];
  private activeReviewerSessionId: string | null = null;
  private hasLoadedReviewer = false;

  constructor(private readonly storageUri?: vscode.Uri) {}

  private _createNewSession(firstMessageSnippet?: string): ChatSession {
    const id = `session-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
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

    if (active && active.lastTotalTokens === undefined && active.messages.length > 0) {
      for (let i = active.messages.length - 1; i >= 0; i--) {
        const t = active.messages[i].totalTokens;
        if (typeof t === 'number' && t > 0) {
          active.lastTotalTokens = t;
          break;
        }
      }
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

    if (typeof message.totalTokens === 'number' && message.totalTokens > 0) {
      active.lastTotalTokens = message.totalTokens;
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

    let msg = active.messages.find((m) => m.id === messageId);
    if (!msg) {
      const idx = this._findMessageIndex(active.messages, messageId);
      if (idx !== -1) msg = active.messages[idx];
    }
    if (msg) {
      if (!msg.checkpointId) {
        msg.checkpointId = checkpointId;
      }
      const existing = msg.affectedFiles ?? [];
      msg.affectedFiles = Array.from(new Set([...existing, ...affectedFiles]));
      active.updatedAt = Date.now();
      await this._saveToDisk();
      return true;
    }
    return false;
  }

  public async setMessageIntermediate(messageId: string, isIntermediate: boolean): Promise<boolean> {
    if (!this.hasLoaded) {
      await this.loadSessions();
    }
    const active = this.sessions.find((s) => s.id === this.activeSessionId);
    if (!active) return false;

    let msg = active.messages.find((m) => m.id === messageId);
    if (!msg) {
      const idx = this._findMessageIndex(active.messages, messageId);
      if (idx !== -1) msg = active.messages[idx];
    }
    if (msg) {
      msg.isIntermediateStep = isIntermediate;
      active.updatedAt = Date.now();
      await this._saveToDisk();
      return true;
    }
    return false;
  }

  public async getMessageById(messageId: string): Promise<StoredChatMessage | undefined> {
    if (!this.hasLoaded) {
      await this.loadSessions();
    }
    const active = this.sessions.find((s) => s.id === this.activeSessionId);
    if (active) {
      let found = active.messages.find((m) => m.id === messageId);
      if (!found) {
        const idx = this._findMessageIndex(active.messages, messageId);
        if (idx !== -1) found = active.messages[idx];
      }
      if (found) return found;
    }
    for (const session of this.sessions) {
      let found = session.messages.find((m) => m.id === messageId);
      if (!found) {
        const idx = this._findMessageIndex(session.messages, messageId);
        if (idx !== -1) found = session.messages[idx];
      }
      if (found) return found;
    }
    return undefined;
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

  public async truncateAfter(messageId: string): Promise<{ success: boolean; removedCount: number; remainingTokens: number }> {
    if (!this.hasLoaded) {
      await this.loadSessions();
    }
    const active = this.sessions.find((s) => s.id === this.activeSessionId);
    if (!active) return { success: false, removedCount: 0, remainingTokens: 0 };
    const idx = this._findMessageIndex(active.messages, messageId);
    if (idx === -1) {
      return { success: false, removedCount: 0, remainingTokens: active.lastTotalTokens ?? 0 };
    }
    const removedCount = active.messages.length - idx;
    if (removedCount <= 0) {
      return { success: true, removedCount: 0, remainingTokens: active.lastTotalTokens ?? 0 };
    }
    active.messages = active.messages.slice(0, idx);
    active.updatedAt = Date.now();

    // Recompute remaining tokens for this session
    let remainingTokens = 0;
    if (active.messages.length > 0) {
      for (let i = active.messages.length - 1; i >= 0; i--) {
        if (typeof active.messages[i].totalTokens === 'number' && active.messages[i].totalTokens! > 0) {
          remainingTokens = active.messages[i].totalTokens!;
          break;
        }
      }
      if (remainingTokens === 0) {
        const totalChars = active.messages.reduce((sum, m) => sum + (m.content || '').length, 0);
        remainingTokens = Math.round(totalChars / 4);
      }
    }
    active.lastTotalTokens = remainingTokens;

    await this._saveToDisk();
    return { success: true, removedCount, remainingTokens };
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

  // --- Reviewer Session Management (PRD Phase 11 Consolidation) ---

  private _createNewReviewerSession(
    titlePrefix = 'Review Session',
    context?: {
      artifactType?: 'plan' | 'walkthrough' | 'standalone';
      artifactMessageId?: string;
      artifactContent?: string;
    }
  ): ChatSession {
    const id = `reviewer-session-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const session: ChatSession = {
      id,
      title: titlePrefix,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      artifactType: context?.artifactType,
      artifactMessageId: context?.artifactMessageId,
      artifactContent: context?.artifactContent,
    };
    this.reviewerSessions.unshift(session);
    this.activeReviewerSessionId = id;
    return session;
  }

  public async loadReviewerSessions(): Promise<{ activeSession: ChatSession; allSessions: ChatSessionMeta[] }> {
    if (!this.hasLoadedReviewer) {
      await this._loadReviewerFromDisk();
      this.hasLoadedReviewer = true;
    }

    if (this.reviewerSessions.length === 0) {
      this._createNewReviewerSession();
    }

    let active = this.reviewerSessions.find((s) => s.id === this.activeReviewerSessionId);
    if (!active) {
      active = this.reviewerSessions[0];
      this.activeReviewerSessionId = active.id;
    }

    const allSessions = this.reviewerSessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
    }));

    return { activeSession: active, allSessions };
  }

  public async switchReviewerSession(sessionId: string): Promise<StoredChatMessage[]> {
    if (!this.hasLoadedReviewer) {
      await this.loadReviewerSessions();
    }
    const found = this.reviewerSessions.find((s) => s.id === sessionId);
    if (found) {
      this.activeReviewerSessionId = found.id;
      return found.messages;
    }
    const { activeSession } = await this.loadReviewerSessions();
    return activeSession.messages;
  }

  public async startNewReviewerSession(
    titlePrefix = 'Review Session',
    context?: {
      artifactType?: 'plan' | 'walkthrough' | 'standalone';
      artifactMessageId?: string;
      artifactContent?: string;
    }
  ): Promise<ChatSession> {
    if (!this.hasLoadedReviewer) {
      await this.loadReviewerSessions();
    }
    const current = this.reviewerSessions.find((s) => s.id === this.activeReviewerSessionId);
    if (current && current.messages.length === 0) {
      current.title = titlePrefix;
      if (context) {
        current.artifactType = context.artifactType;
        current.artifactMessageId = context.artifactMessageId;
        current.artifactContent = context.artifactContent;
      }
      await this._saveReviewerToDisk();
      return current;
    }

    const newSession = this._createNewReviewerSession(titlePrefix, context);
    await this._saveReviewerToDisk();
    return newSession;
  }

  public async saveReviewerSessions(): Promise<void> {
    await this._saveReviewerToDisk();
  }

  /**
   * Clears the active reviewer session's messages and artifact context in-place.
   * Unlike startNewReviewerSession, this reuses the existing session entry so that
   * the sessions list does not accumulate empty entries on every reset.
   */
  public async clearActiveReviewerSession(): Promise<void> {
    if (!this.hasLoadedReviewer) {
      await this.loadReviewerSessions();
    }
    const active = this.reviewerSessions.find((s) => s.id === this.activeReviewerSessionId);
    if (active) {
      active.messages = [];
      active.title = 'Review Session';
      active.artifactContent = undefined;
      active.artifactType = undefined;
      active.artifactMessageId = undefined;
      active.updatedAt = Date.now();
    }
    await this._saveReviewerToDisk();
  }

  public async appendReviewerMessage(message: StoredChatMessage): Promise<void> {
    if (!this.hasLoadedReviewer) {
      await this.loadReviewerSessions();
    }

    let active = this.reviewerSessions.find((s) => s.id === this.activeReviewerSessionId);
    if (!active) {
      active = this._createNewReviewerSession();
    }

    // Auto-update title from first user message if still default generic title
    if (active.title === 'Review Session' && message.role === 'user' && message.content.trim()) {
      active.title = message.content.trim().slice(0, 32).replace(/[\r\n]+/g, ' ');
    }

    if (typeof message.totalTokens === 'number' && message.totalTokens > 0) {
      active.lastTotalTokens = message.totalTokens;
    }

    active.messages.push(message);
    active.updatedAt = Date.now();
    await this._saveReviewerToDisk();
  }

  public async truncateReviewerMessagesAfter(messageId: string): Promise<boolean> {
    if (!this.hasLoadedReviewer) {
      await this.loadReviewerSessions();
    }
    const active = this.reviewerSessions.find((s) => s.id === this.activeReviewerSessionId);
    if (!active) return false;
    const idx = active.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    active.messages = active.messages.slice(0, idx + 1);
    active.updatedAt = Date.now();
    await this._saveReviewerToDisk();
    return true;
  }

  public async updateReviewerMessageContent(messageId: string, newContent: string): Promise<boolean> {
    if (!this.hasLoadedReviewer) {
      await this.loadReviewerSessions();
    }
    const active = this.reviewerSessions.find((s) => s.id === this.activeReviewerSessionId);
    if (!active) return false;
    const msg = active.messages.find((m) => m.id === messageId);
    if (!msg) return false;
    msg.content = newContent;
    active.updatedAt = Date.now();
    await this._saveReviewerToDisk();
    return true;
  }

  public async renameReviewerSession(sessionId: string, newTitle: string): Promise<boolean> {
    if (!this.hasLoadedReviewer) {
      await this.loadReviewerSessions();
    }
    const session = this.reviewerSessions.find((s) => s.id === sessionId);
    if (session) {
      session.title = newTitle.trim().replace(/[\r\n]+/g, ' ') || 'Untitled Review';
      session.updatedAt = Date.now();
      await this._saveReviewerToDisk();
      return true;
    }
    return false;
  }

  public async getReviewerSessionsList(): Promise<ChatSessionMeta[]> {
    const { allSessions } = await this.loadReviewerSessions();
    return allSessions;
  }

  public async deleteReviewerSession(sessionId: string): Promise<boolean> {
    if (!this.hasLoadedReviewer) {
      await this.loadReviewerSessions();
    }
    const initialLen = this.reviewerSessions.length;
    this.reviewerSessions = this.reviewerSessions.filter((s) => s.id !== sessionId);
    if (this.reviewerSessions.length === initialLen) {
      return false;
    }
    if (this.activeReviewerSessionId === sessionId) {
      this.activeReviewerSessionId = this.reviewerSessions.length > 0 ? this.reviewerSessions[0].id : null;
    }
    if (this.reviewerSessions.length === 0) {
      this._createNewReviewerSession();
    }
    await this._saveReviewerToDisk();
    return true;
  }

  public async clearReviewerHistory(): Promise<void> {
    this.reviewerSessions = [];
    this.activeReviewerSessionId = null;
    this._createNewReviewerSession();
    await this._saveReviewerToDisk();
  }

  private async _loadReviewerFromDisk(): Promise<void> {
    if (!this.storageUri) return;

    const reviewerUri = vscode.Uri.joinPath(this.storageUri, HistoryStore.REVIEWER_FILE);
    try {
      const data = await vscode.workspace.fs.readFile(reviewerUri);
      const json = JSON.parse(new TextDecoder().decode(data));
      if (Array.isArray(json)) {
        this.reviewerSessions = json;
        if (this.reviewerSessions.length > 0) {
          this.activeReviewerSessionId = this.reviewerSessions[0].id;
        }
      }
    } catch {
      this.reviewerSessions = [];
    }
  }

  private async _saveReviewerToDisk(): Promise<void> {
    if (!this.storageUri) return;
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
      const fileUri = vscode.Uri.joinPath(this.storageUri, HistoryStore.REVIEWER_FILE);
      const encoded = new TextEncoder().encode(JSON.stringify(this.reviewerSessions, null, 2));
      await vscode.workspace.fs.writeFile(fileUri, encoded);
    } catch (err) {
      console.error('Failed to save reviewer sessions to disk:', err);
    }
  }
}

