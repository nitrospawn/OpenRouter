import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SecretStore } from '../auth/secretStore';
import { OpenRouterClient, OpenRouterModel, ChatMessageContentPart, ProviderRoutingOptions } from '../api/openrouterClient';
import { detectModelCapabilities } from '../api/modelCapabilities';
import { HistoryStore } from '../conversation/historyStore';
import { Configuration } from '../settings/configuration';
import { PermissionManager } from '../permissions/permissionManager';
import { DiffPreviewManager } from '../editor/diffPreview';
import { ContextReader } from '../editor/contextReader';
import { TerminalOutputTracker } from '../terminal/terminalOutputTracker';
import { CommandRunner } from '../terminal/commandRunner';
import { ShadowRepo } from '../shadowGit/shadowRepo';
import { CheckpointManager } from '../shadowGit/checkpoint';
import { ScopedRestore } from '../shadowGit/restore';
import { HostToWebviewMessage, WebviewToHostMessage, AttachedFileRef } from './messages';
import { SecretScanner } from '../privacy/secretScanner';
import { DiagnosticManager, StructuredDiagnostic } from '../diagnostics/diagnosticManager';
import { logger } from '../logger';

import { UsageStore } from '../usage/usageStore';
import { PricingCalculator } from '../api/pricing';
import { ProjectResolver } from '../usage/projectResolver';
import { buildSystemPrompt, FileBatchMetadata } from '../prompt/systemPrompt';
import { ChunkManager } from '../editor/chunkManager';
import { extractArtifacts } from '../prompt/responseParser';
import { ArtifactDocumentManager } from '../editor/artifactDocumentManager';
import { ReviewerCommentController } from '../comments/reviewerCommentController';
import { EXTENSION_VERSION } from '../version';

export class OpenRouterPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openrouter.chatView';

  private _view?: vscode.WebviewView;
  private _cachedModels: OpenRouterModel[] = [];
  private _shadowRepo?: ShadowRepo;
  private _checkpointManager?: CheckpointManager;
  private _scopedRestore?: ScopedRestore;
  private _activeAbortController?: AbortController;
  private _isUserCancelled: boolean = false;
  private _reviewerCommentController?: ReviewerCommentController;
  private _reviewerHistory: Array<{ role: 'user' | 'assistant'; content: string; attachedFile?: AttachedFileRef; executionDurationMs?: number }> = [];
  private _activeReviewerAbortController?: AbortController;
  private _isReviewerUserCancelled: boolean = false;
  private _activeReviewerModelOverride?: string;
  private _activeReviewerReasoningEffortOverride?: string;
  private _lastReviewerUserPrompt?: string;
  private _activeReviewerArtifactContent?: string;
  private _activeReviewerArtifactType?: 'plan' | 'walkthrough';
  private _activeReviewerArtifactName?: string;
  private _activeReasoningEffort?: string;
  private _currentTurnUserMessageId?: string;

  private async _tagCurrentTurnCheckpoint(checkpointId: string, files: string[]): Promise<void> {
    if (!checkpointId || !files || files.length === 0) return;
    try {
      const history = await this._historyStore.loadHistory();
      let targetMsg = this._currentTurnUserMessageId
        ? history.find((m) => m.id === this._currentTurnUserMessageId)
        : undefined;

      if (!targetMsg) {
        targetMsg = [...history].reverse().find(
          (m) => m.role === 'user' || m.id.endsWith('-user') || m.id.endsWith('-followup')
        );
      }

      if (targetMsg) {
        const existing = targetMsg.affectedFiles ?? [];
        const merged = Array.from(new Set([...existing, ...files]));
        await this._historyStore.tagTurnCheckpoint(targetMsg.id, checkpointId, merged);
        logger.info(
          'SHADOW_GIT',
          `Tagged turn message ${targetMsg.id} with checkpoint ${checkpointId.substring(0, 7)} (files: [${merged.join(', ')}])`
        );
      }
    } catch (err) {
      console.warn('[panelProvider] Failed to tag turn checkpoint:', err);
      logger.warn('SHADOW_GIT', `Failed to tag turn checkpoint ${checkpointId?.substring(0, 7)}: ${err}`);
    }
  }

  private _appliedEditCheckpoints: Array<{
    filePath: string;
    normalizedPath: string;
    checkpointId?: string;
    originalContent: string;
    editId?: string;
    timestamp: number;
  }> = [];

  private _trackAppliedEdit(filePath: string, checkpointId: string | undefined, originalContent: string, editId?: string) {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    this._appliedEditCheckpoints.push({
      filePath,
      normalizedPath: normalized,
      checkpointId,
      originalContent,
      editId,
      timestamp: Date.now(),
    });
    if (this._appliedEditCheckpoints.length > 50) {
      this._appliedEditCheckpoints.shift();
    }
  }

  private async _revertAppliedEdit(filePath?: string, editId?: string): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return false;
    }

    let idx = -1;
    if (editId) {
      for (let i = this._appliedEditCheckpoints.length - 1; i >= 0; i--) {
        if (this._appliedEditCheckpoints[i].editId === editId) {
          idx = i;
          break;
        }
      }
    }
    if (idx === -1 && filePath) {
      const norm = filePath.replace(/\\/g, '/').toLowerCase();
      for (let i = this._appliedEditCheckpoints.length - 1; i >= 0; i--) {
        const item = this._appliedEditCheckpoints[i];
        if (item.normalizedPath === norm || item.normalizedPath.endsWith(norm) || norm.endsWith(item.normalizedPath)) {
          idx = i;
          break;
        }
      }
    }

    if (idx === -1) {
      logger.warn('REVERT', `No pre-edit snapshot found for ${filePath || editId}`);
      return false;
    }

    const tracked = this._appliedEditCheckpoints[idx];
    this._appliedEditCheckpoints.splice(idx, 1);

    const targetFilePath = tracked.filePath;
    const fileUri = path.isAbsolute(targetFilePath)
      ? vscode.Uri.file(targetFilePath)
      : vscode.Uri.joinPath(workspaceFolders[0].uri, targetFilePath);

    let restored = false;

    // 1. Try scoped restore from shadow-git commit if available
    if (tracked.checkpointId && this._scopedRestore) {
      try {
        const res = await this._scopedRestore.restore(tracked.checkpointId, [targetFilePath], true);
        if (res.success) {
          restored = true;
          logger.info('REVERT', `Scoped restore successful for ${targetFilePath} from checkpoint ${tracked.checkpointId.substring(0, 7)}`);
        }
      } catch (err) {
        logger.warn('REVERT', `Scoped restore failed, falling back to original content write: ${err}`);
      }
    }

    // 2. Direct writeback of originalContent snapshot (fail-safe)
    if (!restored) {
      if (tracked.originalContent === '') {
        try {
          await vscode.workspace.fs.delete(fileUri, { useTrash: false });
          restored = true;
          logger.info('REVERT', `Deleted newly created file ${targetFilePath} on revert`);
        } catch {
          try {
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(fileUri, encoder.encode(''));
            restored = true;
          } catch (err) {
            logger.error('REVERT', `Failed to delete or empty ${targetFilePath}: ${err}`);
          }
        }
      } else {
        try {
          const encoder = new TextEncoder();
          await vscode.workspace.fs.writeFile(fileUri, encoder.encode(tracked.originalContent));
          restored = true;
          logger.info('REVERT', `Restored ${targetFilePath} directly from originalContent snapshot`);
        } catch (err) {
          logger.error('REVERT', `Failed to write back original content for ${targetFilePath}: ${err}`);
        }
      }
    }

    // 3. Sync live VS Code document buffer so the editor instantly reverts on screen
    try {
      const openDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri && d.uri.fsPath.toLowerCase() === fileUri.fsPath.toLowerCase()
      );
      if (openDoc) {
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          openDoc.positionAt(0),
          openDoc.positionAt(openDoc.getText().length)
        );
        edit.replace(openDoc.uri, fullRange, tracked.originalContent);
        await vscode.workspace.applyEdit(edit);
        await openDoc.save();
      }
    } catch {
      // ignore
    }

    return restored;
  }

  private _extractFilesMutatedByCommand(command: string, workspaceRoot?: string): string[] {
    const affected: string[] = [];

    // 1. Redirections: > file, >> file (handling quotes and unquoted paths)
    const redirRegex = /(?:>>|>)\s*(?:["']([^"'\r\n]+)["']|([^\s;&|"'`]+))/g;
    let match;
    while ((match = redirRegex.exec(command)) !== null) {
      const rawPath = (match[1] || match[2] || '').trim();
      if (rawPath && !['&1', '&2', 'nul', '/dev/null', 'con'].includes(rawPath.toLowerCase())) {
        affected.push(rawPath);
      }
    }

    // 2. PowerShell cmdlets: Set-Content, Out-File, Add-Content, sc, ac
    const psRegex = /(?:Set-Content|Out-File|Add-Content|sc|ac)\s+(?:-(?:Path|FilePath|LiteralPath)\s+)?(?:["']([^"'\r\n]+)["']|([^\s;&|"'`]+))/gi;
    while ((match = psRegex.exec(command)) !== null) {
      const rawPath = (match[1] || match[2] || '').trim();
      if (rawPath && !['&1', '&2', 'nul', '/dev/null', 'con'].includes(rawPath.toLowerCase())) {
        affected.push(rawPath);
      }
    }

    // 3. POSIX/Unix utilities: tee, touch
    const posixRegex = /(?:tee(?:\s+-a)?|touch)\s+(?:["']([^"'\r\n]+)["']|([^\s;&|"'`]+))/gi;
    while ((match = posixRegex.exec(command)) !== null) {
      const rawPath = (match[1] || match[2] || '').trim();
      if (rawPath && !['&1', '&2', 'nul', '/dev/null', 'con'].includes(rawPath.toLowerCase())) {
        affected.push(rawPath);
      }
    }

    // 4. sed -i
    const sedRegex = /sed\s+(?:-i|--in-place)(?:[^\s;]+)?\s+["'].*?["']\s+(?:["']([^"'\r\n]+)["']|([^\s;&|"'`]+))/gi;
    while ((match = sedRegex.exec(command)) !== null) {
      const rawPath = (match[1] || match[2] || '').trim();
      if (rawPath && !['&1', '&2', 'nul', '/dev/null', 'con'].includes(rawPath.toLowerCase())) {
        affected.push(rawPath);
      }
    }

    // Filter & sanitize
    return Array.from(new Set(affected)).filter((f) => {
      if (f.startsWith('..')) return false;
      if (path.isAbsolute(f) && workspaceRoot && (path.relative(workspaceRoot, f).startsWith('..') || path.isAbsolute(path.relative(workspaceRoot, f)))) return false;
      if (f.includes('globalStorage') || f.includes('log-today.txt') || f.includes('usage_audit_log.json')) return false;
      return true;
    });
  }

  private _formatTerminalExecutionSummary(
    commands: Array<{ command: string; outcome: string; exitCode: number | null; output: string; timedOut?: boolean; cancelled?: boolean }>
  ): string {
    const total = commands.length;
    const allOk = commands.every((c) => c.exitCode === 0 && !c.timedOut && !c.cancelled);
    let summaryText = '';
    if (total === 1) {
      const c = commands[0];
      const cmdShort = c.command.length > 40 ? c.command.slice(0, 37) + '...' : c.command;
      summaryText = `Ran terminal command: \`${cmdShort}\` ${c.outcome}`;
    } else {
      const failedCount = commands.filter((c) => c.exitCode !== 0 || c.timedOut).length;
      const outcomeText = allOk ? 'all completed, exit code: 0' : `${total - failedCount} completed, ${failedCount} failed`;
      summaryText = `Ran ${total} terminal commands (${outcomeText})`;
    }

    let body = `<!-- terminal-run-summary:start -->\n`;
    body += `✓ **Ran in terminal:** ${summaryText}\n`;
    for (const c of commands) {
      body += `\n$ ${c.command}\n`;
      if (c.output) {
        body += `\`\`\`\n${c.output}\n\`\`\`\n`;
      }
    }
    body += `<!-- terminal-run-summary:end -->`;
    return body;
  }

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _secretStore: SecretStore,
    private readonly _historyStore: HistoryStore,
    private readonly _permissionManager: PermissionManager,
    private readonly _usageStore: UsageStore,
    private readonly _storageUri?: vscode.Uri
  ) {
    this._reviewerCommentController = new ReviewerCommentController();
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (_storageUri && workspaceFolders && workspaceFolders.length > 0) {
      this._shadowRepo = new ShadowRepo(_storageUri, workspaceFolders[0].uri);
      this._checkpointManager = new CheckpointManager(this._shadowRepo);
      this._scopedRestore = new ScopedRestore(this._shadowRepo);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data: WebviewToHostMessage) => {
      switch (data.type) {
        case 'READY':
          await this._refreshAuthState();
          await this._historyStore.startNewSessionOnLaunch();
          await this._loadChatHistory();
          await this._sendSessionsData();
          await this.sendSettingsData();
          break;

        case 'SUBMIT_API_KEY': {
          const result = await this._secretStore.storeApiKey(data.apiKey);
          if (result.success) {
            vscode.window.showInformationMessage('OpenRouter API key saved successfully!');
            await this._refreshAuthState();
          } else {
            vscode.window.showErrorMessage(`Validation failed: ${result.error}`);
            this._postMessage({
              type: 'ERROR',
              message: result.error || 'Invalid API key',
            });
            await this._refreshAuthState();
          }
          break;
        }

        case 'SELECT_MODEL': {
          logger.info('USER', `User selected model: ${data.modelId}`);
          await Configuration.setLastModel(data.modelId);
          const model = this._cachedModels.find((m) => m.id === data.modelId);
          const capabilities = detectModelCapabilities(model);
          this._postMessage({
            type: 'SET_SELECTED_MODEL',
            modelId: data.modelId,
            capabilities,
          });
          break;
        }

        case 'REFRESH_MODELS': {
          logger.info('USER', 'User refreshed models list');
          const key = await this._secretStore.getApiKey();
          if (key) {
            this._cachedModels = [];
            await this._loadModels(key);
          }
          break;
        }

        case 'SEND_MESSAGE': {
          logger.info('USER', `User submitted prompt (${data.content?.length ?? 0} chars, model: ${data.modelId || 'default'}${data.attachments?.length ? `, ${data.attachments.length} attachments` : ''})`);
          logger.info('CHAT', `User message sent — model: ${data.modelId || 'default'}, est tokens: ~${Math.round((data.content || '').length / 4)}`);
          if (data.reasoningEffort) {
            this._activeReasoningEffort = data.reasoningEffort;
          }
          const userText = (data.content || '').trim();
          let isExecutionIntent = /^(?:proceed(?: with (?:the )?plan)?|continue(?: with (?:the )?plan)?|please continue|implement(?: the plan)?|execute(?: the plan)?|go ahead(?: and (?:proceed|execute|implement))?|carry on|start(?: (?:the )?plan)?|do it|approved?|apply (?:the )?plan|yes(?: please)?(?:,? (?:proceed|continue|go ahead|do it))?|ok(?:,? (?:proceed|continue|go ahead|do it))?)[.! ]*$/i.test(userText);

          if (!isExecutionIntent && this._historyStore) {
            try {
              const hist = await this._historyStore.loadHistory();
              const hasActivePlan = hist.some(
                (m) => m.role === 'assistant' && (m.planDocument || /```plan/i.test(m.content))
              );
              const lastAssistantMsg = [...hist].reverse().find((m) => m.role === 'assistant');
              const hasWalkthrough = Boolean(
                lastAssistantMsg?.walkthroughDocument || (lastAssistantMsg?.content && /```walkthrough/i.test(lastAssistantMsg.content))
              );
              if (hasActivePlan && !hasWalkthrough) {
                if (/^(?:yes|yep|yeah|sure|ok|okay|next|continue|go|carry on|proceed|do this|start)[.! ]*$/i.test(userText)) {
                  isExecutionIntent = true;
                }
              }
            } catch {
              // non-fatal
            }
          }

          const initialRetryContext = isExecutionIntent
            ? { retryCount: 0, failedCommands: new Set<string>(), autoTurnCount: 0, isAutoFollowUp: true }
            : undefined;
          await this._handleSendMessage(
            data.content,
            data.modelId,
            data.images,
            data.messageId,
            data.reasoningEffort || this._activeReasoningEffort,
            initialRetryContext,
            data.isRetry,
            data.userTypedText,
            data.attachments
          );
          break;
        }

        case 'STOP_STREAM':
          logger.info('USER', 'User stopped model stream mid-flight');
          this._isUserCancelled = true;
          if (this._activeAbortController) {
            this._activeAbortController.abort();
          }
          this._postMessage({ type: 'SET_BUSY', busy: false });
          break;

        case 'PREVIEW_DIFF': {
          logger.info('USER', `User opened diff preview for: ${data.filePath}`);
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            const fileUri = path.isAbsolute(data.filePath)
              ? vscode.Uri.file(data.filePath)
              : vscode.Uri.joinPath(workspaceFolders[0].uri, data.filePath);
            await DiffPreviewManager.openDiffPreview(fileUri, data.newContent);
          }
          break;
        }

        case 'VIEW_ARTIFACT': {
          logger.info('USER', `User opened artifact document: ${data.artifactType}${data.messageId ? ` (message: ${data.messageId})` : ''}`);
          await ArtifactDocumentManager.openArtifactDocument(
            this._historyStore,
            data.artifactType,
            data.messageId,
            data.content,
            this._storageUri
          );
          break;
        }

        case 'START_REVIEW': {
          await this._handleStartReview(data.artifactType, data.messageId, data.content);
          break;
        }

        case 'OPEN_DIRECT_REVIEWER': {
          await this._handleOpenDirectReviewer();
          break;
        }

        case 'SEND_REVIEWER_MESSAGE': {
          await this._handleSendReviewerMessage(
            data.content,
            data.modelId,
            data.reasoningEffort,
            data.artifactContent,
            data.artifactType,
            data.attachedFile
          );
          break;
        }

        case 'RETRY_REVIEWER_MESSAGE': {
          await this._handleRetryReviewerMessage();
          break;
        }

        case 'GET_REVIEWER_SESSIONS': {
          await this._sendReviewerSessionsData();
          break;
        }

        case 'NEW_REVIEWER_SESSION': {
          await this._historyStore.startNewReviewerSession('Standalone Review');
          await this._handleOpenDirectReviewer();
          break;
        }

        case 'SWITCH_REVIEWER_SESSION': {
          const msgs = await this._historyStore.switchReviewerSession(data.sessionId);
          this._reviewerHistory = msgs.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
            attachedFile: m.attachedFile,
            executionDurationMs: m.executionDurationMs,
          }));
          await this._sendReviewerSessionsData();
          const { activeSession } = await this._historyStore.loadReviewerSessions();
          if (activeSession.artifactContent && (activeSession.artifactType === 'plan' || activeSession.artifactType === 'walkthrough')) {
            this._activeReviewerArtifactContent = activeSession.artifactContent;
            this._activeReviewerArtifactType = activeSession.artifactType;
          } else {
            this._activeReviewerArtifactContent = undefined;
            this._activeReviewerArtifactType = undefined;
          }
          const reviewerModel = this._activeReviewerModelOverride || Configuration.getReviewerModel();
          const reviewerReasoningEffort = this._activeReviewerReasoningEffortOverride || Configuration.getReviewerReasoningEffort();
          this._postMessage({
            type: 'REVIEWER_VIEW_DATA',
            artifactType: activeSession.artifactType || 'standalone',
            artifactContent: activeSession.artifactContent || '',
            reviewerModel,
            reviewerReasoningEffort,
            history: [...this._reviewerHistory],
            activeSessionId: activeSession.id,
          });
          break;
        }

        case 'RENAME_REVIEWER_SESSION': {
          await this._historyStore.renameReviewerSession(data.sessionId, data.newTitle);
          await this._sendReviewerSessionsData();
          break;
        }

        case 'DELETE_REVIEWER_SESSION': {
          await this._historyStore.deleteReviewerSession(data.sessionId);
          await this._sendReviewerSessionsData();
          break;
        }

        case 'RESET_REVIEWER_CONTEXT': {
          // Manual "Start fresh from here": Clear the active session's messages in-place
          // rather than creating a new session, to avoid accumulating empty sessions.
          this._reviewerHistory = [];
          this._activeReviewerArtifactContent = undefined;
          this._activeReviewerArtifactType = undefined;
          this._activeReviewerArtifactName = undefined;
          await this._historyStore.clearActiveReviewerSession();
          await this._handleOpenDirectReviewer();
          break;
        }

        case 'STOP_REVIEWER_STREAM': {
          this._isReviewerUserCancelled = true;
          if (this._activeReviewerAbortController) {
            this._activeReviewerAbortController.abort();
          }
          this._postMessage({ type: 'SET_REVIEWER_BUSY', busy: false });
          break;
        }

        case 'ACCEPT_EDIT': {
          logger.info('USER', `User accepted change to: ${data.filePath} (editId: ${data.editId})`);
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            const fileUri = path.isAbsolute(data.filePath)
              ? vscode.Uri.file(data.filePath)
              : vscode.Uri.joinPath(workspaceFolders[0].uri, data.filePath);

            let fileExists = true;
            try {
              await vscode.workspace.fs.stat(fileUri);
            } catch {
              fileExists = false;
            }

            const relativePath = vscode.workspace.asRelativePath(fileUri);

            // Step 0: Check if this edit was already optimistically applied
            const existingTracked = this._appliedEditCheckpoints.find(
              (item) => item.editId === data.editId
            );
            let checkpointId: string | undefined = existingTracked?.checkpointId;

            let currentContent = '';
            if (fileExists) {
              try {
                const fileData = await vscode.workspace.fs.readFile(fileUri);
                currentContent = new TextDecoder('utf-8').decode(fileData);
              } catch {
                // ignore
              }
            }

            let resolvedContent = '';
            try {
              resolvedContent = DiffPreviewManager.resolveProposedContent(currentContent, data.newContent);
            } catch {
              resolvedContent = data.newContent;
            }

            const normalizedCurrent = currentContent.replace(/\r\n/g, '\n');
            const normalizedResolved = resolvedContent.replace(/\r\n/g, '\n');
            const isAlreadyApplied = Boolean(existingTracked) || (fileExists && normalizedCurrent === normalizedResolved);

            if (isAlreadyApplied) {
              logger.info('EDIT', `Edit ${data.editId} for ${relativePath} is already applied on disk (no-op write)`);
              if (checkpointId) {
                await this._tagCurrentTurnCheckpoint(checkpointId, [data.filePath]);
              }
              this._postMessage({
                type: 'EDIT_APPLIED',
                editId: data.editId,
                success: true,
                checkpointId,
                filePath: data.filePath,
              });
              break;
            }

            // Step 1: Gate with consolidated permission check BEFORE creating checkpoints or touching disk
            const permStatus = await this._permissionManager.checkApplyEditPermission(
              relativePath,
              !fileExists
            );

            if (permStatus === 'denied') {
              this._postMessage({
                type: 'EDIT_APPLIED',
                editId: data.editId,
                success: false,
              });
              break;
            }

            // Step 2: Create a shadow-git checkpoint of the affected file before applying the edit
            if (this._checkpointManager) {
              const res = await this._checkpointManager.createCheckpoint(
                [data.filePath],
                `Before edit ${data.editId}`
              );
              if (res) {
                checkpointId = res;
              }
            }

            let originalContent = '';
            try {
              const fileData = await vscode.workspace.fs.readFile(fileUri);
              originalContent = new TextDecoder('utf-8').decode(fileData);
            } catch {
              // ignore
            }

            // Step 3: Apply the workspace edit (skipPermissionCheck: true because already checked and approved above)
            const success = await DiffPreviewManager.applyEdit(
              fileUri,
              data.newContent,
              this._permissionManager,
              true
            );

            // Step 4: Tag the current turn with this checkpoint so the undo
            // icon in the user message header is always-visible and scoped to this turn.
            if (checkpointId && success) {
              await this._tagCurrentTurnCheckpoint(checkpointId, [data.filePath]);
              this._trackAppliedEdit(data.filePath, checkpointId, originalContent, data.editId);
            }

            // Open edited file into independent editor tab with preserveFocus
            if (success) {
              logger.info('EDIT', `Applied ✓ ${relativePath}${checkpointId ? ` (checkpoint: ${checkpointId.substring(0, 7)})` : ''}`);
              try {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
              } catch {
                // non-fatal
              }
            } else {
              logger.error('EDIT', `FAILED to apply edit: ${relativePath}`);
            }

            this._postMessage({
              type: 'EDIT_APPLIED',
              editId: data.editId,
              success,
              checkpointId,
              filePath: data.filePath,
            });
          }
          break;
        }

        case 'ACCEPT_ALL_EDITS': {
          logger.info('USER', `User accepted all proposed edits (${data.edits?.length ?? 0} files)`);
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0 && data.edits.length > 0) {
            // Step 1: Check permissions upfront before checkpoint or file system operations
            const editPerm = this._permissionManager.getPermission('applyEdit');
            if (editPerm === 'deny') {
              vscode.window.showErrorMessage('Applying edits is currently disabled in OpenRouter permissions.');
              for (const edit of data.edits) {
                this._postMessage({
                  type: 'EDIT_APPLIED',
                  editId: edit.editId,
                  success: false,
                });
              }
              break;
            }

            const resolvedEdits = await Promise.all(
              data.edits.map(async (edit) => {
                const fileUri = path.isAbsolute(edit.filePath)
                  ? vscode.Uri.file(edit.filePath)
                  : vscode.Uri.joinPath(workspaceFolders[0].uri, edit.filePath);
                let fileExists = true;
                try {
                  await vscode.workspace.fs.stat(fileUri);
                } catch {
                  fileExists = false;
                }
                return {
                  edit,
                  fileUri,
                  fileExists,
                  relativePath: vscode.workspace.asRelativePath(fileUri),
                };
              })
            );

            // If any edit is a new file, check createDeleteFiles permission
            const anyNewFile = resolvedEdits.some((e) => !e.fileExists);
            if (anyNewFile) {
              const createPerm = this._permissionManager.getPermission('createDeleteFiles');
              if (createPerm === 'deny') {
                vscode.window.showErrorMessage('Creating files is currently disabled in OpenRouter permissions.');
                for (const edit of data.edits) {
                  this._postMessage({
                    type: 'EDIT_APPLIED',
                    editId: edit.editId,
                    success: false,
                  });
                }
                break;
              }
            }

            // If applyEdit is 'ask', prompt user once for the bulk operation
            if (editPerm === 'ask') {
              const fileCount = data.edits.length;
              const choice = await vscode.window.showWarningMessage(
                `OpenRouter wants to apply edits to ${fileCount} file${fileCount > 1 ? 's' : ''}.`,
                { modal: true },
                'Apply All',
                'Apply All for this Session',
                'Deny'
              );
              if (choice === 'Deny' || !choice) {
                vscode.window.showInformationMessage('Bulk edit cancelled.');
                for (const edit of data.edits) {
                  this._postMessage({
                    type: 'EDIT_APPLIED',
                    editId: edit.editId,
                    success: false,
                  });
                }
                break;
              }
              if (choice === 'Apply All for this Session') {
                await this._permissionManager.setPermission('applyEdit', 'allow_session');
                if (anyNewFile) {
                  await this._permissionManager.setPermission('createDeleteFiles', 'allow_session');
                }
              }
            }

            const affectedFiles = data.edits.map((e) => e.filePath);

            // Step 2: Create a single unified shadow-git checkpoint for all affected files
            let checkpointId: string | undefined;
            if (this._checkpointManager) {
              const res = await this._checkpointManager.createCheckpoint(
                affectedFiles,
                `Before bulk edit (${affectedFiles.length} files)`
              );
              if (res) {
                checkpointId = res;
              }
            }

            // Step 3: Apply each edit sequentially with skipPermissionCheck = true
            for (const item of resolvedEdits) {
              logger.info('USER', `Applying bulk edit to: ${item.relativePath}`);
              logger.info('FILE', `Writing to file: ${item.relativePath}`);
              let origContent = '';
              try {
                const fileData = await vscode.workspace.fs.readFile(item.fileUri);
                origContent = new TextDecoder('utf-8').decode(fileData);
              } catch {
                // ignore
              }

              const success = await DiffPreviewManager.applyEdit(
                item.fileUri,
                item.edit.newContent,
                this._permissionManager,
                true
              );

              if (success) {
                this._trackAppliedEdit(item.edit.filePath, checkpointId, origContent, item.edit.editId);
              }

              this._postMessage({
                type: 'EDIT_APPLIED',
                editId: item.edit.editId,
                success,
                checkpointId, // All edits share this common checkpointId for unified per-turn undo
                filePath: item.edit.filePath,
              });
            }

            // Step 4: Tag the current turn with the unified checkpoint
            if (checkpointId) {
              await this._tagCurrentTurnCheckpoint(checkpointId, affectedFiles);
            }

            // Auto-trigger continuation if an active plan is underway and not yet completed
            if (this._historyStore) {
              try {
                const hist = await this._historyStore.loadHistory();
                const hasActivePlan = hist.some(
                  (m) => m.role === 'assistant' && (m.planDocument || /```plan/i.test(m.content))
                );
                const lastAssistantMsg = [...hist].reverse().find((m) => m.role === 'assistant');
                const hasWalkthrough = Boolean(
                  lastAssistantMsg?.walkthroughDocument || (lastAssistantMsg?.content && /```walkthrough/i.test(lastAssistantMsg.content))
                );
                if (hasActivePlan && !hasWalkthrough && !this._activeAbortController?.signal.aborted) {
                  const targetModel = Configuration.getLastModel() || 'openai/gpt-4o-mini';
                  const fileNames = affectedFiles.map((f) => path.basename(f)).join(', ');
                  const continuationPrompt = `Applied edits to ${fileNames} successfully. Please proceed directly with the next step in the implementation plan without pausing for confirmation, or provide the final walkthrough if all steps are complete.`;
                  await this._handleSendMessage(
                    continuationPrompt,
                    targetModel,
                    undefined,
                    undefined,
                    this._activeReasoningEffort,
                    {
                      retryCount: 0,
                      failedCommands: new Set<string>(),
                      autoTurnCount: 1,
                      isAutoFollowUp: true,
                    }
                  );
                }
              } catch {
                // non-fatal
              }
            }
          }
          break;
        }

        case 'UNDO_TURN': {
          console.log('[panelProvider] Received UNDO_TURN request:', data);
          if (!this._scopedRestore || !this._checkpointManager) {
            console.warn('[panelProvider] UNDO_TURN unavailable: missing scopedRestore or checkpointManager');
            this._postMessage({
              type: 'UNDO_RESULT',
              checkpointId: data.checkpointId,
              messageId: data.messageId,
              success: false,
              message: 'Undo unavailable: no workspace storage active.',
            });
            break;
          }

          // 1. Look up target message in historyStore to resolve checkpointId & affectedFiles if missing from payload
          const targetMsg = await this._historyStore.getMessageById(data.messageId);
          let checkpointId = data.checkpointId || targetMsg?.checkpointId || '';

          const messagesAfter = await this._historyStore.getMessagesAfter(data.messageId);
          const n = messagesAfter.length;
          console.log('[panelProvider] getMessagesAfter returned count:', n, 'for target messageId:', data.messageId);

          // Gather affected files across this turn and any subsequent turns being rolled back
          const affectedFilesSet = new Set<string>(data.affectedFiles || []);
          if (targetMsg?.affectedFiles) {
            for (const f of targetMsg.affectedFiles) {
              affectedFilesSet.add(f);
            }
          }
          for (const m of messagesAfter) {
            if (m.affectedFiles) {
              for (const f of m.affectedFiles) {
                affectedFilesSet.add(f);
              }
            }
            if (!checkpointId && m.checkpointId) {
              checkpointId = m.checkpointId;
            }
          }
          const targetFiles = Array.from(affectedFilesSet);

          // Confirmation dialog (supports both turns with subsequent messages and turns stopped mid-flight)
          const msgCountText = n > 0
            ? `${n} later message${n === 1 ? '' : 's'}`
            : 'this turn';
          const confirmChoice = await vscode.window.showWarningMessage(
            `This will undo this change and remove ${msgCountText} from this chat — this cannot be undone. Continue?`,
            { modal: true },
            'Continue',
            'Cancel'
          );

          if (confirmChoice !== 'Continue') {
            this._postMessage({
              type: 'UNDO_RESULT',
              checkpointId,
              messageId: data.messageId,
              success: false,
              message: 'Cancelled',
            });
            break;
          }

          // User activity logging
          logger.info(
            'USER',
            `User triggered Undo on turn ${data.messageId}${checkpointId ? ` (checkpoint: ${checkpointId.substring(0, 7)})` : ''} - reverting ${targetFiles.length} file(s), removing ${n} subsequent message(s)`
          );

          // 2. Drift Detection
          const filesSummary = targetFiles.length === 1
            ? targetFiles[0]
            : `${targetFiles.length} files (${targetFiles.join(', ')})`;

          let restoreSuccess = false;
          if (targetFiles.length > 0 && checkpointId) {
            const res = await this._scopedRestore.restore(checkpointId, targetFiles, false);
            if (res.drifted) {
              const driftChoice = await vscode.window.showWarningMessage(
                `One or more files (${filesSummary}) have been manually modified since this AI edit. Undo anyway and overwrite manual changes?`,
                { modal: true },
                'Undo Anyway',
                'Cancel'
              );

              if (driftChoice === 'Undo Anyway') {
                const forced = await this._scopedRestore.restore(checkpointId, targetFiles, true);
                restoreSuccess = forced.success;
              } else {
                // Cancelled drift warning — ABORT immediately without touching files or history
                this._postMessage({
                  type: 'UNDO_RESULT',
                  checkpointId,
                  messageId: data.messageId,
                  success: false,
                  message: 'Cancelled',
                });
                break;
              }
            } else {
              restoreSuccess = res.success;
            }
          } else {
            // Conversational-only turn or no modified files
            restoreSuccess = true;
          }

          // 3. Scoped File Restore Verification
          if (!restoreSuccess) {
            this._postMessage({
              type: 'UNDO_RESULT',
              checkpointId,
              messageId: data.messageId,
              success: false,
              message: 'Failed to revert workspace files.',
            });
            break;
          }

          // 4. Update shadow repo HEAD ref to target checkpoint
          if (this._shadowRepo && checkpointId) {
            try {
              await this._shadowRepo.runGit(['update-ref', 'HEAD', checkpointId]);
              logger.info('SHADOW_GIT', `Updated shadow repo HEAD to checkpoint ${checkpointId.substring(0, 7)}`);
            } catch (err) {
              console.warn('[PanelProvider] Could not update shadow git HEAD:', err);
              logger.warn('SHADOW_GIT', `Failed to update shadow repo HEAD to ${checkpointId.substring(0, 7)}: ${err}`);
            }
          }
          logger.info(
            'SHADOW_GIT',
            `Undo turn completed: reverted ${targetFiles.length} file(s) to checkpoint ${checkpointId.substring(0, 7)}`
          );

          // 5. Only NOW truncate historyStore (removes data.messageId itself and any subsequent messages)
          const truncResult = await this._historyStore.truncateAfter(data.messageId);

          // 6. Post success to Webview UI
          this._postMessage({
            type: 'UNDO_RESULT',
            checkpointId,
            messageId: data.messageId,
            truncatedAfterId: data.messageId,
            remainingTokens: truncResult.remainingTokens ?? 0,
            success: true,
            message: 'Reverted and chat truncated',
          });
          break;
        }


        case 'OPEN_FILE': {
          logger.info('USER', `User opened file: ${data.filePath}`);
          let targetPath = (data.filePath || '').trim().replace(/^["']|["']$/g, '');
          if (!targetPath) break;

          // Extract optional line / column suffix (e.g. file.ts:42, file.ts:42:5, file.ts#L42)
          let targetLine: number | undefined;
          let targetCol: number | undefined;
          const lineMatch = targetPath.match(/(?::(\d+)(?::(\d+))?|#L(\d+))$/i);
          if (lineMatch) {
            targetLine = parseInt(lineMatch[1] || lineMatch[3], 10);
            if (lineMatch[2]) targetCol = parseInt(lineMatch[2], 10);
            targetPath = targetPath.slice(0, lineMatch.index);
          }

          let fileUri: vscode.Uri | undefined;

          // 1. Handle file:// URI
          if (targetPath.startsWith('file://')) {
            try {
              fileUri = vscode.Uri.parse(targetPath);
            } catch {
              fileUri = undefined;
            }
          } else if (path.isAbsolute(targetPath)) {
            // 2. Absolute path on disk
            const normalized = path.normalize(targetPath);
            if (fs.existsSync(normalized)) {
              fileUri = vscode.Uri.file(normalized);
            }
          }

          const workspaceFolders = vscode.workspace.workspaceFolders || [];

          // 3. Check direct resolution against workspace roots
          if (!fileUri && workspaceFolders.length > 0) {
            for (const folder of workspaceFolders) {
              const candidate = path.resolve(folder.uri.fsPath, targetPath);
              if (fs.existsSync(candidate)) {
                fileUri = vscode.Uri.file(candidate);
                break;
              }
            }
          }

          // 4. Windows path missing drive letter (e.g. Users\HP\...)
          if (!fileUri && process.platform === 'win32' && /^[\\/]?[uU]sers[\\/]/.test(targetPath)) {
            const withDrive = 'C:\\' + targetPath.replace(/^[\\/]/, '');
            if (fs.existsSync(withDrive)) {
              fileUri = vscode.Uri.file(withDrive);
            }
          }

          // 5. Search workspace files if relative or bare filename
          if (!fileUri && workspaceFolders.length > 0) {
            const baseName = path.basename(targetPath);
            if (baseName && baseName.length > 1) {
              try {
                const matches = await vscode.workspace.findFiles(`**/${baseName}`, '**/node_modules/**', 20);
                if (matches.length === 1) {
                  fileUri = matches[0];
                } else if (matches.length > 1) {
                  // If targetPath has directory segments, try to find exact suffix match first
                  const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase();
                  const exactSuffixMatch = matches.filter((u) =>
                    u.fsPath.replace(/\\/g, '/').toLowerCase().endsWith(normalizedTarget)
                  );
                  if (exactSuffixMatch.length === 1) {
                    fileUri = exactSuffixMatch[0];
                  } else {
                    // Multiple files match! Prompt user with QuickPick to disambiguate
                    const items = (exactSuffixMatch.length > 0 ? exactSuffixMatch : matches).map((u) => {
                      const relPath = vscode.workspace.asRelativePath(u);
                      return {
                        label: `$(file) ${path.basename(u.fsPath)}`,
                        description: relPath,
                        uri: u,
                      };
                    });
                    const selected = await vscode.window.showQuickPick(items, {
                      placeHolder: `Multiple files named "${baseName}" found. Select which to open:`,
                    });
                    if (selected) {
                      fileUri = selected.uri;
                    } else {
                      // User cancelled the picker
                      break;
                    }
                  }
                }
              } catch {
                // non-fatal
              }
            }
          }

          // 6. If target path was absolute but didn't exist directly on disk:
          if (!fileUri && path.isAbsolute(targetPath)) {
            fileUri = vscode.Uri.file(targetPath);
          }

          // 7. Verify existence and open or warn
          if (fileUri && fs.existsSync(fileUri.fsPath)) {
            try {
              const stat = fs.statSync(fileUri.fsPath);
              if (stat.isDirectory()) {
                await vscode.commands.executeCommand('revealInExplorer', fileUri);
                vscode.window.setStatusBarMessage(`Folder revealed in Explorer: ${path.basename(fileUri.fsPath)}`, 3500);
              } else {
                const showOptions: vscode.TextDocumentShowOptions = {
                  preview: false,
                  preserveFocus: false,
                };
                if (targetLine && targetLine > 0) {
                  const pos = new vscode.Position(targetLine - 1, targetCol ? Math.max(0, targetCol - 1) : 0);
                  showOptions.selection = new vscode.Range(pos, pos);
                }
                await vscode.commands.executeCommand('vscode.open', fileUri, showOptions);
              }
            } catch (err) {
              try {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
              } catch {
                vscode.window.showErrorMessage(`Could not open file: ${targetPath}`);
              }
            }
          } else {
            vscode.window.showWarningMessage(`File does not exist: ${targetPath}`);
          }
          break;
        }

        case 'REJECT_EDIT': {
          logger.info('USER', `User rejected change to: ${data.filePath || 'file'} (editId: ${data.editId})`);
          const targetPath = data.filePath || '';
          logger.info('FILE', `Reverting file: ${targetPath || 'file'} from pre-edit snapshot`);
          const reverted = await this._revertAppliedEdit(targetPath, data.editId);

          const fileName = targetPath ? path.basename(targetPath) : 'file';
          if (reverted) {
            const revertedMsg = {
              id: `${Date.now()}-reverted-${data.editId}`,
              role: 'assistant' as const,
              content: `↩️ **Reverted:** undone changes to \`${fileName}\``,
              timestamp: Date.now(),
            };
            if (this._historyStore?.appendMessage) {
              await this._historyStore.appendMessage(revertedMsg);
            }
            this._postMessage({
              type: 'MESSAGE_RECEIVED',
              message: revertedMsg,
            });
            vscode.window.setStatusBarMessage(`Reverted changes to ${fileName}`, 4000);
          }

          this._postMessage({
            type: 'EDIT_REVERTED',
            editId: data.editId,
            filePath: data.filePath,
          });
          break;
        }

        case 'RUN_TERMINAL': {
          logger.info('USER', `User ran terminal command: ${data.command}`);
          const terminalAbort = new AbortController();
          this._activeAbortController = terminalAbort;
          this._postMessage({
            type: 'SET_BUSY',
            busy: true,
            statusText: `Running in terminal: ${data.command.length > 35 ? data.command.slice(0, 32) + '...' : data.command}`,
          });
          this._postMessage({ type: 'TERMINAL_RUNNING', command: data.command });
          let shouldTriggerContinuation = false;
          let followUpPrompt = '';

          const isReadOnlyCmd = CommandRunner.isReadOnly(data.command);
          let cmdCheckpointId: string | null = null;
          let cmdAffectedFiles: string[] = [];
          const workspaceFolders = vscode.workspace.workspaceFolders;
          const root = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : '';
          const preCommandSnapshots: Map<string, { uri: vscode.Uri; existed: boolean; content: string }> = new Map();

          if (!isReadOnlyCmd) {
            cmdAffectedFiles = this._extractFilesMutatedByCommand(data.command, root);
            if (workspaceFolders && workspaceFolders.length > 0) {
              for (const f of cmdAffectedFiles) {
                const fileUri = path.isAbsolute(f) ? vscode.Uri.file(f) : vscode.Uri.joinPath(workspaceFolders[0].uri, f);
                let existed = false;
                let content = '';
                try {
                  const fileBytes = await vscode.workspace.fs.readFile(fileUri);
                  content = new TextDecoder('utf-8').decode(fileBytes);
                  existed = true;
                } catch {
                  existed = false;
                }
                preCommandSnapshots.set(f, { uri: fileUri, existed, content });
              }
            }

            if (cmdAffectedFiles.length > 0 && this._checkpointManager) {
              cmdCheckpointId = await this._checkpointManager.createCheckpoint(
                cmdAffectedFiles,
                `Before terminal command: ${data.command.slice(0, 40)}`
              );
              if (cmdCheckpointId) {
                await this._tagCurrentTurnCheckpoint(cmdCheckpointId, cmdAffectedFiles);
              }
            }
          }

          try {
            const result = await CommandRunner.executeCommand(
              data.command,
              this._permissionManager,
              this._usageStore,
              {
                interactiveInTerminal: (data as any).interactive,
                abortSignal: terminalAbort.signal,
              }
            );
            this._postMessage({
              type: 'TERMINAL_RESULT',
              command: data.command,
              exitCode: result.exitCode ?? null,
              stdout: result.stdout ?? '',
              stderr: result.stderr ?? '',
              executed: result.executed,
              cancelled: result.cancelled,
              timedOut: result.timedOut,
              error: result.error,
            });

            if (!result.cancelled) {
              const applyEditPerm = this._permissionManager.getPermission('applyEdit');
              if (cmdAffectedFiles.length > 0 && preCommandSnapshots.size > 0) {
                let fileIdx = 0;
                for (const [filePath, snap] of preCommandSnapshots.entries()) {
                  fileIdx++;
                  let existsNow = false;
                  let currentContent = '';
                  try {
                    const dataBytes = await vscode.workspace.fs.readFile(snap.uri);
                    currentContent = new TextDecoder('utf-8').decode(dataBytes);
                    existsNow = true;
                  } catch {
                    existsNow = false;
                  }

                  const wasMutated = (!snap.existed && existsNow) ||
                    (snap.existed && !existsNow) ||
                    (snap.existed && existsNow && currentContent !== snap.content);

                  if (wasMutated) {
                    const editId = `term-edit-${Date.now()}-${fileIdx}`;
                    this._trackAppliedEdit(filePath, cmdCheckpointId ?? undefined, snap.content, editId);
                    if (cmdCheckpointId) {
                      await this._tagCurrentTurnCheckpoint(cmdCheckpointId, [filePath]);
                    }

                    if (applyEditPerm === 'ask') {
                      this._postMessage({
                        type: 'PROPOSE_EDIT',
                        editId,
                        edit: {
                          filePath,
                          newContent: currentContent,
                          diffExplanation: `Modified via terminal command: ${data.command.slice(0, 50)}`,
                        },
                      });
                    } else if (applyEditPerm === 'allow' || applyEditPerm === 'allow_session') {
                      this._postMessage({
                        type: 'EDIT_APPLIED',
                        editId,
                        success: true,
                        checkpointId: cmdCheckpointId ?? undefined,
                        filePath,
                      });
                    }
                  }
                }
              }

              let outcome = '(failed)';
              if (result.timedOut) {
                outcome = '(timed out after 120s)';
              } else if (result.executed) {
                outcome = result.exitCode === 0
                  ? '(completed, exit code: 0)'
                  : `(failed with exit code: ${result.exitCode ?? 'unknown'})`;
              }

              const rawSnippet = (result.stdout || result.stderr || result.error || '').trim();
              const truncatedSnippet = rawSnippet.length > 1500
                ? rawSnippet.substring(0, 1500) + '\n... [output truncated]'
                : rawSnippet;

              const snippetBlock = truncatedSnippet
                ? `\n\`\`\`\n${truncatedSnippet}\n\`\`\``
                : '';

              const termMsgContent = data.command.includes('\n')
                ? `✓ **Ran in terminal:** ${outcome}\n${data.command}${snippetBlock}`
                : `✓ **Ran in terminal:** \`${data.command}\` ${outcome}${snippetBlock}`;

              const termMsg = {
                id: `${Date.now()}-term-manual`,
                role: 'system' as const,
                content: termMsgContent,
                timestamp: Date.now(),
              };
              if (this._historyStore?.appendMessage) {
                await this._historyStore.appendMessage(termMsg);
              }
              this._postMessage({
                type: 'MESSAGE_RECEIVED',
                message: termMsg,
              });

              if (result.exitCode === 0 && !result.timedOut) {
                followUpPrompt = `The terminal command \`${data.command}\` was executed with output:\n\`\`\`\n${truncatedSnippet}\n\`\`\`\nPlease proceed with the next step in the implementation plan, or provide the final walkthrough if all steps are complete.`;
              } else {
                followUpPrompt = `The terminal command \`${data.command}\` failed (${outcome}).\nOutput:\n\`\`\`\n${truncatedSnippet}\n\`\`\`\nPlease diagnose this error, generate necessary file edits to fix it, or provide a corrected command.`;
              }
              shouldTriggerContinuation = true;
            }
          } finally {
            if (!shouldTriggerContinuation) {
              if (this._activeAbortController === terminalAbort) {
                this._activeAbortController = undefined;
              }
              this._postMessage({ type: 'SET_BUSY', busy: false });
            }
          }

          if (shouldTriggerContinuation && followUpPrompt) {
            const targetModel = Configuration.getLastModel() || 'openai/gpt-4o-mini';
            await this._handleSendMessage(
              followUpPrompt,
              targetModel,
              undefined,
              undefined,
              this._activeReasoningEffort,
              {
                retryCount: 0,
                failedCommands: new Set<string>(),
                autoTurnCount: 1,
                isAutoFollowUp: true,
              }
            );
          }
          break;
        }

        case 'GET_USAGE_REPORT':
          await this._sendUsageReportData();
          break;

        case 'EXPORT_USAGE_CSV': {
          const csv = this._usageStore.exportCsv(data.records);
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`openrouter-usage-${new Date().toISOString().slice(0, 10)}.csv`),
            filters: { 'CSV Files': ['csv'] },
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(csv));
            vscode.window.showInformationMessage(`Exported usage report to ${uri.fsPath}`);
          }
          break;
        }

        case 'GET_SETTINGS':
          await this._sendSettingsData();
          break;

        case 'SET_PANEL_POSITION': {
          await Configuration.setPanelPosition(data.position);
          await this._sendSettingsData();

          if (data.position === 'right') {
            await vscode.commands.executeCommand('workbench.action.showAuxiliaryBar');
            vscode.window
              .showInformationMessage(
                'To dock OpenRouter on the right: Right-click the OpenRouter (✨) icon or header and select "Move to Secondary Side Bar" (or drag the icon to the right).',
                'Focus Secondary Bar'
              )
              .then((choice) => {
                if (choice === 'Focus Secondary Bar') {
                  vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
                }
              });
          } else {
            vscode.window.showInformationMessage(
              'To dock OpenRouter back on the left: Right-click the OpenRouter (✨) icon on the right side and choose "Reset Location".'
            );
          }
          break;
        }

        case 'SET_DEFAULT_MODEL':
          await Configuration.setLastModel(data.modelId);
          await this._sendSettingsData();
          vscode.window.showInformationMessage(`Default model updated.`);
          break;

        case 'TOGGLE_PERMISSION': {
          const current = this._permissionManager.getPermission(data.category as any);
          const next = current === 'allow' ? 'ask' : current === 'ask' ? 'deny' : 'allow';
          logger.info('USER', `User changed permission for ${data.category} to: ${next}`);
          await this._permissionManager.setPermission(data.category as any, next);
          await this._sendSettingsData();
          break;
        }

        case 'RESET_PERMISSIONS':
          logger.info('USER', 'User reset all permissions to default');
          this._permissionManager.resetAll();
          await this._sendSettingsData();
          vscode.window.showInformationMessage('All permissions reset to default.');
          break;

        case 'SET_CONTEXT_SETTING':
          if (data.key === 'autoSummarize') {
            await Configuration.setAutoSummarize(data.value);
          } else {
            await Configuration.setFullHistoryResend(data.value);
          }
          await this._sendSettingsData();
          break;

        case 'SET_PRIVACY_SETTING':
          if (data.key === 'redactionMode') {
            await Configuration.setRedactionMode(data.value);
          } else if (data.key === 'dataCollectionPolicy') {
            await Configuration.setDataCollectionPolicy(data.value);
            // Refresh models view with updated ZDR filter visibility
            const key = await this._secretStore.getApiKey();
            if (key) {
              await this._loadModels(key);
            }
          } else if (data.key === 'warnOnDataTraining') {
            await Configuration.setWarnOnDataTraining(data.value);
          }
          await this._sendSettingsData();
          break;

        case 'SET_REVIEWER_SETTING':
          if (data.key === 'enabled') {
            await Configuration.setReviewerEnabled(data.value);
          } else if (data.key === 'model') {
            await Configuration.setReviewerModel(data.value);
          } else if (data.key === 'reasoningEffort') {
            await Configuration.setReviewerReasoningEffort(data.value);
          } else if (data.key === 'systemPrompt') {
            await Configuration.setReviewerSystemPrompt(data.value);
          }
          await this._sendSettingsData();
          break;

        case 'RESET_REVIEWER_PROMPT':
          await Configuration.resetReviewerSystemPrompt();
          await this._sendSettingsData();
          break;

        case 'PROMPT_UPDATE_KEY': {
          const updated = await this._secretStore.promptForApiKey();
          if (updated) {
            await this._sendSettingsData();
            await this._refreshAuthState();
          }
          break;
        }

        case 'TRIGGER_CLEAR_HISTORY':
          await vscode.commands.executeCommand('openrouter.clearHistory');
          break;

        case 'VIEW_LOGS':
          logger.info('USER', 'User opened diagnostic logs');
          await vscode.commands.executeCommand('openrouter.openDiagnosticLog');
          break;

        case 'OPEN_SETTINGS':
          await this._sendSettingsData();
          break;

        case 'CLEAR_HISTORY':
          logger.info('USER', 'User cleared chat history');
          await this._historyStore.clearHistory();
          await this._loadChatHistory();
          await this._sendSessionsData();
          break;

        case 'CLEAR_API_KEY':
          await this._secretStore.clearApiKey();
          await this._refreshAuthState();
          break;

        case 'GET_SESSIONS':
          await this._sendSessionsData();
          break;

        case 'NEW_SESSION':
          logger.info('USER', 'User started a new chat session');
          await this._historyStore.startNewSession();
          await this._loadChatHistory();
          await this._sendSessionsData();
          break;

        case 'SWITCH_SESSION':
          logger.info('USER', `User switched to chat session: ${data.sessionId}`);
          await this._historyStore.switchSession(data.sessionId);
          await this._loadChatHistory();
          await this._sendSessionsData();
          break;

        case 'RENAME_SESSION':
          logger.info('USER', `User renamed session ${data.sessionId} to: "${data.newTitle}"`);
          await this._historyStore.renameSession(data.sessionId, data.newTitle);
          await this._sendSessionsData();
          break;

        case 'DELETE_SESSION':
          logger.info('USER', `User deleted chat session: ${data.sessionId}`);
          await this._historyStore.deleteSession(data.sessionId);
          await this._loadChatHistory();
          await this._sendSessionsData();
          break;
      }
    });
  }

  private async _sendSettingsData(): Promise<void> {
    await this.sendSettingsData();
  }

  public async sendSettingsData(): Promise<void> {
    const apiKey = await this._secretStore.getApiKey();
    let apiKeyMasked = 'Not set';
    if (apiKey) {
      if (apiKey.length > 10) {
        apiKeyMasked = `${apiKey.slice(0, 5)}••••••••${apiKey.slice(-4)}`;
      } else {
        apiKeyMasked = '••••••••';
      }
    }

    const panelPosition = Configuration.getPanelPosition();
    const defaultModel = Configuration.getLastModel() || (this._cachedModels[0]?.id ?? '');
    const permissions = this._permissionManager.getAllStates();
    const autoSummarize = Configuration.getAutoSummarize();
    const fullHistoryResend = Configuration.getFullHistoryResend();
    const redactionMode = Configuration.getRedactionMode();
    const dataCollectionPolicy = Configuration.getDataCollectionPolicy();
    const warnOnDataTraining = Configuration.getWarnOnDataTraining();
    const reviewerEnabled = Configuration.getReviewerEnabled();
    const reviewerModel = Configuration.getReviewerModel();
    const reviewerReasoningEffort = Configuration.getReviewerReasoningEffort();
    const reviewerSystemPrompt = Configuration.getReviewerSystemPrompt();

    const formatted = this._cachedModels.map((m) => {
      // Model supports ZDR if top_provider does not allow data collection or explicit support flag
      const supportsZdr = m.top_provider?.allow_data_collection === false || m.supports_zdr === true;
      const caps = detectModelCapabilities(m);
      return {
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        pricing: m.pricing,
        supports_zdr: supportsZdr,
        supports_reasoning_effort: caps.supportsReasoningEffort,
        supported_reasoning_efforts: caps.supportedReasoningEfforts,
        supports_vision: caps.supportsVision,
      };
    });

    this._postMessage({
      type: 'SETTINGS_DATA',
      apiKeyMasked,
      panelPosition,
      defaultModel,
      permissions,
      autoSummarize,
      fullHistoryResend,
      redactionMode,
      dataCollectionPolicy,
      warnOnDataTraining,
      models: formatted,
      reviewerEnabled,
      reviewerModel,
      reviewerReasoningEffort,
      reviewerSystemPrompt,
    });
  }

  public async refresh() {
    await this._refreshAuthState();
  }

  public insertInputText(text: string, append = false) {
    this._postMessage({
      type: 'INSERT_INPUT_TEXT',
      text,
      append,
    });
  }

  public async sendDirectPrompt(prompt: string) {
    await this._handleSendMessage(prompt, Configuration.getLastModel());
  }

  private async _loadChatHistory() {
    const { activeSession } = await this._historyStore.loadSessions();
    this._postMessage({
      type: 'HISTORY_LOADED',
      activeSessionId: activeSession.id,
      lastTotalTokens: activeSession.lastTotalTokens,
      messages: activeSession.messages
        .filter((h) => !h.isAutoFollowUp && !(h.role === 'system' && typeof h.content === 'string' && h.content.startsWith('✓ **Ran in terminal:')))
        .map((h) => ({
          id: h.id,
          role: h.role,
          content: h.content,
          images: h.images,
          timestamp: h.timestamp,
          executionDurationMs: h.executionDurationMs,
          checkpointId: h.checkpointId,
          affectedFiles: h.affectedFiles,
          planDocument: h.planDocument,
          walkthroughDocument: h.walkthroughDocument,
          totalTokens: h.totalTokens,
          model: h.model,
          isAutoRetry: h.isAutoRetry,
          isAutoFollowUp: h.isAutoFollowUp,
          isIntermediateStep: h.isIntermediateStep,
          userTypedText: h.userTypedText,
          attachments: h.attachments,
        })),
    });
  }

  private async _sendSessionsData() {
    const { activeSession, allSessions } = await this._historyStore.loadSessions();
    this._postMessage({
      type: 'SESSIONS_LOADED',
      sessions: allSessions,
      activeSessionId: activeSession.id,
    });
  }

  private async _refreshAuthState() {
    if (!this._view) return;

    const apiKey = await this._secretStore.getApiKey();
    const hasKey = Boolean(apiKey);

    this._postMessage({
      type: 'AUTH_STATE',
      hasKey,
    });

    if (hasKey && apiKey) {
      await this._loadModels(apiKey);
    }
  }

  private async _loadModels(apiKey: string) {
    try {
      if (this._cachedModels.length === 0) {
        this._cachedModels = await OpenRouterClient.fetchModels(apiKey);
      }

      const dataPolicy = Configuration.getDataCollectionPolicy();
      const enforceZdr = dataPolicy === 'deny';

      let hiddenZdrCount = 0;
      const formatted = this._cachedModels.map((m) => {
        // A model is considered ZDR-supporting if top_provider disallows data collection
        // or if it doesn't default to open data training
        const supportsZdr = m.top_provider?.allow_data_collection === false || m.supports_zdr === true;
        if (!supportsZdr && enforceZdr) {
          hiddenZdrCount++;
        }
        const caps = detectModelCapabilities(m);
        return {
          id: m.id,
          name: m.name,
          context_length: m.context_length,
          pricing: m.pricing,
          supports_zdr: supportsZdr,
          supports_reasoning_effort: caps.supportsReasoningEffort,
          supported_reasoning_efforts: caps.supportedReasoningEfforts,
          supports_vision: caps.supportsVision,
        };
      });

      this._postMessage({
        type: 'MODELS_LOADED',
        models: formatted,
        hiddenZdrCount,
      });

      const lastModel = Configuration.getLastModel() || (formatted[0]?.id ?? '');
      if (lastModel) {
        const found = this._cachedModels.find((m) => m.id === lastModel);
        const capabilities = detectModelCapabilities(found);
        const supportsZdr = found?.top_provider?.allow_data_collection === false || found?.supports_zdr === true;
        this._postMessage({
          type: 'SET_SELECTED_MODEL',
          modelId: lastModel,
          capabilities,
          supportsZdr,
        });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Failed to fetch models';
      this._postMessage({
        type: 'ERROR',
        message: errMsg,
      });
    }
  }

  private async _handleSendMessage(
    content: string,
    modelId: string,
    images?: Array<{ name: string; dataUrl: string }>,
    clientMessageId?: string,
    reasoningEffort?: string,
    retryContext?: { retryCount: number; failedCommands: Set<string>; autoTurnCount?: number; isAutoFollowUp?: boolean; emptyRetryCount?: number },
    isRetry?: boolean,
    userTypedText?: string,
    attachments?: any[]
  ) {
    const apiKey = await this._secretStore.getApiKey();
    if (!apiKey) {
      vscode.window.showErrorMessage('No OpenRouter API key found. Please save your key first.');
      return;
    }

    const isNewUserTurn = !retryContext?.isAutoFollowUp && (retryContext?.retryCount ?? 0) === 0;
    if (isNewUserTurn) {
      // Genuine user-initiated turn: reset the cancel flag and arm a fresh controller.
      this._isUserCancelled = false;
      this._activeAbortController = new AbortController();
    } else {
      // Auto-follow-up / retry turn: honour a stop that arrived before we got here.
      if (this._isUserCancelled || this._activeAbortController?.signal.aborted) {
        this._postMessage({ type: 'SET_BUSY', busy: false });
        return;
      }
      // Create the new controller first, then immediately check whether Stop arrived
      // in the tiny window between the flag check above and now (race condition fix).
      this._activeAbortController = new AbortController();
      if (this._isUserCancelled) {
        // Stop fired between the flag check and controller swap — abort the new one too.
        this._activeAbortController.abort();
        this._postMessage({ type: 'SET_BUSY', busy: false });
        return;
      }
    }

    const selectedModel = modelId || Configuration.getLastModel() || 'openai/gpt-4o-mini';

    // Phase 8: Diagnostics Token Expansion (@current_problems / @all_problems)
    let processedContent = content;
    const hasCurrentProblemsToken = /@current_problems\b/i.test(content);
    const hasAllProblemsToken = /@all_problems\b/i.test(content);

    if (hasCurrentProblemsToken || hasAllProblemsToken) {
      const includeWarnings = Configuration.getDiagnosticsIncludeWarnings();
      let diagnostics: StructuredDiagnostic[] = [];
      let scopeLabel = '';

      if (hasAllProblemsToken) {
        scopeLabel = 'Entire Workspace';
        const perm = this._permissionManager.getPermission('readWorkspaceFiles');
        if (perm === 'deny') {
          vscode.window.showErrorMessage(
            'Cannot expand @all_problems: Access to workspace files is disabled in OpenRouter permissions.'
          );
          return;
        }
        diagnostics = DiagnosticManager.getAllWorkspaceDiagnostics(this._permissionManager, includeWarnings);
      } else {
        scopeLabel = 'Current File';
        const perm = this._permissionManager.getPermission('readActiveContext');
        if (perm === 'deny') {
          vscode.window.showErrorMessage(
            'Cannot expand @current_problems: Reading active file context is disabled in OpenRouter permissions.'
          );
          return;
        }
        diagnostics = DiagnosticManager.getCurrentFileDiagnostics(this._permissionManager, includeWarnings);
      }

      if (diagnostics.length === 0) {
        vscode.window.showInformationMessage(`OpenRouter: No active diagnostic errors found in ${scopeLabel}.`);
      }

      // Format diagnostic expansion text
      let expansionText = DiagnosticManager.formatBulkProblemsPrompt(diagnostics, scopeLabel);
      let estimatedTokens = DiagnosticManager.estimateDiagnosticTokens(expansionText, diagnostics.length);

      // Payload-size safeguard check
      const threshold = Configuration.getDiagnosticsMaxTokensThreshold();
      const currentModelObj = this._cachedModels.find((m) => m.id === selectedModel);
      const modelContextLimit = currentModelObj?.context_length || 128000;
      const contextPercentage = (estimatedTokens / modelContextLimit) * 100;

      if (estimatedTokens > threshold || contextPercentage > 40 || diagnostics.length > 150) {
        const warningMsg = `OpenRouter Diagnostics Safeguard: Including ${diagnostics.length} problems (~${estimatedTokens.toLocaleString()} tokens, ${contextPercentage.toFixed(1)}% of model context) may exceed reasonable prompt limits.`;
        const action = await vscode.window.showWarningMessage(
          warningMsg,
          { modal: true },
          'Send Anyway',
          'Filter to Errors Only',
          'Cancel'
        );

        if (action === 'Cancel' || !action) {
          return; // Abort without clearing user input
        }

        if (action === 'Filter to Errors Only') {
          diagnostics = diagnostics.filter((d) => d.diagnostic.severity === vscode.DiagnosticSeverity.Error);
          expansionText = DiagnosticManager.formatBulkProblemsPrompt(diagnostics, `${scopeLabel} (Errors Only)`);
        }
      }

      if (hasAllProblemsToken) {
        processedContent = processedContent.replace(/@all_problems\b/gi, expansionText);
      } else {
        processedContent = processedContent.replace(/@current_problems\b/gi, expansionText);
      }
    }

    // Check Editor Context
    const editorCtx = ContextReader.getActiveEditorContext(this._permissionManager);

    // Save user message (stores the user's visible text in history)
    const isAutoRetry = Boolean(retryContext && retryContext.retryCount > 0);
    const isAutoFollowUp = Boolean(retryContext?.isAutoFollowUp);
    const userMsgRecord = {
      id: clientMessageId || `${Date.now()}-${isAutoRetry ? 'retry' : isAutoFollowUp ? 'followup' : 'user'}`,
      role: (isAutoRetry || isAutoFollowUp) ? ('system' as const) : ('user' as const),
      content: processedContent,
      images,
      model: selectedModel,
      timestamp: Date.now(),
      isAutoRetry,
      isAutoFollowUp,
      userTypedText,
      attachments,
    };
    this._currentTurnUserMessageId = userMsgRecord.id;

    if (!isRetry) {
      await this._historyStore.appendMessage(userMsgRecord);

      if (!clientMessageId && !isAutoFollowUp) {
        this._postMessage({
          type: 'MESSAGE_RECEIVED',
          message: userMsgRecord,
        });
      }
    }

    const assistantMessageId = `${Date.now()}-assistant`;
    this._postMessage({ type: 'SET_BUSY', busy: true, statusText: 'Loading workspace files...' });
    this._postMessage({ type: 'MESSAGE_STREAM_START', messageId: assistantMessageId, model: selectedModel });
    this._postMessage({ type: 'AGENT_PROGRESS', phase: 'loading', label: 'Loading workspace files' });
    // Build context-aware prompt messages
    const history = await this._historyStore.loadHistory();
    const currentModelObj = this._cachedModels.find((m) => m.id === selectedModel);
    const modelContextLimit = currentModelObj?.context_length || 128000;

    const chatMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatMessageContentPart[] }> = [];

    // Workspace file tree injection so the assistant knows about all files in the project
    const workspaceFiles = await ContextReader.listWorkspaceFiles(this._permissionManager);

    // Dynamic model context window calculation & token budgeting
    const historyTokenEstimate = history.reduce(
      (acc, h) => {
        let count = typeof h.content === 'string' ? ChunkManager.estimateTokens(h.content) : 0;
        if (h.planDocument) {
          count += ChunkManager.estimateTokens(h.planDocument);
        }
        if (h.walkthroughDocument) {
          count += ChunkManager.estimateTokens(h.walkthroughDocument);
        }
        return acc + count;
      },
      0
    );
    const availableFileTokens = ChunkManager.calculateAvailableFileTokens(
      modelContextLimit,
      historyTokenEstimate
    );

    logger.info('AGENT', `Turn start — model: ${selectedModel}`);
    logger.info('AGENT', `Context budget — history: ~${historyTokenEstimate} tokens, model limit: ${modelContextLimit.toLocaleString()}`);

    // Active editor file handling (100% full file if it fits; dynamic batching if exceeding context limit)
    if (editorCtx.hasContext && editorCtx.relativePath) {
      const activeBase = path.basename(editorCtx.relativePath);
      logger.info('FILE', `Reading active file: ${activeBase}`);
      this._postMessage({
        type: 'AGENT_PROGRESS',
        phase: 'reading',
        label: 'Reading active file',
        detail: activeBase,
      });
      this._postMessage({
        type: 'SET_BUSY',
        busy: true,
        statusText: `Reading file: ${activeBase}...`,
      });
    }
    let activeFileContent = editorCtx.fileContent;
    let activeFileBatch: FileBatchMetadata | undefined;
    if (activeFileContent && !ChunkManager.fitsWithinContext(activeFileContent, availableFileTokens)) {
      const batches = ChunkManager.createFileBatches(activeFileContent, availableFileTokens);
      const chosenBatch = ChunkManager.selectRelevantBatch(batches, processedContent, editorCtx.selectedText);
      activeFileContent = chosenBatch.content;
      activeFileBatch = {
        batchIndex: chosenBatch.batchIndex,
        totalBatches: chosenBatch.totalBatches,
        startLine: chosenBatch.startLine,
        endLine: chosenBatch.endLine,
        totalLines: chosenBatch.totalLines,
      };
    }

    const referencedFileResults: Array<{ relativePath: string; content: string; batch?: FileBatchMetadata }> = [];
    let missingReferencedFile: string | undefined;

    // Discover all workspace files mentioned in the prompt, reviewer feedback, or attachments
    const mentionedFiles: string[] = [];
    const lowerPrompt = processedContent.toLowerCase();

    // 1. Check every known workspace file path against prompt and attached feedback text
    for (const wf of workspaceFiles) {
      if (wf === editorCtx.relativePath) continue;
      const normalizedWf = wf.replace(/\\/g, '/').toLowerCase();
      const baseName = path.basename(normalizedWf).toLowerCase();
      const stem = path.parse(normalizedWf).name.toLowerCase();

      // Check full relative path match or distinctive basename
      const pathMatched = lowerPrompt.includes(normalizedWf);
      const isDistinctive = baseName.length > 3 && !['main.dart', 'index.ts', 'index.js', 'app.dart'].includes(baseName);
      const baseMatched = isDistinctive && (
        lowerPrompt.includes(`/${baseName}`) ||
        lowerPrompt.includes(`\\${baseName}`) ||
        lowerPrompt.includes(`\`${baseName}\``) ||
        lowerPrompt.includes(`"${baseName}"`) ||
        lowerPrompt.includes(`'${baseName}'`) ||
        new RegExp(`\\b${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lowerPrompt)
      );

      // Check extension-less file mention (e.g. "prd file", "to prd", "in prd", "edit prd", "file prd")
      const isDistinctiveStem = stem.length >= 2 && !['main', 'index', 'app', 'test', 'temp'].includes(stem);
      const stemMatched = isDistinctiveStem && (
        new RegExp(`\\b(?:to|in|at|check|open|update|edit|modify|add to|on)\\s+(?:the\\s+)?${stem}(?:\\s+file)?\\b`, 'i').test(lowerPrompt) ||
        new RegExp(`\\b${stem}\\s+file\\b`, 'i').test(lowerPrompt) ||
        new RegExp(`\\bfile\\s+${stem}\\b`, 'i').test(lowerPrompt)
      );

      if (pathMatched || baseMatched || stemMatched) {
        if (!mentionedFiles.includes(wf)) {
          mentionedFiles.push(wf);
        }
      }
    }

    // 2. Also check regex pattern for explicitly named file mentions (e.g. "file foo.dart" or "in lib/main.dart")
    const fileMentionRegex = /(?:file\s+|in\s+|at\s+|to\s+|check\s+|open\s+|update\s+|edit\s+)?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)/gi;
    let fm;
    while ((fm = fileMentionRegex.exec(processedContent)) !== null) {
      const raw = fm[1].trim();
      const matchedWf = workspaceFiles.find(
        (wf) => wf.toLowerCase() === raw.toLowerCase() || wf.replace(/\\/g, '/').toLowerCase().endsWith(raw.toLowerCase())
      );
      if (matchedWf && matchedWf !== editorCtx.relativePath && !mentionedFiles.includes(matchedWf)) {
        mentionedFiles.push(matchedWf);
      } else if (!matchedWf && /\b(?:file|to|in|edit|update)\s+([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)\b/i.test(fm[0])) {
        missingReferencedFile = raw;
      }
    }

    // 2b. Extract file mentions without extension (e.g. "to prd file", "in auth file", "open config file")
    const extensionlessRegex = /\b(?:(?:to|in|at|check|open|update|edit|modify|add to|on)\s+(?:the\s+)?)?([a-zA-Z0-9_\-]+)\s+file\b|\bfile\s+([a-zA-Z0-9_\-]+)\b/gi;
    let efm;
    while ((efm = extensionlessRegex.exec(processedContent)) !== null) {
      const cand = (efm[1] || efm[2] || '').trim().toLowerCase();
      if (!cand || ['a', 'the', 'this', 'that', 'new', 'old', 'next', 'each', 'any', 'my', 'our'].includes(cand)) continue;
      // Search workspace files to get the extension and specific file
      const matches = workspaceFiles.filter((wf) => {
        const wfStem = path.parse(wf).name.toLowerCase();
        return wfStem === cand;
      });
      if (matches.length > 0) {
        // Pick root-level or shortest match
        const bestMatch = matches.sort((a, b) => a.length - b.length)[0];
        if (bestMatch !== editorCtx.relativePath && !mentionedFiles.includes(bestMatch)) {
          mentionedFiles.push(bestMatch);
        }
      }
    }

    // Allocate token budget across mentioned files (up to availableFileTokens or 30,000 tokens)
    let remainingRefTokens = Math.min(availableFileTokens, 30000);
    for (const wf of mentionedFiles.slice(0, 8)) {
      if (remainingRefTokens <= 1000) break;
      const baseName = path.basename(wf);
      this._postMessage({
        type: 'AGENT_PROGRESS',
        phase: 'reading',
        label: 'Reading file',
        detail: baseName,
      });
      this._postMessage({
        type: 'SET_BUSY',
        busy: true,
        statusText: `Reading file: ${baseName}...`,
      });
      const matched = await ContextReader.findAndReadWorkspaceFile(wf, this._permissionManager);
      if (matched) {
        let refContent = matched.content;
        let refBatch: FileBatchMetadata | undefined;
        if (!ChunkManager.fitsWithinContext(refContent, remainingRefTokens)) {
          const batches = ChunkManager.createFileBatches(refContent, remainingRefTokens);
          const chosenBatch = ChunkManager.selectRelevantBatch(batches, processedContent);
          refContent = chosenBatch.content;
          refBatch = {
            batchIndex: chosenBatch.batchIndex,
            totalBatches: chosenBatch.totalBatches,
            startLine: chosenBatch.startLine,
            endLine: chosenBatch.endLine,
            totalLines: chosenBatch.totalLines,
          };
        }
        const tokensUsed = ChunkManager.estimateTokens(refContent);
        remainingRefTokens -= tokensUsed;
        referencedFileResults.push({
          relativePath: matched.relativePath,
          content: refContent,
          batch: refBatch,
        });
      }
    }

    const terminalOutputs = TerminalOutputTracker.getRecentOutputsFormatted();

    const platform = process.platform;
    const isWindows = platform === 'win32';
    const shell = isWindows
      ? (process.env.ComSpec ? path.basename(process.env.ComSpec) : 'cmd.exe')
      : (process.env.SHELL ? path.basename(process.env.SHELL) : 'bash');

    const systemPrompt = buildSystemPrompt({
      activeFile: editorCtx.hasContext && (editorCtx.relativePath || editorCtx.isArtifactDocument) ? {
        relativePath: editorCtx.relativePath || '',
        languageId: editorCtx.languageId,
        selectedText: editorCtx.selectedText,
        fileContent: activeFileContent,
        batch: activeFileBatch,
        isArtifactDocument: editorCtx.isArtifactDocument,
        artifactType: editorCtx.artifactType,
      } : undefined,
      workspaceFiles,
      referencedFile: referencedFileResults[0] || undefined,
      referencedFiles: referencedFileResults,
      missingReferencedFile,
      terminalOutputs: terminalOutputs || undefined,
      permissions: {
        applyEdit: this._permissionManager.getPermission('applyEdit'),
        runTerminalCommand: this._permissionManager.getPermission('runTerminalCommand'),
      },
      environment: {
        platform,
        shell,
      },
    });

    // Phase 7: Secret Scanning & Redaction Pipeline
    const redactionPolicy = Configuration.getRedactionMode();
    const systemPromptRedacted = SecretScanner.redact(systemPrompt);
    const contentRedacted = SecretScanner.redact(processedContent);

    const totalDetectedSecrets = systemPromptRedacted.matches.length + contentRedacted.matches.length;

    // If block_and_warn mode is active and secrets were detected, warn the user
    if (redactionPolicy === 'block_and_warn' && totalDetectedSecrets > 0) {
      const warningDetails = [
        ...systemPromptRedacted.matches.map((m) => `[File Context] ${m.ruleName}`),
        ...contentRedacted.matches.map((m) => `[User Message] ${m.ruleName}`),
      ].slice(0, 4).join(', ');

      const choice = await vscode.window.showWarningMessage(
        `OpenRouter Privacy Alert: ${totalDetectedSecrets} potential secret(s) detected (${warningDetails}). Send with secrets masked?`,
        { modal: true },
        'Send Masked',
        'Cancel'
      );

      if (choice !== 'Send Masked') {
        this._postMessage({ type: 'SET_BUSY', busy: false });
        return;
      }
    }

    chatMessages.push({ role: 'system', content: systemPromptRedacted.sanitized });

    history.forEach((h, idx) => {
      // For the most recent user turn (current turn), use redacted content
      let msgContent = (idx === history.length - 1 && h.role === 'user')
        ? contentRedacted.sanitized
        : (SecretScanner.redact(h.content).sanitized);

      if (h.role === 'assistant') {
        if (h.planDocument && !msgContent.includes(h.planDocument)) {
          const redactedPlan = SecretScanner.redact(h.planDocument).sanitized;
          msgContent = `${msgContent}\n\n\`\`\`plan\n${redactedPlan}\n\`\`\``;
        }
        if (h.walkthroughDocument && !msgContent.includes(h.walkthroughDocument)) {
          const redactedWalkthrough = SecretScanner.redact(h.walkthroughDocument).sanitized;
          msgContent = `${msgContent}\n\n\`\`\`walkthrough\n${redactedWalkthrough}\n\`\`\``;
        }
      }

      if (h.images && h.images.length > 0) {
        const parts: ChatMessageContentPart[] = [{ type: 'text', text: msgContent || ' ' }];
        for (const img of h.images) {
          parts.push({
            type: 'image_url',
            image_url: { url: img.dataUrl },
          });
        }
        chatMessages.push({
          role: h.role,
          content: parts,
        });
      } else {
        chatMessages.push({
          role: h.role,
          content: msgContent,
        });
      }
    });

    // Provide context preview metadata to webview (PRD Phase 7 §7.2)
    const dataPolicy = Configuration.getDataCollectionPolicy();
    const contentSnippet = editorCtx.selectedText
      ? editorCtx.selectedText.slice(0, 1000)
      : (editorCtx.fileContent ? editorCtx.fileContent.slice(0, 1000) : undefined);

    this._postMessage({
      type: 'CONTEXT_PREVIEW_UPDATE',
      preview: {
        activeFile: editorCtx.isArtifactDocument
          ? (editorCtx.artifactType === 'walkthrough' ? 'Results Walkthrough (viewing)' : 'Implementation Plan (viewing)')
          : editorCtx.relativePath,
        lineRange: editorCtx.selectedText ? 'Selection' : (editorCtx.hasContext ? 'Whole file' : undefined),
        contentSnippet,
        referencedFile: referencedFileResults.length > 0 ? {
          path: referencedFileResults.map(r => r.relativePath).join(', '),
          contentSnippet: referencedFileResults[0].content.slice(0, 1000),
        } : undefined,
        terminalOutputs: terminalOutputs ? terminalOutputs.slice(0, 500) : undefined,
        imageCount: images?.length || 0,
        redactedCount: totalDetectedSecrets,
        hasZdrOnly: dataPolicy === 'deny',
      },
    });

    // Provider Routing Privacy Configuration
    const providerOptions: ProviderRoutingOptions = {};
    if (dataPolicy === 'deny') {
      providerOptions.data_collection = 'deny';
      providerOptions.zdr = true;
    }

    let accumulatedContent = '';
    if (!this._activeAbortController || this._activeAbortController.signal.aborted) {
      if (this._isUserCancelled) {
        this._postMessage({ type: 'SET_BUSY', busy: false });
        return;
      }
      this._activeAbortController = new AbortController();
    }
    if (this._isUserCancelled || this._activeAbortController.signal.aborted) {
      this._postMessage({ type: 'SET_BUSY', busy: false });
      return;
    }

    let effectiveReasoningEffort = reasoningEffort || this._activeReasoningEffort;
    if (effectiveReasoningEffort) {
      this._activeReasoningEffort = effectiveReasoningEffort;
    }
    const modelDisplayName = currentModelObj?.name || selectedModel;
    this._postMessage({
      type: 'AGENT_PROGRESS',
      phase: 'connecting',
      label: 'Connecting to model',
      detail: modelDisplayName,
    });
    this._postMessage({
      type: 'SET_BUSY',
      busy: true,
      statusText: `Connecting to ${modelDisplayName}...`,
    });

    let hasEmittedFirstChunk = false;
    let hasEmittedThinking = false;
    const streamStartTime = Date.now();

    await OpenRouterClient.sendChatCompletionStream(
      apiKey,
      selectedModel,
      chatMessages,
      (chunk) => {
        if (!hasEmittedFirstChunk) {
          hasEmittedFirstChunk = true;
          this._postMessage({
            type: 'AGENT_PROGRESS',
            phase: 'writing',
            label: 'Writing',
          });
          this._postMessage({
            type: 'SET_BUSY',
            busy: true,
            statusText: 'Writing...',
          });
        }
        accumulatedContent += chunk;
        this._postMessage({
          type: 'MESSAGE_STREAM_CHUNK',
          messageId: assistantMessageId,
          chunk,
        });
      },
      async (usage, finishReason) => {
        const executionDurationMs = Date.now() - streamStartTime;

        if (this._isUserCancelled || this._activeAbortController?.signal.aborted) {
          if (accumulatedContent.trim().length > 0) {
            const { planDocument, walkthroughDocument, chatSummary } = extractArtifacts(accumulatedContent);
            const stoppedSummary = `${chatSummary}\n\n[Generation stopped by user]`;
            await this._historyStore.appendMessage({
              id: assistantMessageId,
              role: 'assistant',
              content: stoppedSummary,
              planDocument,
              walkthroughDocument,
              model: selectedModel,
              timestamp: Date.now(),
              executionDurationMs,
            });
            this._postMessage({
              type: 'MESSAGE_STREAM_DONE',
              messageId: assistantMessageId,
              model: selectedModel,
              usage,
              chatSummary: stoppedSummary,
              planDocument,
              walkthroughDocument,
              executionDurationMs,
            });
          }
          this._activeAbortController = undefined;
          this._postMessage({ type: 'SET_BUSY', busy: false });
          return;
        }

        // If the model returned an empty completion (often due to upstream timeout or token limits)
        let finalContent = accumulatedContent;
        const isEmptyResponse = finalContent.trim() === '' && !this._activeAbortController?.signal.aborted;
        if (isEmptyResponse) {
          logger.warn('AGENT', `Empty response from ${selectedModel} — possible upstream timeout, context limit, or provider issue`);
          finalContent = '⚠️ The model returned an empty response. This usually occurs when the upstream provider times out or encounters a context limit. You can click "↻ Retry" or send a follow-up prompt to continue.';
        }

        // Extract two-tier artifacts (plan / walkthrough) from the raw model response
        const { planDocument, walkthroughDocument, chatSummary } = extractArtifacts(finalContent);

        // Check if this turn is an intermediate step:
        // An automated follow-up turn (isAutoFollowUp or autoTurnCount > 0 or retryCount > 0)
        // that does NOT contain a walkthrough document is an intermediate execution step.
        const isIntermediateStep = Boolean(
          (retryContext?.isAutoFollowUp || (retryContext?.autoTurnCount ?? 0) > 0 || (retryContext?.retryCount ?? 0) > 0) &&
          !walkthroughDocument
        );

        await this._historyStore.appendMessage({
          id: assistantMessageId,
          role: 'assistant',
          content: chatSummary,
          planDocument,
          walkthroughDocument,
          model: selectedModel,
          timestamp: Date.now(),
          executionDurationMs,
          totalTokens: usage?.total_tokens,
          isIntermediateStep,
          isAutoFollowUp: retryContext?.isAutoFollowUp,
        });

        // Proactively persist artifact .md files to disk immediately upon generation
        if (planDocument) {
          try {
            await ArtifactDocumentManager.prepareArtifactFile(
              this._historyStore,
              'plan',
              assistantMessageId,
              planDocument,
              this._storageUri
            );
          } catch {
            // non-fatal
          }
        }
        if (walkthroughDocument) {
          try {
            await ArtifactDocumentManager.prepareArtifactFile(
              this._historyStore,
              'walkthrough',
              assistantMessageId,
              walkthroughDocument,
              this._storageUri
            );
          } catch {
            // non-fatal
          }
        }

        // Compute cost and log to UsageStore
        if (usage) {
          const modelObj = this._cachedModels.find((m) => m.id === selectedModel);
          const cost = PricingCalculator.calculateCost(
            usage.prompt_tokens,
            usage.completion_tokens,
            modelObj?.pricing
          );

          // If reasoning effort was used, log Model (Effort)
          let loggedModelName = selectedModel;
          const effortForLogging = effectiveReasoningEffort || this._activeReasoningEffort;
          if (effortForLogging) {
            const formattedEffort =
              effortForLogging.charAt(0).toUpperCase() + effortForLogging.slice(1).toLowerCase();
            loggedModelName = `${selectedModel} (${formattedEffort})`;
          }

          await this._usageStore.appendRecord({
            type: 'chat_completion',
            project: ProjectResolver.getActiveProjectName(),
            model: loggedModelName,
            reasoningEffort: effortForLogging,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            cost,
          });
          logger.info('COST', `Request cost — model: ${loggedModelName}, cost: $${cost?.toFixed(6) ?? '?'} (in: ${usage.prompt_tokens ?? '?'} out: ${usage.completion_tokens ?? '?'} tokens)`);
        }

        this._postMessage({
          type: 'MESSAGE_STREAM_DONE',
          messageId: assistantMessageId,
          model: selectedModel,
          usage,
          chatSummary,
          planDocument,
          walkthroughDocument,
          executionDurationMs,
          isIntermediateStep,
        });

        // Auto-execution under Allow = Zero Manual Interaction
        let triggeredFollowUp = false;
        try {
          if (isEmptyResponse && (retryContext?.isAutoFollowUp || (retryContext?.retryCount ?? 0) > 0) && (retryContext?.emptyRetryCount ?? 0) < 1) {
            const targetModel = selectedModel || Configuration.getLastModel() || 'openai/gpt-4o-mini';
            triggeredFollowUp = true;
            await this._handleSendMessage(
              'The previous request returned an empty completion. Please continue executing the plan and verify results.',
              targetModel,
              undefined,
              undefined,
              this._activeReasoningEffort,
              {
                retryCount: retryContext?.retryCount ?? 0,
                failedCommands: retryContext?.failedCommands ?? new Set<string>(),
                autoTurnCount: (retryContext?.autoTurnCount ?? 0) + 1,
                isAutoFollowUp: true,
                emptyRetryCount: (retryContext?.emptyRetryCount ?? 0) + 1,
              }
            );
          } else {
            triggeredFollowUp = await this._handleAutoExecution(
              accumulatedContent,
              selectedModel,
              retryContext,
              walkthroughDocument,
              planDocument,
              assistantMessageId
            );

            // If the model was cut off mid-response due to token limits (finish_reason === 'length')
            // and auto-execution hasn't already scheduled a follow-up, resume generation automatically
            if (!triggeredFollowUp && finishReason === 'length' && !this._isUserCancelled && !this._activeAbortController?.signal.aborted) {
              let isExecActive = Boolean(retryContext?.isAutoFollowUp || (retryContext?.retryCount ?? 0) > 0);
              if (!isExecActive && this._historyStore) {
                try {
                  const hist = await this._historyStore.loadHistory();
                  isExecActive = hist.some((m) => m.role === 'assistant' && (m.planDocument || /```plan/i.test(m.content)));
                } catch {
                  // non-fatal
                }
              }
              const currentAutoTurns = retryContext?.autoTurnCount ?? 0;
              const MAX_AUTO_FOLLOWUPS = 5;

              if (isExecActive && currentAutoTurns < MAX_AUTO_FOLLOWUPS) {
                logger.info('AGENT', 'Model response cut off by token limit (finish_reason === "length"). Auto-resuming generation...');
                const targetModel = selectedModel || Configuration.getLastModel() || 'openai/gpt-4o-mini';
                triggeredFollowUp = true;
                await this._handleSendMessage(
                  'Your previous response reached the maximum output token limit and was cut off mid-generation. Please continue directly from the exact point where you stopped, completing all remaining planned modifications, tasks, and verifications.',
                  targetModel,
                  undefined,
                  undefined,
                  this._activeReasoningEffort,
                  {
                    retryCount: retryContext?.retryCount ?? 0,
                    failedCommands: retryContext?.failedCommands ?? new Set<string>(),
                    autoTurnCount: currentAutoTurns + 1,
                    isAutoFollowUp: true,
                  }
                );
              }
            }
          }
        } finally {
          if (!triggeredFollowUp) {
            this._activeAbortController = undefined;
            this._postMessage({ type: 'SET_BUSY', busy: false });
          }
        }
      },
      (err) => {
        this._activeAbortController = undefined;
        const isNetwork = err.message.includes('fetch failed') || err.message.includes('network') || err.message.includes('ECONNRESET');
        const friendlyMsg = isNetwork
          ? 'Connection to OpenRouter lost after 2 retry attempts. Please check your internet connection or try again.'
          : `Request failed: ${err.message}`;

        this._postMessage({
          type: 'ERROR',
          message: friendlyMsg,
          canRetry: true,
        });
        this._postMessage({ type: 'SET_BUSY', busy: false });
      },
      providerOptions,
      this._activeAbortController.signal,
      effectiveReasoningEffort,
      () => {
        effectiveReasoningEffort = undefined;
        vscode.window.showWarningMessage(
          "This model doesn't support the selected reasoning effort level — retrying without it."
        );
      },
      (reasoningChunk) => {
        if (!hasEmittedThinking && !hasEmittedFirstChunk) {
          hasEmittedThinking = true;
          this._postMessage({
            type: 'AGENT_PROGRESS',
            phase: 'thinking',
            label: 'Thinking',
          });
          this._postMessage({
            type: 'SET_BUSY',
            busy: true,
            statusText: 'Model is thinking...',
          });
        }
      },
      (status) => {
        this._postMessage({
          type: 'SET_BUSY',
          busy: true,
          statusText: status,
        });
      }
    );
  }

  private async _sendUsageReportData() {
    const summary = await this._usageStore.getSpendSummary();
    const records = await this._usageStore.loadRecords();
    const projects = await this._usageStore.getDistinctProjects();
    const models = await this._usageStore.getDistinctModels();
    const currentProject = ProjectResolver.getActiveProjectName();

    this._postMessage({
      type: 'USAGE_REPORT_DATA',
      summary,
      records,
      projects,
      models,
      currentProject,
    });
  }

  private async _handleAutoExecution(
    content: string,
    modelId?: string,
    retryContext?: { retryCount: number; failedCommands: Set<string>; autoTurnCount?: number; isAutoFollowUp?: boolean; emptyRetryCount?: number },
    walkthroughDocument?: string,
    planDocument?: string,
    assistantMessageId?: string
  ): Promise<boolean> {
    // 0. Safeguard: if user cancelled or aborted, stop immediately
    if (this._isUserCancelled || this._activeAbortController?.signal.aborted) {
      return false;
    }

    // 1. Critical Safeguard: If an Implementation Plan was generated, ALWAYS STOP!
    // An implementation plan is a mandatory review checkpoint.
    // The user must inspect the plan and explicitly click "Proceed" before execution begins.
    const hasPlan = Boolean(planDocument && planDocument.trim().length > 0);
    const hasPlanApprovalQuestion = /(?:would you like me to proceed with this plan|shall i proceed with (?:this|the) plan|review or make adjustments first|proceed with this plan\?)/i.test(content);
    if (hasPlan || hasPlanApprovalQuestion) {
      return false;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return false;
    }

    const isExecutionActive = Boolean(retryContext?.isAutoFollowUp || (retryContext?.retryCount ?? 0) > 0);
    const historyForPlanCheck = this._historyStore ? await this._historyStore.loadHistory() : [];
    const activePlanExists = historyForPlanCheck.some(
      (m) => m.role === 'assistant' && (m.planDocument || /```plan/i.test(m.content))
    );

    const successfullyEditedFiles: string[] = [];
    const failedEdits: Array<{ filePath: string; relativePath: string; error: string; editCount: number }> = [];
    const fileActionRegex = /(?:```|````)(?:create_file|edit_file|file|create|edit|patch|(?!plan|walkthrough)[a-zA-Z0-9_-]+):([^\r\n]+)\r?\n((?:[\s\S]*?<<<< SEARCH[\s\S]*?\n>>>>[^\r\n]*|[\s\S]*?))\r?\n(?:```|````)/gi;
    const applyEditPerm = this._permissionManager.getPermission('applyEdit');
    const isApplyEditAllowed = applyEditPerm === 'allow' || applyEditPerm === 'allow_session';
    const isAskMode = applyEditPerm === 'ask';
    const shouldApplyEdits = isApplyEditAllowed || isAskMode;

    if (applyEditPerm === 'deny') {
      const matches: { filePath: string; fileName: string; editId: string }[] = [];
      let fileMatch;
      let editCount = 0;
      while ((fileMatch = fileActionRegex.exec(content)) !== null) {
        let filePath = fileMatch[1].trim();
        if (!filePath.includes('.') && !filePath.includes('/') && !filePath.includes('\\')) {
          continue;
        }
        editCount++;
        const lastColon = filePath.lastIndexOf(':');
        if (lastColon > 1) {
          const afterColon = filePath.substring(lastColon + 1).trim();
          if (!afterColon.includes('/') && !afterColon.includes('\\')) {
            filePath = filePath.substring(0, lastColon).trim();
          }
        }
        matches.push({
          filePath,
          fileName: path.basename(filePath),
          editId: `${Date.now()}-${editCount}`,
        });
      }

      for (const m of matches) {
        const text = matches.length === 1
          ? `⚠️ This edit was not applied — Code edits permission is currently set to Denied.`
          : `⚠️ This edit to \`${m.fileName}\` was not applied — Code edits permission is currently set to Denied.`;

        const deniedMsg = {
          id: `${Date.now()}-denied-${m.editId}`,
          role: 'assistant' as const,
          content: text,
          timestamp: Date.now(),
        };
        if (this._historyStore?.appendMessage) {
          await this._historyStore.appendMessage(deniedMsg);
        }
        this._postMessage({
          type: 'MESSAGE_RECEIVED',
          message: deniedMsg,
        });
        this._postMessage({
          type: 'EDIT_APPLIED',
          editId: m.editId,
          success: false,
        });
      }
    } else if (shouldApplyEdits) {
      const hasEdits = /(?:```|````)(?:create_file|edit_file|file|create|edit|patch|(?!plan|walkthrough)[a-zA-Z0-9_-]+):/i.test(content);
      if (hasEdits) {
        this._postMessage({
          type: 'SET_BUSY',
          busy: true,
          statusText: 'Applying file edits...',
        });
      }
      let fileMatch;
      let editCount = 0;
      while ((fileMatch = fileActionRegex.exec(content)) !== null) {
        if (this._activeAbortController?.signal.aborted) {
          break;
        }
        let filePath = fileMatch[1].trim();
        if (!filePath.includes('.') && !filePath.includes('/') && !filePath.includes('\\')) {
          continue;
        }
        editCount++;
        const lastColon = filePath.lastIndexOf(':');
        if (lastColon > 1) {
          const afterColon = filePath.substring(lastColon + 1).trim();
          if (!afterColon.includes('/') && !afterColon.includes('\\')) {
            filePath = filePath.substring(0, lastColon).trim();
          }
        }
        const newContent = fileMatch[2];
        const editId = assistantMessageId
          ? `${assistantMessageId}-edit-${editCount}`
          : `${Date.now()}-${editCount}`;

        const fileUri = path.isAbsolute(filePath)
          ? vscode.Uri.file(filePath)
          : vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);

        let fileExists = true;
        try {
          await vscode.workspace.fs.stat(fileUri);
        } catch {
          fileExists = false;
        }

        const relativePath = vscode.workspace.asRelativePath(fileUri);

        try {
          // Check permission
          let permAllowed = true;
          if (isAskMode) {
            // Optimistic apply in 'ask' mode: respect explicit 'deny' on file creation if new file
            if (!fileExists && this._permissionManager.getPermission('createDeleteFiles') === 'deny') {
              permAllowed = false;
            }
          }

          if (!permAllowed) {
            const deniedMsg = {
              id: `${Date.now()}-error-${editCount}`,
              role: 'assistant' as const,
              content: `⚠️ Could not auto-apply edit to \`${relativePath}\`: permission denied.`,
              timestamp: Date.now(),
            };
            if (this._historyStore?.appendMessage) {
              await this._historyStore.appendMessage(deniedMsg);
            }
            this._postMessage({
              type: 'MESSAGE_RECEIVED',
              message: deniedMsg,
            });
            this._postMessage({
              type: 'EDIT_APPLIED',
              editId,
              success: false,
            });
            continue;
          }

          // Pre-resolve proposed content to catch malformed SEARCH/REPLACE blocks early with exact error message
          let originalContent = '';
          if (fileExists) {
            try {
              const data = await vscode.workspace.fs.readFile(fileUri);
              originalContent = new TextDecoder('utf-8').decode(data);
            } catch {
              // ignore
            }
          }
          DiffPreviewManager.resolveProposedContent(originalContent, newContent);

          // Shadow-git checkpointing applies identically
          let checkpointId: string | undefined;
          if (this._checkpointManager) {
            const res = await this._checkpointManager.createCheckpoint(
              [filePath],
              `Before edit ${editId}`
            );
            if (res) {
              checkpointId = res;
            }
          }

          // Apply edit (skipPermissionCheck = true because checked above)
          logger.info('FILE', `Writing to file: ${filePath}${isAskMode ? ' (optimistic apply)' : ' (auto-apply)'}`);
          const success = await DiffPreviewManager.applyEdit(
            fileUri,
            newContent,
            this._permissionManager,
            true
          );

          if (success) {
            successfullyEditedFiles.push(filePath);
            // Tag turn checkpoint
            if (checkpointId) {
              await this._tagCurrentTurnCheckpoint(checkpointId, [filePath]);
            }
            this._trackAppliedEdit(filePath, checkpointId, originalContent, editId);

            // Open edited file into independent editor tab with preserveFocus
            try {
              const doc = await vscode.workspace.openTextDocument(fileUri);
              await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
            } catch {
              // non-fatal
            }

            if (isApplyEditAllowed) {
              const fileName = path.basename(filePath);
              const appliedMsg = {
                id: `${Date.now()}-applied-${editCount}`,
                role: 'assistant' as const,
                content: `✓ **Applied:** updated \`${fileName}\``,
                timestamp: Date.now(),
              };
              if (this._historyStore?.appendMessage) {
                await this._historyStore.appendMessage(appliedMsg);
              }
              this._postMessage({
                type: 'MESSAGE_RECEIVED',
                message: appliedMsg,
              });

              this._postMessage({
                type: 'EDIT_APPLIED',
                editId,
                success: true,
                checkpointId,
                filePath,
              });
            } else {
              // In 'Ask' mode: The file is written to disk and checkpointed optimistically.
              // We do NOT send EDIT_APPLIED yet! The UI keeps the card in "Pending" state
              // with active "Apply" / "Accept" and "Reject" buttons so the user can inspect
              // the live change in VS Code before deciding.
              logger.info('EDIT', `Optimistically applied ${relativePath}${checkpointId ? ` (checkpoint: ${checkpointId.substring(0, 7)})` : ''}, awaiting user decision`);
            }
          } else {
            failedEdits.push({
              filePath,
              relativePath,
              error: 'Edit could not be applied to file',
              editCount,
            });
            const failMsg = {
              id: `${Date.now()}-fail-${editCount}`,
              role: 'assistant' as const,
              content: `⚠️ Failed to auto-apply edit to \`${relativePath}\`.`,
              timestamp: Date.now(),
            };
            if (this._historyStore?.appendMessage) {
              await this._historyStore.appendMessage(failMsg);
            }
            this._postMessage({
              type: 'MESSAGE_RECEIVED',
              message: failMsg,
            });
            this._postMessage({
              type: 'EDIT_APPLIED',
              editId,
              success: false,
            });
          }
        } catch (err: any) {
          failedEdits.push({
            filePath,
            relativePath,
            error: err.message || 'Malformed search/replace block or write error',
            editCount,
          });
          // Malformed search/replace or write error: fail safely with clear chat error message
          const errMsg = {
            id: `${Date.now()}-fail-${editCount}`,
            role: 'assistant' as const,
            content: `⚠️ Failed to auto-apply edit to \`${relativePath}\`: ${err.message}`,
            timestamp: Date.now(),
          };
          if (this._historyStore?.appendMessage) {
            await this._historyStore.appendMessage(errMsg);
          }
          this._postMessage({
            type: 'MESSAGE_RECEIVED',
            message: errMsg,
          });
          this._postMessage({
            type: 'EDIT_APPLIED',
            editId,
            success: false,
          });
        }
      }
    }

    const currentRetryCount = retryContext?.retryCount ?? 0;
    const MAX_RETRIES = 5;

    // Self-Healing Auto-Retry for Failed File Edits:
    // If an edit failed due to search-block drift or formatting error, feed the real file content back to model
    if (
      failedEdits.length > 0 &&
      currentRetryCount < MAX_RETRIES &&
      !this._activeAbortController?.signal.aborted
    ) {
      const firstFailed = failedEdits[0];
      const targetModel = modelId || Configuration.getLastModel() || 'openai/gpt-4o-mini';

      const fileUri = path.isAbsolute(firstFailed.filePath)
        ? vscode.Uri.file(firstFailed.filePath)
        : vscode.Uri.joinPath(workspaceFolders[0].uri, firstFailed.filePath);

      let currentFileContent = '';
      try {
        const fileBytes = await vscode.workspace.fs.readFile(fileUri);
        currentFileContent = new TextDecoder('utf-8').decode(fileBytes);
      } catch {
        // non-fatal if file doesn't exist yet
      }

      const retryNotice = {
        id: `${Date.now()}-edit-retry-${firstFailed.editCount}`,
        role: 'system' as const,
        content: `🔄 File edit to \`${firstFailed.relativePath}\` failed (${firstFailed.error}). Initiating self-healing retry (${currentRetryCount + 1}/${MAX_RETRIES})...`,
        timestamp: Date.now(),
      };
      if (this._historyStore?.appendMessage) {
        await this._historyStore.appendMessage(retryNotice);
      }
      this._postMessage({
        type: 'MESSAGE_RECEIVED',
        message: retryNotice,
      });

      const truncatedFile = currentFileContent.length > 5000
        ? currentFileContent.substring(0, 5000) + '\n... [truncated]'
        : currentFileContent;

      const retryPrompt = `The proposed edit to \`${firstFailed.relativePath}\` could not be applied.\nReason: ${firstFailed.error}\n\nHere is the current content of \`${firstFailed.relativePath}\`:\n\`\`\`\n${truncatedFile}\n\`\`\`\n\nPlease output a corrected \`\`\`edit_file:${firstFailed.relativePath} block where the <<<< SEARCH block matches the lines from the file above exactly. Continue executing until all tasks and verifications succeed.`;

      await this._handleSendMessage(
        retryPrompt,
        targetModel,
        undefined,
        undefined,
        this._activeReasoningEffort,
        {
          retryCount: currentRetryCount + 1,
          failedCommands: retryContext?.failedCommands ?? new Set<string>(),
          autoTurnCount: (retryContext?.autoTurnCount ?? 0) + 1,
          isAutoFollowUp: true,
        }
      );
      return true;
    }

    // 2. Auto-run proposed terminal commands if runTerminalCommand is allowed
    const runTerminalPerm = this._permissionManager.getPermission('runTerminalCommand');
    const isRunTerminalAllowed = runTerminalPerm === 'allow' || runTerminalPerm === 'allow_session';
    const successfulCommands: Array<{ command: string; output: string }> = [];
    let executedCommandsSummary: Array<{
      command: string;
      outcome: string;
      exitCode: number | null;
      output: string;
      timedOut?: boolean;
      cancelled?: boolean;
    }> = [];

    const flushExecutedTerminalSummary = async () => {
      if (executedCommandsSummary.length === 0) return;
      const summaryContent = this._formatTerminalExecutionSummary(executedCommandsSummary);
      const termMsg = {
        id: `${Date.now()}-term-summary`,
        role: 'system' as const,
        content: summaryContent,
        timestamp: Date.now(),
      };
      executedCommandsSummary = [];
      if (this._historyStore?.appendMessage) {
        await this._historyStore.appendMessage(termMsg);
      }
      this._postMessage({
        type: 'MESSAGE_RECEIVED',
        message: termMsg,
      });
    };

    if (runTerminalPerm !== 'deny') {
      const bashRegex = /```(?:bash|sh|shell|cmd|powershell)\s*([\s\S]*?)```/gi;
      let match;
      let cmdCount = 0;
      const MAX_TERMINAL_RETRIES = 5;

      // If file edits were successfully applied in this turn, reset failedCommands
      // because workspace files changed, so repeating a verification command is testing new code
      if (successfullyEditedFiles.length > 0 && retryContext?.failedCommands) {
        retryContext.failedCommands.clear();
      }

      while ((match = bashRegex.exec(content)) !== null) {
        if (this._activeAbortController?.signal.aborted) {
          break;
        }
        const command = match[1].trim();
        if (command) {
          const isReadOnlyCmd = CommandRunner.isReadOnly(command);
          // Side-effecting commands require explicit allow/allow_session to auto-run.
          // In 'ask' mode, side-effecting commands render interactive UI cards for user approval.
          if (!isReadOnlyCmd && !isRunTerminalAllowed) {
            continue;
          }

          cmdCount++;
          const statusDesc = isReadOnlyCmd
            ? CommandRunner.getInspectionDescription(command)
            : `Running in terminal: ${command.length > 35 ? command.slice(0, 32) + '...' : command}`;

          this._postMessage({
            type: 'SET_BUSY',
            busy: true,
            statusText: statusDesc,
          });

          if (!isReadOnlyCmd) {
            this._postMessage({ type: 'TERMINAL_RUNNING', command });
          }

          let cmdCheckpointId: string | null = null;
          let cmdAffectedFiles: string[] = [];
          const workspaceFolders = vscode.workspace.workspaceFolders;
          const root = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : '';
          const preCommandSnapshots: Map<string, { uri: vscode.Uri; existed: boolean; content: string }> = new Map();

          if (!isReadOnlyCmd) {
            cmdAffectedFiles = this._extractFilesMutatedByCommand(command, root);
            if (workspaceFolders && workspaceFolders.length > 0) {
              for (const f of cmdAffectedFiles) {
                const fileUri = path.isAbsolute(f) ? vscode.Uri.file(f) : vscode.Uri.joinPath(workspaceFolders[0].uri, f);
                let existed = false;
                let content = '';
                try {
                  const fileBytes = await vscode.workspace.fs.readFile(fileUri);
                  content = new TextDecoder('utf-8').decode(fileBytes);
                  existed = true;
                } catch {
                  existed = false;
                }
                preCommandSnapshots.set(f, { uri: fileUri, existed, content });
              }
            }

            if (cmdAffectedFiles.length > 0 && this._checkpointManager) {
              cmdCheckpointId = await this._checkpointManager.createCheckpoint(
                cmdAffectedFiles,
                `Before terminal command: ${command.slice(0, 40)}`
              );
              if (cmdCheckpointId) {
                await this._tagCurrentTurnCheckpoint(cmdCheckpointId, cmdAffectedFiles);
              }
            }
          }

          const result = await CommandRunner.executeCommand(
            command,
            this._permissionManager,
            this._usageStore,
            { abortSignal: this._activeAbortController?.signal }
          );

          if (!isReadOnlyCmd) {
            this._postMessage({
              type: 'TERMINAL_RESULT',
              command,
              exitCode: result.exitCode ?? null,
              stdout: result.stdout ?? '',
              stderr: result.stderr ?? '',
              executed: result.executed,
              cancelled: result.cancelled,
              timedOut: result.timedOut,
              error: result.error,
            });

            if (!result.cancelled) {
              const applyEditPerm = this._permissionManager.getPermission('applyEdit');
              if (cmdAffectedFiles.length > 0 && preCommandSnapshots.size > 0) {
                let fileIdx = 0;
                for (const [filePath, snap] of preCommandSnapshots.entries()) {
                  fileIdx++;
                  let existsNow = false;
                  let currentContent = '';
                  try {
                    const dataBytes = await vscode.workspace.fs.readFile(snap.uri);
                    currentContent = new TextDecoder('utf-8').decode(dataBytes);
                    existsNow = true;
                  } catch {
                    existsNow = false;
                  }

                  const wasMutated = (!snap.existed && existsNow) ||
                    (snap.existed && !existsNow) ||
                    (snap.existed && existsNow && currentContent !== snap.content);

                  if (wasMutated) {
                    const editId = `term-edit-${Date.now()}-${cmdCount}-${fileIdx}`;
                    this._trackAppliedEdit(filePath, cmdCheckpointId ?? undefined, snap.content, editId);
                    if (cmdCheckpointId) {
                      await this._tagCurrentTurnCheckpoint(cmdCheckpointId, [filePath]);
                    }

                    if (applyEditPerm === 'ask') {
                      // Process-Agnostic File Mutation Guard: Prompt to Accept / Reject (Non-blocking: AI continues execution)
                      this._postMessage({
                        type: 'PROPOSE_EDIT',
                        editId,
                        edit: {
                          filePath,
                          newContent: currentContent,
                          diffExplanation: `Modified via terminal command: ${command.length > 50 ? command.slice(0, 47) + '...' : command}`,
                        },
                      });
                    } else if (applyEditPerm === 'allow' || applyEditPerm === 'allow_session') {
                      this._postMessage({
                        type: 'EDIT_APPLIED',
                        editId,
                        success: true,
                        checkpointId: cmdCheckpointId ?? undefined,
                        filePath,
                      });
                    }
                  }
                }
              }
            }
          }

          let outcome = '(failed)';
          if (result.cancelled) {
            outcome = '(cancelled)';
          } else if (result.timedOut) {
            outcome = '(timed out after 120s)';
          } else if (result.executed) {
            outcome = result.exitCode === 0
              ? '(completed, exit code: 0)'
              : `(failed with exit code: ${result.exitCode ?? 'unknown'})`;
          }

          const rawSnippet = (result.stdout || result.stderr || result.error || '').trim();
          const truncatedSnippet = rawSnippet.length > 1500
            ? rawSnippet.substring(0, 1500) + '\n... [output truncated]'
            : rawSnippet;

          // Tier 1 (Read-Only / Inspection): Run silently without chat card or message pollution
          // Tier 2 (Side-Effecting): Collect into executedCommandsSummary for a single consolidated 1-line dropdown
          if (!isReadOnlyCmd) {
            executedCommandsSummary.push({
              command,
              outcome,
              exitCode: result.exitCode ?? null,
              output: truncatedSnippet,
              timedOut: result.timedOut,
              cancelled: result.cancelled,
            });
          }

          // Track successful commands for automatic continuation response
          if (result.executed && result.exitCode === 0 && !result.cancelled && !result.timedOut) {
            successfulCommands.push({
              command,
              output: rawSnippet,
            });
          }

          // Self-Healing Auto-Retry with Loop Protection (including timeouts)
          const isFailed = (result.executed && result.exitCode !== 0) || (result.timedOut && !result.cancelled);
          if (isFailed && !result.cancelled) {
            const currentRetryCount = retryContext?.retryCount ?? 0;
            const failedCommands = retryContext?.failedCommands ?? new Set<string>();

            // Safeguard 1: Abort if user cancelled the stream/session
            if (this._activeAbortController?.signal.aborted) {
              break;
            }

            // Safeguard 2: Duplicate failing command detection (infinite loop breaker)
            // If no files were edited and the identical command failed again, halt
            if (failedCommands.has(command) && successfullyEditedFiles.length === 0) {
              await flushExecutedTerminalSummary();
              if (!isReadOnlyCmd) {
                const loopMsg = {
                  id: `${Date.now()}-term-loop-${cmdCount}`,
                  role: 'assistant' as const,
                  content: `⚠️ Model proposed identical failing command \`${command}\` without file modifications. Halting self-healing retry to prevent infinite execution.`,
                  timestamp: Date.now(),
                };
                if (this._historyStore?.appendMessage) {
                  await this._historyStore.appendMessage(loopMsg);
                }
                this._postMessage({
                  type: 'MESSAGE_RECEIVED',
                  message: loopMsg,
                });
              }
              break;
            }

            // Safeguard 3: Hard limit on attempts (MAX_TERMINAL_RETRIES = 5)
            if (currentRetryCount >= MAX_TERMINAL_RETRIES) {
              await flushExecutedTerminalSummary();
              if (!isReadOnlyCmd) {
                const maxMsg = {
                  id: `${Date.now()}-term-max-${cmdCount}`,
                  role: 'assistant' as const,
                  content: `⚠️ Terminal auto-retry limit reached (${MAX_TERMINAL_RETRIES}/${MAX_TERMINAL_RETRIES} attempts). Halting self-healing loop.`,
                  timestamp: Date.now(),
                };
                if (this._historyStore?.appendMessage) {
                  await this._historyStore.appendMessage(maxMsg);
                }
                this._postMessage({
                  type: 'MESSAGE_RECEIVED',
                  message: maxMsg,
                });
              }
              break;
            }

            // Eligible for self-healing retry only for side-effecting/build/test commands (NOT read-only inspection commands)
            // If a read-only command (like git log, git status, dir, type, cat) fails, do NOT initiate self-healing or mutate workspace
            if (isReadOnlyCmd) {
              break;
            }

            failedCommands.add(command);

            // Flush terminal execution summary before posting retry notice
            await flushExecutedTerminalSummary();

            const retryNotice = {
              id: `${Date.now()}-term-retry-${cmdCount}`,
              role: 'system' as const,
              content: result.timedOut
                ? `🔄 Terminal command \`${command}\` timed out after 120s. Initiating self-healing retry (${currentRetryCount + 1}/${MAX_TERMINAL_RETRIES})...`
                : `🔄 Terminal command \`${command}\` failed with exit code ${result.exitCode}. Initiating self-healing retry (${currentRetryCount + 1}/${MAX_TERMINAL_RETRIES})...`,
              timestamp: Date.now(),
            };
            if (this._historyStore?.appendMessage) {
              await this._historyStore.appendMessage(retryNotice);
            }
            this._postMessage({
              type: 'MESSAGE_RECEIVED',
              message: retryNotice,
            });

            // Combine stdout, stderr, and error without short-circuiting so compiler/linter diagnostics are not lost
            const outputParts: string[] = [];
            if (result.stdout?.trim()) {
              outputParts.push(result.stdout.trim());
            }
            if (result.stderr?.trim()) {
              outputParts.push(result.stderr.trim());
            }
            if (outputParts.length === 0 && result.error?.trim()) {
              outputParts.push(result.error.trim());
            }
            const fullOutput = outputParts.join('\n') || (result.timedOut ? 'Command timed out after 120s' : 'Command exited with non-zero status');
            const truncatedError = fullOutput.length > 3000
              ? fullOutput.substring(0, 3000) + '\n... [output truncated]'
              : fullOutput;

            const targetModel = modelId || Configuration.getLastModel() || 'openai/gpt-4o-mini';
            const retryPrompt = result.timedOut
              ? `The previous terminal command \`${command}\` timed out after 120s.\nOutput before timeout:\n\`\`\`\n${truncatedError}\n\`\`\`\nPlease diagnose why this command hung or timed out. If this is a long-running process or watch server, run with a non-blocking, non-interactive, or single-run flag (e.g. \`flutter test\`, \`npm test -- --watchAll=false\`). Continue autonomously until all tasks and verifications succeed.`
              : `The previous terminal command \`${command}\` failed with exit code ${result.exitCode ?? 'unknown'}.\nError output:\n\`\`\`\n${truncatedError}\n\`\`\`\nPlease diagnose and resolve this failure:\n- If this is a compiler, analysis, test, or code error in the workspace: generate the necessary file edit(s) to fix the code, then re-run the verification command.\n- If this is a terminal command syntax or environment error: provide the corrected command.\nContinue autonomously until all tasks and verifications succeed.`;

            // Trigger self-healing follow-up turn
            await this._handleSendMessage(
              retryPrompt,
              targetModel,
              undefined,
              undefined,
              this._activeReasoningEffort,
              { retryCount: currentRetryCount + 1, failedCommands }
            );

            return true;
          }
        }
      }

      // Flush any completed commands from the loop into a single consolidated 1-line dropdown
      await flushExecutedTerminalSummary();
    } else if (runTerminalPerm === 'deny') {
      const bashRegex = /```(?:bash|sh|shell|cmd|powershell)\s*([\s\S]*?)```/gi;
      let match;
      let cmdCount = 0;
      while ((match = bashRegex.exec(content)) !== null) {
        const command = match[1].trim();
        if (command) {
          cmdCount++;
          const deniedMsg = {
            id: `${Date.now()}-term-denied-${cmdCount}`,
            role: 'assistant' as const,
            content: `⚠️ Terminal command \`${command.slice(0, 30)}\` was not executed — Terminal commands permission is currently set to Denied.`,
            timestamp: Date.now(),
          };
          if (this._historyStore?.appendMessage) {
            await this._historyStore.appendMessage(deniedMsg);
          }
          this._postMessage({
            type: 'MESSAGE_RECEIVED',
            message: deniedMsg,
          });
        }
      }
    }

    const MAX_AUTO_FOLLOWUPS = 10;

    // 3. Auto-continue conversation with terminal outputs so the model can complete its response
    if (
      successfulCommands.length > 0 &&
      !this._isUserCancelled &&
      !this._activeAbortController?.signal.aborted
    ) {
      const currentAutoTurns = retryContext?.autoTurnCount ?? 0;
      if (currentAutoTurns < MAX_AUTO_FOLLOWUPS) {
        const targetModel = modelId || Configuration.getLastModel() || 'openai/gpt-4o-mini';

        let continuationPrompt = `The following terminal command(s) executed successfully in the user's workspace:\n\n`;
        for (const item of successfulCommands) {
          const out = item.output.length > 3000
            ? item.output.substring(0, 3000) + '\n... [output truncated]'
            : item.output || '(No output produced)';
          continuationPrompt += `Command: \`${item.command}\`\nOutput:\n\`\`\`\n${out}\n\`\`\`\n\n`;
        }
        if (successfullyEditedFiles.length > 0) {
          continuationPrompt += `Applied file edits:\n${successfullyEditedFiles.map((f) => `- \`${f}\``).join('\n')}\n\n`;
        }

        // Check if an implementation plan already exists in history
        const history = await this._historyStore.loadHistory();
        const hasExistingPlan = history.some(
          (m) => m.role === 'assistant' && (m.planDocument || /```plan/i.test(m.content))
        );

        if (!hasExistingPlan) {
          continuationPrompt += `Based on the terminal command results above, answer the user's question directly or continue your analysis of the workspace. If implementation or file modifications are required, formulate the implementation plan inside a \`\`\`plan block. If this was a status check or informational query, conclude with your direct answer without requesting further tasks.`;
        } else {
          continuationPrompt += `Based on the terminal command results and applied changes above, please continue executing the plan autonomously until all tasks are complete and verified. Conclude with the two-tier walkthrough document when done.`;
        }

        await this._handleSendMessage(
          continuationPrompt,
          targetModel,
          undefined,
          undefined,
          this._activeReasoningEffort,
          {
            retryCount: retryContext?.retryCount ?? 0,
            failedCommands: retryContext?.failedCommands ?? new Set<string>(),
            autoTurnCount: currentAutoTurns + 1,
            isAutoFollowUp: true,
          }
        );
        return true;
      }
    }

    // 4. Autonomous Multi-Step Continuation after file edits:
    // If file edits were applied, but no terminal commands were run,
    // and no final walkthrough was emitted yet, auto-continue so the model executes the next step without pausing!
    // (Only engage if NOT in 'ask' mode and an active multi-step plan is underway!)
    if (
      !isAskMode &&
      isExecutionActive &&
      successfulCommands.length === 0 &&
      successfullyEditedFiles.length > 0 &&
      !walkthroughDocument &&
      !hasPlan &&
      !hasPlanApprovalQuestion &&
      !this._isUserCancelled &&
      !this._activeAbortController?.signal.aborted
    ) {
      const currentAutoTurns = retryContext?.autoTurnCount ?? 0;
      if (currentAutoTurns < MAX_AUTO_FOLLOWUPS) {
        const targetModel = modelId || Configuration.getLastModel() || 'openai/gpt-4o-mini';
        const continuationPrompt = `Applied the following edit(s) successfully:\n${successfullyEditedFiles.map((f) => `- \`${f}\``).join('\n')}\n\nPlease proceed directly with the next step in the implementation plan without pausing for confirmation. Reconcile your planned task checklist, implement the next pending modification, or provide the final walkthrough if all implementation and verification steps are complete.`;

        await this._handleSendMessage(
          continuationPrompt,
          targetModel,
          undefined,
          undefined,
          this._activeReasoningEffort,
          {
            retryCount: retryContext?.retryCount ?? 0,
            failedCommands: retryContext?.failedCommands ?? new Set<string>(),
            autoTurnCount: currentAutoTurns + 1,
            isAutoFollowUp: true,
          }
        );
        return true;
      }
    }

    // 5. Autonomous Conversational Stall Recovery:
    // Only engage if an active multi-step implementation plan is underway AND edits or commands were expected.
    // NEVER engage for questions, status checks, or when no plan exists or no files were modified.
    // Check if the model's message indicates completion or status check
    const isExplicitlyComplete =
      /\b(task is complete|check is complete|nothing to implement|no code changes were requested|verification complete|ready for your next request|no pending edits|unmodified|clean working tree)\b/i.test(content);

    if (
      isExecutionActive &&
      activePlanExists &&
      !isExplicitlyComplete &&
      successfullyEditedFiles.length === 0 &&
      successfulCommands.length === 0 &&
      failedEdits.length === 0 &&
      !walkthroughDocument &&
      !hasPlan &&
      !hasPlanApprovalQuestion &&
      !this._isUserCancelled &&
      !this._activeAbortController?.signal.aborted
    ) {
      const currentAutoTurns = retryContext?.autoTurnCount ?? 0;
      if (currentAutoTurns < MAX_AUTO_FOLLOWUPS) {
        const targetModel = modelId || Configuration.getLastModel() || 'openai/gpt-4o-mini';
        const continuationPrompt = `Please proceed directly with the implementation without pausing for confirmation. Reconcile your planned task checklist and emit the required file edits (\`\`\`edit_file:<path>) or terminal commands for the next step, or provide the final \`\`\`walkthrough block if all implementation and verification steps are complete.`;

        await this._handleSendMessage(
          continuationPrompt,
          targetModel,
          undefined,
          undefined,
          this._activeReasoningEffort,
          {
            retryCount: retryContext?.retryCount ?? 0,
            failedCommands: retryContext?.failedCommands ?? new Set<string>(),
            autoTurnCount: currentAutoTurns + 1,
            isAutoFollowUp: true,
          }
        );
        return true;
      }
    }

    return false;
  }

  private async _handleOpenDirectReviewer(): Promise<void> {
    if (!Configuration.getReviewerEnabled()) {
      return;
    }

    const reviewerModel = this._activeReviewerModelOverride || Configuration.getReviewerModel();
    const reviewerReasoningEffort = this._activeReviewerReasoningEffortOverride || Configuration.getReviewerReasoningEffort();

    const { activeSession } = await this._historyStore.loadReviewerSessions();
    if (activeSession.artifactContent && (activeSession.artifactType === 'plan' || activeSession.artifactType === 'walkthrough')) {
      this._activeReviewerArtifactContent = activeSession.artifactContent;
      this._activeReviewerArtifactType = activeSession.artifactType;
    } else {
      this._activeReviewerArtifactContent = undefined;
      this._activeReviewerArtifactType = undefined;
    }

    this._reviewerHistory = activeSession.messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      attachedFile: m.attachedFile,
      executionDurationMs: m.executionDurationMs,
    }));

    this._postMessage({
      type: 'REVIEWER_VIEW_DATA',
      artifactType: activeSession.artifactType || 'standalone',
      artifactContent: activeSession.artifactContent || '',
      reviewerModel,
      reviewerReasoningEffort,
      history: [...this._reviewerHistory],
      activeSessionId: activeSession.id,
    });
    await this._sendReviewerSessionsData();
  }

  private async _sendReviewerSessionsData(): Promise<void> {
    const { activeSession, allSessions } = await this._historyStore.loadReviewerSessions();
    this._postMessage({
      type: 'REVIEWER_SESSIONS_LOADED',
      sessions: allSessions,
      activeSessionId: activeSession.id,
    });
  }

  private async _handleStartReview(
    artifactType: 'plan' | 'walkthrough',
    messageId?: string,
    fallbackContent?: string
  ): Promise<void> {
    const apiKey = await this._secretStore.getApiKey();
    if (!apiKey) {
      vscode.window.showErrorMessage('No OpenRouter API key found. Please save your key first.');
      return;
    }

    let reviewerModel = this._activeReviewerModelOverride || Configuration.getReviewerModel();
    if (!reviewerModel) {
      reviewerModel = Configuration.getLastModel() || (this._cachedModels[0]?.id ?? '');
    }
    if (!reviewerModel) {
      vscode.window.showWarningMessage('Please select a Model before starting a review.');
      return;
    }

    const prepared = await ArtifactDocumentManager.prepareArtifactFile(
      this._historyStore,
      artifactType,
      messageId,
      fallbackContent,
      this._storageUri
    );

    if (!prepared) {
      vscode.window.showErrorMessage(`No ${artifactType} document content found.`);
      return;
    }

    const reviewerReasoningEffort = this._activeReviewerReasoningEffortOverride || Configuration.getReviewerReasoningEffort();
    const reviewerSystemPrompt = Configuration.getReviewerSystemPrompt();
    const sessionTitle = `Review: ${artifactType === 'plan' ? 'Plan' : 'Walkthrough'}`;
    const attachedFileRef: AttachedFileRef = {
      name: artifactType === 'plan' ? 'Plan docs' : 'Results docs',
      uri: prepared.uri.toString(),
      filePath: prepared.uri.fsPath,
      artifactType,
    };

    // Always load the persistent active reviewer session from disk to sync in-memory history.
    // This prevents a new session from being created on every startup when _reviewerHistory
    // hasn't been populated yet (e.g. user never opened the reviewer tab this session).
    const { activeSession } = await this._historyStore.loadReviewerSessions();

    // Sync in-memory history from the persisted active session if it hasn't been loaded yet.
    if (this._reviewerHistory.length === 0 && activeSession.messages.length > 0) {
      this._reviewerHistory = activeSession.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        attachedFile: m.attachedFile,
        executionDurationMs: m.executionDurationMs,
      }));
      if (activeSession.artifactContent && (activeSession.artifactType === 'plan' || activeSession.artifactType === 'walkthrough')) {
        this._activeReviewerArtifactContent = activeSession.artifactContent;
        this._activeReviewerArtifactType = activeSession.artifactType;
      }
    }

    const hasExistingMessages = activeSession.messages.length > 0 || this._reviewerHistory.length > 0;

    if (hasExistingMessages) {
      // Reviewer session already has a conversation — update artifact context and attach to input bar.
      // Do NOT create a new session, do NOT auto-send.
      this._activeReviewerArtifactContent = prepared.content;
      this._activeReviewerArtifactType = artifactType;
      this._activeReviewerArtifactName = attachedFileRef.name;
      activeSession.artifactContent = prepared.content;
      activeSession.artifactType = artifactType;
      activeSession.artifactMessageId = messageId;
      await this._historyStore.saveReviewerSessions();

      // Send REVIEWER_VIEW_DATA first so the panel fully initializes (history rendered,
      // model name shown, reasoning effort control visible) even on a cold-start push
      // where the reviewer tab was never opened this session.
      this._postMessage({
        type: 'REVIEWER_VIEW_DATA',
        artifactType,
        artifactContent: prepared.content,
        artifactUri: prepared.uri.toString(),
        messageId,
        reviewerModel,
        reviewerReasoningEffort,
        history: [...this._reviewerHistory],
        activeSessionId: activeSession.id,
      });

      // Then attach the newly pushed doc as a chip in the input bar so the user can
      // ask follow-up questions about it immediately.
      this._postMessage({
        type: 'REVIEWER_ATTACH_ARTIFACT',
        artifactType,
        artifactContent: prepared.content,
        artifactName: attachedFileRef.name,
        artifactUri: prepared.uri.toString(),
        messageId,
      });
      return;
    }

    // Active session is empty (fresh or after a reset) — reuse it for this review instead of creating a new one.
    this._activeReviewerArtifactContent = prepared.content;
    this._activeReviewerArtifactType = artifactType;
    this._activeReviewerArtifactName = attachedFileRef.name;

    // Update the existing empty session's context in-place (avoids accumulating empty session entries).
    activeSession.title = sessionTitle;
    activeSession.artifactType = artifactType;
    activeSession.artifactMessageId = messageId;
    activeSession.artifactContent = prepared.content;
    await this._historyStore.saveReviewerSessions();

    // The initial user turn displays the configured Reviewer System Prompt so the user sees the exact critique instructions.
    const initialUserPrompt = reviewerSystemPrompt;
    this._reviewerHistory = [{ role: 'user', content: initialUserPrompt, attachedFile: attachedFileRef }];
    this._lastReviewerUserPrompt = initialUserPrompt;

    await this._historyStore.appendReviewerMessage({
      id: `${Date.now()}-user`,
      role: 'user',
      content: initialUserPrompt,
      timestamp: Date.now(),
      attachedFile: attachedFileRef,
    });

    // Inform webview to navigate to reviewer view
    this._postMessage({
      type: 'REVIEWER_VIEW_DATA',
      artifactType,
      artifactContent: prepared.content,
      artifactUri: prepared.uri.toString(),
      messageId,
      reviewerModel,
      reviewerReasoningEffort,
      history: [...this._reviewerHistory],
      activeSessionId: activeSession.id,
    });
    await this._sendReviewerSessionsData();

    // Start streaming reviewer response
    await this._streamReviewerResponse(reviewerModel, reviewerReasoningEffort, reviewerSystemPrompt);
  }

  private async _handleSendReviewerMessage(
    userText: string,
    modelOverride?: string,
    reasoningEffortOverride?: string,
    artifactContent?: string,
    artifactType?: 'plan' | 'walkthrough',
    attachedFile?: AttachedFileRef & { content?: string }
  ): Promise<void> {
    const apiKey = await this._secretStore.getApiKey();
    if (!apiKey) {
      vscode.window.showErrorMessage('No OpenRouter API key found.');
      return;
    }

    if (modelOverride) {
      this._activeReviewerModelOverride = modelOverride;
    }
    if (reasoningEffortOverride) {
      this._activeReviewerReasoningEffortOverride = reasoningEffortOverride;
    }

    let effectiveContent = artifactContent || attachedFile?.content;
    if (!effectiveContent && attachedFile?.filePath) {
      try {
        const fileUri = attachedFile.filePath.startsWith('file://')
          ? vscode.Uri.parse(attachedFile.filePath)
          : path.isAbsolute(attachedFile.filePath)
            ? vscode.Uri.file(attachedFile.filePath)
            : vscode.workspace.workspaceFolders?.[0]
              ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, attachedFile.filePath)
              : undefined;
        if (fileUri) {
          const raw = await vscode.workspace.fs.readFile(fileUri);
          effectiveContent = Buffer.from(raw).toString('utf8');
        }
      } catch (err) {
        console.warn('Could not read attached file from workspace:', err);
      }
    }

    if (effectiveContent) {
      this._activeReviewerArtifactContent = effectiveContent;
      this._activeReviewerArtifactType = artifactType || attachedFile?.artifactType || 'plan';
      this._activeReviewerArtifactName =
        attachedFile?.name ||
        (this._activeReviewerArtifactType === 'walkthrough' ? 'Results docs' : 'Plan docs');

      const { activeSession } = await this._historyStore.loadReviewerSessions();
      if (activeSession) {
        activeSession.artifactContent = effectiveContent;
        activeSession.artifactType = this._activeReviewerArtifactType;
        await this._historyStore.saveReviewerSessions();
      }
    }

    const reviewerModel = this._activeReviewerModelOverride || Configuration.getReviewerModel();
    const reviewerReasoningEffort = this._activeReviewerReasoningEffortOverride || Configuration.getReviewerReasoningEffort();
    const reviewerSystemPrompt = Configuration.getReviewerSystemPrompt();

    const storedRef: AttachedFileRef | undefined = (attachedFile || effectiveContent)
      ? {
          name:
            attachedFile?.name ||
            this._activeReviewerArtifactName ||
            (this._activeReviewerArtifactType === 'walkthrough' ? 'Results docs' : 'Plan docs'),
          uri: attachedFile?.uri,
          filePath: attachedFile?.filePath,
          artifactType: attachedFile?.artifactType || this._activeReviewerArtifactType,
          content: effectiveContent,
        }
      : undefined;

    this._reviewerHistory.push({ role: 'user', content: userText, attachedFile: storedRef });
    this._lastReviewerUserPrompt = userText;

    await this._historyStore.appendReviewerMessage({
      id: `${Date.now()}-user`,
      role: 'user',
      content: userText,
      timestamp: Date.now(),
      attachedFile: storedRef,
    });

    await this._streamReviewerResponse(reviewerModel, reviewerReasoningEffort, reviewerSystemPrompt);
  }

  private async _handleRetryReviewerMessage(): Promise<void> {
    const reviewerModel = this._activeReviewerModelOverride || Configuration.getReviewerModel();
    const reviewerReasoningEffort = this._activeReviewerReasoningEffortOverride || Configuration.getReviewerReasoningEffort();
    const reviewerSystemPrompt = Configuration.getReviewerSystemPrompt();

    // Re-run stream with the current conversation history
    await this._streamReviewerResponse(reviewerModel, reviewerReasoningEffort, reviewerSystemPrompt);
  }

  private async _streamReviewerResponse(
    model: string,
    reasoningEffort: string,
    systemPrompt: string
  ): Promise<void> {
    const apiKey = await this._secretStore.getApiKey();
    if (!apiKey) return;

    this._isReviewerUserCancelled = false;
    this._postMessage({ type: 'SET_REVIEWER_BUSY', busy: true });
    this._postMessage({ type: 'REVIEWER_STREAM_START' });
    const artifactTokenEst = this._activeReviewerArtifactContent
      ? Math.round(this._activeReviewerArtifactContent.length / 4)
      : 0;
    logger.info('REVIEW', `Reviewer stream start — model: ${model}, artifact: ~${artifactTokenEst} tokens`);

    let accumulatedChunk = '';
    const abortController = new AbortController();
    this._activeReviewerAbortController = abortController;

    let effectiveSystemPrompt = systemPrompt;
    if (this._activeReviewerArtifactContent) {
      const artifactLabel =
        this._activeReviewerArtifactName ||
        (this._activeReviewerArtifactType === 'walkthrough' ? 'Results docs' : 'Plan docs');
      effectiveSystemPrompt = `${systemPrompt}\n\n# Document Under Review (${artifactLabel}):\n${this._activeReviewerArtifactContent}`;
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: effectiveSystemPrompt },
      ...this._reviewerHistory.map((m) => {
        if (m.role === 'user' && m.attachedFile?.content) {
          const docLabel =
            m.attachedFile.name ||
            (m.attachedFile.artifactType === 'walkthrough' ? 'Results docs' : 'Plan docs');
          const augmentedContent = `${m.content}\n\n---\n# Attached Document Under Review (${docLabel}):\n${m.attachedFile.content}\n---`;
          return { role: m.role, content: augmentedContent };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    const dataPolicy = Configuration.getDataCollectionPolicy();
    const providerOptions: ProviderRoutingOptions = {
      data_collection: dataPolicy,
      zdr: dataPolicy === 'deny',
    };
    const reviewerStartTime = Date.now();

    await OpenRouterClient.sendChatCompletionStream(
      apiKey,
      model,
      messages,
      (chunk) => {
        accumulatedChunk += chunk;
        this._postMessage({
          type: 'REVIEWER_STREAM_CHUNK',
          chunk,
        });
      },
      async (usage) => {
        if (this._isReviewerUserCancelled || abortController.signal.aborted) {
          this._activeReviewerAbortController = undefined;
          this._postMessage({ type: 'SET_REVIEWER_BUSY', busy: false });
          return;
        }
        this._activeReviewerAbortController = undefined;
        const executionDurationMs = Date.now() - reviewerStartTime;
        this._reviewerHistory.push({ role: 'assistant', content: accumulatedChunk, executionDurationMs });

        await this._historyStore.appendReviewerMessage({
          id: `${Date.now()}-assistant`,
          role: 'assistant',
          content: accumulatedChunk,
          model,
          timestamp: Date.now(),
          executionDurationMs,
        });

        if (usage) {
          const modelObj = this._cachedModels.find((m) => m.id === model);
          const cost = PricingCalculator.calculateCost(
            usage.prompt_tokens,
            usage.completion_tokens,
            modelObj?.pricing
          );

          let loggedModelName = model;
          if (reasoningEffort) {
            const formattedEffort =
              reasoningEffort.charAt(0).toUpperCase() + reasoningEffort.slice(1).toLowerCase();
            loggedModelName = `${model} (${formattedEffort})`;
          }

          // Log strictly as type: "reviewer"
          await this._usageStore.appendRecord({
            type: 'reviewer',
            project: ProjectResolver.getActiveProjectName(),
            model: loggedModelName,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            cost,
          });
        }

        this._postMessage({
          type: 'REVIEWER_STREAM_DONE',
          executionDurationMs,
          usage,
        });
        this._postMessage({ type: 'SET_REVIEWER_BUSY', busy: false });
        await this._sendReviewerSessionsData();
      },
      (err) => {
        this._activeReviewerAbortController = undefined;
        this._postMessage({ type: 'SET_REVIEWER_BUSY', busy: false });

        const isPartial = accumulatedChunk.trim().length > 0;
        if (isPartial) {
          // Case 3: Partial stream received, then error
          this._reviewerHistory.push({
            role: 'assistant',
            content: `${accumulatedChunk}\n\n[Response interrupted]`,
          });
        }

        this._postMessage({
          type: 'REVIEWER_STREAM_ERROR',
          message: err.message || 'Reviewer request failed',
          partial: isPartial,
          canRetry: true,
        });
      },
      providerOptions,
      abortController.signal,
      reasoningEffort
    );
  }

  private _postMessage(message: HostToWebviewMessage) {
    this._view?.webview.postMessage(message);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'ui', 'style.css')
    );
    const reviewerEnabled = Configuration.getReviewerEnabled();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>OpenRouter</title>
</head>
<body>
  <!-- Auth / Onboarding Section -->
  <div id="auth-section" class="welcome-box hidden">
    <h3>Welcome to OpenRouter</h3>
    <p>Enter your API key to connect to OpenRouter and start chatting with any model.</p>
    <div class="input-row">
      <input type="password" id="api-key-input" class="input-text" placeholder="sk-or-v1-..." />
      <button id="save-key-btn" class="btn">Connect</button>
    </div>
    <a href="https://openrouter.ai/keys" target="_blank" class="link">Get API key from OpenRouter ↗</a>
  </div>

  <!-- Main Application Wrapper -->
  <div id="chat-section" class="hidden" style="display:flex; flex-direction:column; height:100%;">
    <!-- TAB 1: Chat View -->
    <div id="view-chat" class="tab-content-view" style="display:flex; flex-direction:column; flex:1; min-height:0;">
      <div class="header-bar">
        <div class="header-top">
          <div class="combobox-container">
            <div class="combobox-input-wrapper">
              <input type="text" id="model-search-input" class="combobox-input" placeholder="Search models..." autocomplete="off" />
              <span class="combobox-arrow">▼</span>
            </div>
            <div id="model-dropdown" class="combobox-dropdown hidden"></div>
          </div>
          <div id="reasoning-effort-container" class="reasoning-effort-container hidden">
            <select id="reasoning-effort-select" class="reasoning-effort-select" title="Reasoning Effort">
              <option value="low">Low</option>
              <option value="medium" selected>Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div class="session-dropdown-container">
            <button id="new-chat-btn" class="icon-btn" title="New chat / Conversation history">➕</button>
            <div id="session-dropdown" class="session-dropdown hidden">
              <div class="session-dropdown-header">
                <span>Chat Sessions</span>
              </div>
              <div id="session-item-new" class="session-menu-action">
                <span class="action-icon">➕</span>
                <span class="action-text">Start New Chat</span>
              </div>
              <div class="session-dropdown-divider"></div>
              <div class="session-history-title">Previous Chats</div>
              <div id="session-history-list" class="session-history-list"></div>
            </div>
          </div>
          <button id="reviewer-toggle-btn" class="icon-btn${reviewerEnabled ? '' : ' hidden'}" title="Open Reviewer Panel">🔍</button>
          <button id="settings-btn" class="icon-btn" title="Open Settings & Permissions">⚙️</button>
        </div>
        
        <div class="capability-badges">
          <span id="vision-badge" class="badge">👁️ Vision</span>
          <span id="audio-badge" class="badge">🎙️ Audio</span>
          <span id="tools-badge" class="badge">⚙️ Tools</span>
          <span id="agentic-badge" class="badge agentic-badge" title="Model capability tier">⚡ Agentic</span>
        </div>
        <div id="capability-notice-banner" class="capability-notice-banner hidden">
          <span id="capability-notice-text"></span>
          <button id="capability-notice-close" class="banner-close-btn" title="Dismiss">✕</button>
        </div>
        <div id="zdr-hidden-banner" class="capability-notice-banner hidden" style="border-left-color: var(--vscode-charts-orange);">
          <span id="zdr-hidden-text"></span>
          <button id="zdr-hidden-close" class="banner-close-btn" title="Dismiss">✕</button>
        </div>
      </div>

      <!-- Messages feed -->
      <div style="position:relative; flex:1; min-height:0; display:flex; flex-direction:column;">
        <div id="messages-container" class="chat-container"></div>
        <button id="main-scroll-bottom-btn" class="scroll-bottom-btn hidden" title="Scroll to bottom">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      </div>

      <!-- Input Bar -->
      <div class="input-bar">
        <!-- Persistent Pending-Edits Bar (Phase 3 Amendment) -->
        <div id="pending-edits-bar" class="pending-edits-bar hidden">
          <div class="pending-edits-header">
            <div class="pending-edits-title">
              <span class="pending-edits-icon">⚡</span>
              <span id="pending-edits-count" class="pending-edits-count">Pending Edits (0)</span>
            </div>
            <div id="pending-edits-bulk-actions" class="pending-edits-bulk-actions hidden">
              <button id="apply-all-edits-btn" class="btn btn-sm" title="Apply all pending edits together">Apply All</button>
              <button id="reject-all-edits-btn" class="btn secondary btn-sm" title="Reject all pending edits">Reject All</button>
            </div>
          </div>
          <div id="pending-edits-list" class="pending-edits-list"></div>
        </div>

        <!-- Context Preview Pill (PRD Phase 7 §7.2) -->
        <div id="context-preview-bar" class="context-preview-bar hidden">
          <div class="context-preview-header" id="context-preview-toggle">
            <span class="context-icon">📎</span>
            <span id="context-preview-summary" class="context-summary">Context included: 0 files</span>
            <span class="context-expand-icon" id="context-expand-arrow">▾</span>
          </div>
          <div id="context-preview-details" class="context-preview-details hidden">
            <div id="context-details-content" class="context-details-content"></div>
          </div>
        </div>

        <!-- Attachment preview pill -->
        <div id="attachment-preview-bar" class="attachment-preview-bar hidden">
        </div>

        <div class="input-box-wrapper" id="input-box-wrapper">
          <textarea id="prompt-input" rows="1" placeholder="Ask, edit, or run something..."></textarea>
          <input type="file" id="image-file-input" accept="image/*" style="display:none;" />
          <input type="file" id="doc-file-input" accept=".txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.cpp,.c,.h,.css,.html,.yaml,.yml,.toml,.sh,.bash,.csv,text/*" style="display:none;" />
          <div class="input-inline-actions">
            <button id="copy-input-btn" class="inline-icon-btn" title="Copy input text">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
            <button id="context-history-btn" class="inline-icon-btn" title="Add context / reference">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 14 4 9 9 4"></polyline>
                <path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>
              </svg>
            </button>
            <button id="attach-file-btn" class="inline-icon-btn" title="Attach file">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
              </svg>
            </button>
            <button id="upload-img-btn" class="inline-icon-btn" title="Attach image">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="3" ry="3"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
            </button>
            <button id="voice-input-btn" class="inline-icon-btn" title="Voice input">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="22"></line>
                <line x1="8" y1="22" x2="16" y2="22"></line>
              </svg>
            </button>
            <button id="send-btn" class="inline-send-btn" title="Send (Enter)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"></line>
                <polyline points="12 5 19 12 12 19"></polyline>
              </svg>
            </button>
            <button id="stop-btn" class="inline-stop-btn hidden" title="Stop generating">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="5" width="14" height="14" rx="2"></rect>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Footer Strip -->
      <div class="footer-strip">
        <span id="status-text">Ready</span>
        <span id="token-meter">0 tokens</span>
      </div>
    </div>

    <!-- TAB 2: Usage Report View (Accessed via Settings) -->
    <div id="view-usage" class="tab-content-view hidden" style="display:flex; flex-direction:column; flex:1; min-height:0; overflow:hidden;">
      <div class="settings-header-strip" style="display:flex; align-items:center; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--sidebar-bg); flex-shrink:0; z-index:10;">
        <button id="usage-back-btn" class="settings-back-btn">‹ Usage Report</button>
      </div>

      <div id="usage-scroll-body" style="display:flex; flex-direction:column; flex:1; min-height:0; overflow-y:auto; padding:16px; gap:14px;">

      <!-- Summary Spend Cards -->
      <div class="spend-cards-row">
        <div class="spend-card">
          <div class="spend-label">Today</div>
          <div id="spend-today" class="spend-val">$0.00</div>
        </div>
        <div class="spend-card">
          <div class="spend-label">This Week</div>
          <div id="spend-week" class="spend-val">$0.00</div>
        </div>
        <div class="spend-card">
          <div class="spend-label">This Month</div>
          <div id="spend-month" class="spend-val">$0.00</div>
        </div>
        <div class="spend-card">
          <div class="spend-label">Total Cost</div>
          <div id="spend-total" class="spend-val">$0.00</div>
        </div>
      </div>

      <!-- Filters & Export Strip -->
      <div class="usage-filter-strip">
        <select id="filter-project" class="usage-select">
          <option value="all">All Projects</option>
        </select>
        <select id="filter-model" class="usage-select">
          <option value="all">All Models</option>
        </select>
        <button id="export-csv-btn" class="btn secondary" style="font-size:11px; padding:4px 8px;">📥 Export CSV</button>
      </div>

      <!-- Audit Log Table -->
      <div class="audit-table-wrapper">
        <table class="audit-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Model / Command</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody id="audit-table-body">
            <tr>
              <td colspan="6" style="text-align:center; opacity:0.6; padding:16px;">No usage logged yet</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

    <!-- TAB 3: In-Panel Settings View (Matching User Mockup) -->
    <div id="view-settings" class="tab-content-view hidden" style="display:flex; flex-direction:column; flex:1; min-height:0; overflow:hidden;">
      <!-- Pinned Header Strip -->
      <div class="settings-header-strip" style="display:flex; align-items:center; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--sidebar-bg); flex-shrink:0; z-index:10;">
        <button id="settings-back-btn" class="settings-back-btn">‹ Settings</button>
      </div>

      <!-- Scrollable Settings Body -->
      <div id="settings-scroll-body" style="display:flex; flex-direction:column; flex:1; min-height:0; overflow-y:auto; padding:16px; gap:18px;">

      <!-- Account Section -->
      <div class="settings-group">
        <div class="settings-group-title">Account</div>
        <div class="settings-row">
          <span id="settings-masked-key" class="settings-masked-text">sk-or-••••••••••••</span>
          <button id="settings-update-key-btn" class="btn secondary">Update key</button>
        </div>
      </div>

      <!-- Permissions Section -->
      <div class="settings-group">
        <div class="settings-group-title">Permissions</div>
        <div class="permission-list">
          <div class="permission-row" data-cat="readActiveContext">
            <span>Read open file for context</span>
            <button class="perm-pill allow">Allowed</button>
          </div>
          <div class="permission-row" data-cat="applyEdit">
            <span>Code edits</span>
            <button class="perm-pill ask">Ask each time</button>
          </div>
          <div class="permission-row" data-cat="runTerminalCommand">
            <span>Terminal commands</span>
            <button class="perm-pill ask">Ask each time</button>
          </div>
          <div class="permission-row" data-cat="readWorkspaceFiles">
            <span>Access other workspace files</span>
            <button class="perm-pill allow">Allowed</button>
          </div>
        </div>
        <button id="reset-permissions-btn" class="btn secondary" style="margin-top:8px;">Reset all permissions</button>
      </div>

      <!-- Context management Section -->
      <div class="settings-group">
        <div class="settings-group-title">Context management</div>
        <label class="checkbox-row">
          <span>Auto-summarize long chats</span>
          <input type="checkbox" id="chk-auto-summarize" checked />
        </label>
        <label class="checkbox-row">
          <span>Full history resend on model switch</span>
          <input type="checkbox" id="chk-full-history" />
        </label>
      </div>

      <!-- Privacy & Data Handling Section (PRD Phase 7) -->
      <div class="settings-group">
        <div class="settings-group-title">Privacy &amp; Data Handling</div>
        <label class="checkbox-row">
          <span>Enforce Zero Data Retention (ZDR / No Training)</span>
          <input type="checkbox" id="chk-strict-zdr" checked />
        </label>
        <label class="checkbox-row">
          <span>Warn when model allows data training</span>
          <input type="checkbox" id="chk-warn-training" checked />
        </label>
        <div class="settings-row" style="margin-top: 6px;">
          <span style="font-size: 11px; opacity: 0.9;">Secret Redaction</span>
          <select id="settings-redaction-mode" class="settings-select" style="max-width: 140px;">
            <option value="mask">Mask Auto</option>
            <option value="block_and_warn">Block &amp; Warn</option>
          </select>
        </div>
        <div style="margin-top: 8px; font-size: 11px;">
          <a href="https://openrouter.ai/privacy" target="_blank" style="color: var(--vscode-textLink-foreground); text-decoration: none;">
            🔗 OpenRouter Privacy &amp; Data Policy documentation
          </a>
        </div>
        <div style="margin-top: 4px; font-size: 10px; opacity: 0.65; line-height: 1.3;">
          Note: Existing chat history saved prior to enabling secret redaction is persisted as-is and not retroactively rescanned.
        </div>
      </div>

      <!-- Reviewer Model Section (PRD Phase 10 - Per-Workspace) -->
      <div class="settings-group">
        <div class="settings-group-title">Reviewer Model (Per-Workspace)</div>
        <label class="checkbox-row">
          <span>Enable Reviewer Model</span>
          <input type="checkbox" id="chk-reviewer-enabled" />
        </label>
        
        <!-- Controls visible only when Enable Reviewer Model is checked -->
        <div id="reviewer-config-container" class="reviewer-config-container hidden" style="display:flex; flex-direction:column; gap:10px; margin-top:4px;">
          <!-- Reviewer Model & Reasoning Effort Row (Side-by-side with Smart Visibility) -->
          <div class="reviewer-model-row" style="display:flex; gap:8px; align-items:flex-start; width:100%;">
            <!-- Searchable Reviewer Model Combobox -->
            <div class="reviewer-field-group" style="flex:1; min-width:0;">
              <label class="settings-field-label">Reviewer Model</label>
              <div class="combobox-container" style="position:relative; width:100%;">
                <div class="combobox-input-wrapper">
                  <input type="text" id="reviewer-model-search-input" class="combobox-input" placeholder="Select reviewer model..." autocomplete="off" />
                  <span class="combobox-arrow">▼</span>
                </div>
                <div id="reviewer-model-dropdown" class="combobox-dropdown hidden"></div>
              </div>
              <div id="reviewer-model-warning" class="reviewer-model-warning hidden" style="font-size:11px; color:#e3b341; margin-top:2px;">
                ⚠️ Please pick a reviewer model for this workspace.
              </div>
            </div>

            <!-- Reasoning Effort Selection (Shown on same row if reviewer model supports reasoning) -->
            <div id="reviewer-reasoning-container" class="reviewer-field-group hidden" style="width:115px; flex-shrink:0;">
              <label class="settings-field-label" style="white-space:nowrap;">Reasoning Effort</label>
              <select id="reviewer-reasoning-select" class="settings-select" style="width:100%; height:26px; padding:3px 6px; font-size:11.5px; border-radius:4px;">
                <option value="low">Low</option>
                <option value="medium" selected>Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>

          <!-- Editable Reviewer System Prompt -->
          <div class="reviewer-field-group">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <label class="settings-field-label" style="margin-bottom:0;">Reviewer System Prompt</label>
              <button id="reset-reviewer-prompt-btn" class="btn secondary" style="font-size:11px; padding:2px 8px;" title="Restore default prompt for this workspace">Reset to Default</button>
            </div>
            <textarea id="reviewer-system-prompt" class="settings-textarea" rows="6" placeholder="Enter custom reviewer prompt..."></textarea>
          </div>
        </div>
      </div>

      <!-- Usage data Section -->
      <div class="settings-group">
        <div class="settings-group-title">Usage data</div>
        <div class="settings-actions-row">
          <button id="settings-view-usage-btn" class="btn secondary">📊 View usage report</button>
          <button id="settings-view-logs-btn" class="btn secondary">View logs</button>
          <button id="settings-clear-history-btn" class="btn secondary danger-outline" style="margin-left: auto;">Clear history</button>
        </div>
      </div>

      <!-- Version Footer -->
      <div class="settings-version-footer">
        <span>OpenRouter v${EXTENSION_VERSION}</span>
      </div>
    </div>
  </div>

    <!-- TAB 4: Dedicated Reviewer View (PRD Phase 11) -->
    <div id="view-reviewer" class="tab-content-view hidden" style="display:flex; flex-direction:column; flex:1; min-height:0; overflow:hidden;">
      <!-- Reviewer Header with In-Panel Model Switcher & Reviewer Sessions -->
      <div class="header" style="border-bottom:1px solid var(--border); padding:8px 10px; display:flex; flex-direction:column; gap:6px; background:var(--vscode-sideBar-background);">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
          <button id="reviewer-back-btn" class="settings-back-btn" style="background:none; border:none; color:var(--vscode-foreground); cursor:pointer; font-size:12px; font-weight:600; display:flex; align-items:center; gap:4px; padding:2px 4px;">
            ‹ Chat
          </button>
          
          <!-- In-Panel Searchable Reviewer Model Selector -->
          <div class="combobox-container" style="flex:1; max-width:200px; position:relative;">
            <div class="combobox-input-wrapper">
              <input type="text" id="reviewer-panel-model-input" class="combobox-input" placeholder="Reviewer Model..." autocomplete="off" style="font-size:11px; padding:3px 6px;" />
              <span class="combobox-arrow">▼</span>
            </div>
            <div id="reviewer-panel-model-dropdown" class="combobox-dropdown hidden"></div>
          </div>

          <!-- Reviewer Reasoning Effort Selector -->
          <div id="reviewer-panel-reasoning-container" class="reasoning-effort-container hidden">
            <select id="reviewer-panel-reasoning-select" class="reasoning-effort-select" title="Reviewer Reasoning Effort" style="font-size:11px; padding:2px 4px;">
              <option value="low">Low</option>
              <option value="medium" selected>Medium</option>
              <option value="high">High</option>
            </select>
          </div>

          <!-- Start Fresh / Context Reset Action -->
          <button id="reviewer-reset-context-btn" class="icon-btn" title="Start fresh from here (reset reviewer context)" style="font-size:12px; padding:3px 6px;">🔄</button>
        </div>

        <!-- Drop-with-notice warning banner for in-panel model switch -->
        <div id="reviewer-capability-notice-banner" class="capability-notice-banner hidden" style="margin:0;">
          <span id="reviewer-capability-notice-text"></span>
          <button id="reviewer-capability-notice-close" class="banner-close-btn" title="Dismiss">✕</button>
        </div>
      </div>

      <!-- Split Container: Artifact Preview on top / collapsible & Conversation below -->
      <div style="display:flex; flex-direction:column; flex:1; min-height:0; position:relative;">
        <!-- Artifact Reference Header & Collapsible Document Preview (Deprecated in favor of in-chat file reference card) -->
        <div id="reviewer-artifact-section" class="reviewer-artifact-section hidden" style="display:none; border-bottom:1px solid var(--border); background:rgba(0,0,0,0.15);">
          <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 12px;">
            <div style="display:flex; align-items:center; gap:6px; font-size:11.5px; font-weight:500;">
              <span>📄</span>
              <span id="reviewer-artifact-label">Artifact Document</span>
            </div>
            <div style="display:flex; gap:6px;">
              <button id="reviewer-open-tab-btn" class="btn secondary" style="font-size:10.5px; padding:2px 6px;" title="Open document in VS Code editor tab for line-specific commenting">
                Open in Tab
              </button>
              <button id="reviewer-toggle-artifact-btn" class="btn secondary" style="font-size:10.5px; padding:2px 6px;">
                Collapse
              </button>
            </div>
          </div>
          <div id="reviewer-artifact-preview-body" style="max-height:140px; overflow-y:auto; padding:6px 12px; font-size:11px; font-family:var(--vscode-editor-font-family, monospace); background:rgba(0,0,0,0.25); border-top:1px solid rgba(255,255,255,0.05); white-space:pre-wrap; word-break:break-word;"></div>
        </div>

        <!-- Reviewer Messages feed -->
        <div style="position:relative; flex:1; min-height:0; display:flex; flex-direction:column;">
          <div id="reviewer-messages" class="messages-container chat-container" style="flex:1; min-height:0; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:12px;"></div>
          <button id="reviewer-scroll-bottom-btn" class="scroll-bottom-btn hidden" title="Scroll to bottom">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>

          <!-- Floating Selection Toolbar for Selective Return to Main Model -->
          <div id="reviewer-selection-toolbar" class="hidden" style="position:absolute; bottom:20px; left:50%; transform:translateX(-50%); background:#1f242c; border:1px solid var(--border); border-radius:6px; padding:4px 8px; box-shadow:0 4px 12px rgba(0,0,0,0.4); display:flex; align-items:center; gap:8px; z-index:100;">
            <span style="font-size:11px; color:#8b949e;">Selected text</span>
            <button id="reviewer-clarify-selection-btn" class="btn secondary" style="font-size:11px; padding:2px 8px;">
              💬 Clarify Selection
            </button>
            <button id="reviewer-send-selection-btn" class="btn primary" style="font-size:11px; padding:2px 8px;">
              ↵ Send to Main Model
            </button>
          </div>
        </div>

        <!-- Shared-UX Reviewer Input Bar -->
        <div class="input-bar" style="border-top:1px solid var(--border); background:var(--vscode-sideBar-background); padding:8px 10px;">
          <!-- Reviewer Attachment preview bar (Images & Text) -->
          <div id="reviewer-attachment-preview-bar" class="attachment-preview-bar hidden"></div>

          <div class="input-box-wrapper" id="reviewer-input-box-wrapper">
            <textarea id="reviewer-prompt-input" rows="1" placeholder="Converse with reviewer..."></textarea>
            <input type="file" id="reviewer-image-file-input" accept="image/*" style="display:none;" />
            <input type="file" id="reviewer-doc-file-input" accept=".txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.cpp,.c,.h,.css,.html,.yaml,.yml,.toml,.sh,.bash,.csv,text/*" style="display:none;" />
            <div class="input-inline-actions">
              <button id="reviewer-attach-file-btn" class="inline-icon-btn" title="Attach file">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
                </svg>
              </button>
              <button id="reviewer-upload-img-btn" class="inline-icon-btn" title="Attach image">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="3" ry="3"></rect>
                  <circle cx="8.5" cy="8.5" r="1.5"></circle>
                  <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
              </button>
              <button id="reviewer-send-btn" class="inline-send-btn" title="Send to Reviewer (Enter)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                  <polyline points="12 5 19 12 12 19"></polyline>
                </svg>
              </button>
              <button id="reviewer-stop-btn" class="inline-stop-btn hidden" title="Stop generating">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="5" y="5" width="14" height="14" rx="2"></rect>
                </svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Reviewer Footer Strip with Visible Context Meter -->
        <div class="footer-strip" style="display:flex; justify-content:space-between; align-items:center; padding:4px 10px; font-size:10px; opacity:0.8; border-top:1px solid var(--border);">
          <span id="reviewer-status-text">Ready</span>
          <span id="reviewer-token-meter" title="Reviewer conversation context usage">0 tokens</span>
        </div>
      </div>
    </div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
