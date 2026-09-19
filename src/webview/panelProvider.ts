import * as vscode from 'vscode';
import * as path from 'path';
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
import { HostToWebviewMessage, WebviewToHostMessage } from './messages';
import { SecretScanner } from '../privacy/secretScanner';
import { DiagnosticManager, StructuredDiagnostic } from '../diagnostics/diagnosticManager';

import { UsageStore } from '../usage/usageStore';
import { PricingCalculator } from '../api/pricing';
import { ProjectResolver } from '../usage/projectResolver';
import { buildSystemPrompt } from '../prompt/systemPrompt';
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
  private _reviewerCommentController?: ReviewerCommentController;
  private _reviewerHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private _activeReviewerAbortController?: AbortController;
  private _activeReviewerModelOverride?: string;
  private _activeReviewerReasoningEffortOverride?: string;
  private _lastReviewerUserPrompt?: string;
  private _activeReviewerArtifactContent?: string;
  private _activeReviewerArtifactType?: 'plan' | 'walkthrough';

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
          const key = await this._secretStore.getApiKey();
          if (key) {
            this._cachedModels = [];
            await this._loadModels(key);
          }
          break;
        }

        case 'SEND_MESSAGE':
          await this._handleSendMessage(data.content, data.modelId, data.images, data.messageId, data.reasoningEffort);
          break;

        case 'STOP_STREAM':
          if (this._activeAbortController) {
            this._activeAbortController.abort();
            this._activeAbortController = undefined;
          }
          this._postMessage({ type: 'SET_BUSY', busy: false });
          break;

        case 'PREVIEW_DIFF': {
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
            data.artifactType
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
          this._reviewerHistory = msgs.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
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
          // Manual "Start fresh from here": Clear current reviewer session turns
          this._reviewerHistory = [];
          const { activeSession } = await this._historyStore.loadReviewerSessions();
          await this._historyStore.startNewReviewerSession('Review Session (Fresh)');
          await this._handleOpenDirectReviewer();
          break;
        }

        case 'STOP_REVIEWER_STREAM': {
          if (this._activeReviewerAbortController) {
            this._activeReviewerAbortController.abort();
            this._activeReviewerAbortController = undefined;
          }
          this._postMessage({ type: 'SET_REVIEWER_BUSY', busy: false });
          break;
        }

        case 'ACCEPT_EDIT': {
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
            let checkpointId: string | undefined;
            if (this._checkpointManager) {
              const res = await this._checkpointManager.createCheckpoint(
                [data.filePath],
                `Before edit ${data.editId}`
              );
              if (res) {
                checkpointId = res;
              }
            }

            // Step 3: Apply the workspace edit (skipPermissionCheck: true because already checked and approved above)
            const success = await DiffPreviewManager.applyEdit(
              fileUri,
              data.newContent,
              this._permissionManager,
              true
            );

            // Step 4: Tag the most-recent user message with this checkpoint so the undo
            // icon in the user message header is always-visible and scoped to this turn.
            if (checkpointId && success) {
              const history = await this._historyStore.loadHistory();
              const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
              if (lastUserMsg) {
                const existing = lastUserMsg.affectedFiles ?? [];
                const merged = Array.from(new Set([...existing, data.filePath]));
                await this._historyStore.tagTurnCheckpoint(lastUserMsg.id, checkpointId, merged);
              }
            }

            this._postMessage({
              type: 'EDIT_APPLIED',
              editId: data.editId,
              success,
              checkpointId,
            });
          }
          break;
        }

        case 'ACCEPT_ALL_EDITS': {
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
              const success = await DiffPreviewManager.applyEdit(
                item.fileUri,
                item.edit.newContent,
                this._permissionManager,
                true
              );

              this._postMessage({
                type: 'EDIT_APPLIED',
                editId: item.edit.editId,
                success,
                checkpointId, // All edits share this common checkpointId for unified per-turn undo
              });
            }

            // Step 4: Tag the most-recent user message with the unified checkpoint
            if (checkpointId) {
              const history = await this._historyStore.loadHistory();
              const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
              if (lastUserMsg) {
                await this._historyStore.tagTurnCheckpoint(lastUserMsg.id, checkpointId, affectedFiles);
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

          // 1. Pre-flight & Confirmation
          const messagesAfter = await this._historyStore.getMessagesAfter(data.messageId);
          const n = messagesAfter.length;
          console.log('[panelProvider] getMessagesAfter returned count:', n, 'for target messageId:', data.messageId);
          if (n === 0) {
            console.log('[panelProvider] No subsequent history to undo (n === 0).');
            // Nothing subsequent to clear or revert (safe no-op)
            this._postMessage({
              type: 'UNDO_RESULT',
              checkpointId: data.checkpointId,
              messageId: data.messageId,
              success: false,
              message: 'No subsequent history to undo.',
            });
            break;
          }

          // Gather affected files across the turn and any subsequent turns being rolled back
          const affectedFilesSet = new Set<string>(data.affectedFiles || []);
          for (const m of messagesAfter) {
            if (m.affectedFiles) {
              for (const f of m.affectedFiles) {
                affectedFilesSet.add(f);
              }
            }
          }
          const targetFiles = Array.from(affectedFilesSet);

          // Confirmation dialog
          const msgCountText = `${n} later message${n === 1 ? '' : 's'}`;
          const confirmChoice = await vscode.window.showWarningMessage(
            `This will undo this change and remove ${msgCountText} from this chat — this cannot be undone. Continue?`,
            { modal: true },
            'Continue',
            'Cancel'
          );

          if (confirmChoice !== 'Continue') {
            this._postMessage({
              type: 'UNDO_RESULT',
              checkpointId: data.checkpointId,
              messageId: data.messageId,
              success: false,
              message: 'Cancelled',
            });
            break;
          }

          // 2. Drift Detection
          const filesSummary = targetFiles.length === 1
            ? targetFiles[0]
            : `${targetFiles.length} files (${targetFiles.join(', ')})`;

          let restoreSuccess = false;
          if (targetFiles.length > 0 && data.checkpointId) {
            const res = await this._scopedRestore.restore(data.checkpointId, targetFiles, false);
            if (res.drifted) {
              const driftChoice = await vscode.window.showWarningMessage(
                `One or more files (${filesSummary}) have been manually modified since this AI edit. Undo anyway and overwrite manual changes?`,
                { modal: true },
                'Undo Anyway',
                'Cancel'
              );

              if (driftChoice === 'Undo Anyway') {
                const forced = await this._scopedRestore.restore(data.checkpointId, targetFiles, true);
                restoreSuccess = forced.success;
              } else {
                // Cancelled drift warning — ABORT immediately without touching files or history
                this._postMessage({
                  type: 'UNDO_RESULT',
                  checkpointId: data.checkpointId,
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
            // Conversational-only turn (no files modified)
            restoreSuccess = true;
          }

          // 3. Scoped File Restore Verification
          if (!restoreSuccess) {
            this._postMessage({
              type: 'UNDO_RESULT',
              checkpointId: data.checkpointId,
              messageId: data.messageId,
              success: false,
              message: 'Failed to revert workspace files.',
            });
            break;
          }

          // 4. Update shadow repo HEAD ref to target checkpoint
          if (this._shadowRepo && data.checkpointId) {
            try {
              await this._shadowRepo.runGit(['update-ref', 'HEAD', data.checkpointId]);
            } catch (err) {
              console.warn('[PanelProvider] Could not update shadow git HEAD:', err);
            }
          }

          // 5. Only NOW truncate historyStore
          await this._historyStore.truncateAfter(data.messageId);

          // 6. Post success to Webview UI
          this._postMessage({
            type: 'UNDO_RESULT',
            checkpointId: data.checkpointId,
            messageId: data.messageId,
            truncatedAfterId: data.messageId,
            success: true,
            message: 'Reverted and chat truncated',
          });
          break;
        }


        case 'OPEN_FILE': {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, data.filePath);
            try {
              const doc = await vscode.workspace.openTextDocument(fileUri);
              await vscode.window.showTextDocument(doc, { preview: false });
            } catch (err) {
              vscode.window.showErrorMessage(`Could not open file: ${data.filePath}`);
            }
          }
          break;
        }

        case 'REJECT_EDIT':
          // Silently handle rejection without popping up an intrusive notification toast
          break;

        case 'RUN_TERMINAL':
          await CommandRunner.executeCommand(data.command, this._permissionManager, this._usageStore);
          break;

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
          await this._permissionManager.setPermission(data.category as any, next);
          await this._sendSettingsData();
          break;
        }

        case 'RESET_PERMISSIONS':
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

        case 'OPEN_SETTINGS':
          await this._sendSettingsData();
          break;

        case 'CLEAR_HISTORY':
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
          await this._historyStore.startNewSession();
          await this._loadChatHistory();
          await this._sendSessionsData();
          break;

        case 'SWITCH_SESSION':
          await this._historyStore.switchSession(data.sessionId);
          await this._loadChatHistory();
          await this._sendSessionsData();
          break;

        case 'RENAME_SESSION':
          await this._historyStore.renameSession(data.sessionId, data.newTitle);
          await this._sendSessionsData();
          break;

        case 'DELETE_SESSION':
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
      messages: activeSession.messages.map((h) => ({
        id: h.id,
        role: h.role,
        content: h.content,
        images: h.images,
        timestamp: h.timestamp,
        checkpointId: h.checkpointId,
        affectedFiles: h.affectedFiles,
        planDocument: h.planDocument,
        walkthroughDocument: h.walkthroughDocument,
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
    reasoningEffort?: string
  ) {
    const apiKey = await this._secretStore.getApiKey();
    if (!apiKey) {
      vscode.window.showErrorMessage('No OpenRouter API key found. Please save your key first.');
      return;
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
    await this._historyStore.appendMessage({
      id: clientMessageId || `${Date.now()}-user`,
      role: 'user',
      content: processedContent,
      images,
      model: selectedModel,
      timestamp: Date.now(),
    });

    const assistantMessageId = `${Date.now()}-assistant`;
    this._postMessage({ type: 'SET_BUSY', busy: true });
    this._postMessage({ type: 'MESSAGE_STREAM_START', messageId: assistantMessageId });

    // Build context-aware prompt messages
    const history = await this._historyStore.loadHistory();
    const chatMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatMessageContentPart[] }> = [];

    // Workspace file tree injection so the assistant knows about all files in the project
    const workspaceFiles = await ContextReader.listWorkspaceFiles(this._permissionManager);
    let referencedFileResult: { relativePath: string; content: string } | null = null;

    // Auto-detect if user is asking about a specific file (e.g. "what's in test.py" or "check main.ts")
    const fileMentionMatch = processedContent.match(/([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)/);
    if (fileMentionMatch) {
      const mentionedName = fileMentionMatch[1];
      const matched = await ContextReader.findAndReadWorkspaceFile(mentionedName, this._permissionManager);
      if (matched && matched.relativePath !== editorCtx.relativePath) {
        referencedFileResult = matched;
      }
    }

    const terminalOutputs = TerminalOutputTracker.getRecentOutputsFormatted();

    const systemPrompt = buildSystemPrompt({
      activeFile: editorCtx.hasContext && editorCtx.relativePath ? {
        relativePath: editorCtx.relativePath,
        languageId: editorCtx.languageId,
        selectedText: editorCtx.selectedText,
        fileContent: editorCtx.fileContent,
      } : undefined,
      workspaceFiles,
      referencedFile: referencedFileResult || undefined,
      terminalOutputs: terminalOutputs || undefined,
      permissions: {
        applyEdit: this._permissionManager.getPermission('applyEdit'),
        runTerminalCommand: this._permissionManager.getPermission('runTerminalCommand'),
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
      const msgContent = (idx === history.length - 1 && h.role === 'user')
        ? contentRedacted.sanitized
        : (SecretScanner.redact(h.content).sanitized);

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
        activeFile: editorCtx.relativePath,
        lineRange: editorCtx.selectedText ? 'Selection' : (editorCtx.hasContext ? 'Whole file' : undefined),
        contentSnippet,
        referencedFile: referencedFileResult ? {
          path: referencedFileResult.relativePath,
          contentSnippet: referencedFileResult.content.slice(0, 1000),
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
    this._activeAbortController = new AbortController();
    let effectiveReasoningEffort = reasoningEffort;

    await OpenRouterClient.sendChatCompletionStream(
      apiKey,
      selectedModel,
      chatMessages,
      (chunk) => {
        accumulatedContent += chunk;
        this._postMessage({
          type: 'MESSAGE_STREAM_CHUNK',
          messageId: assistantMessageId,
          chunk,
        });
      },
      async (usage) => {
        this._activeAbortController = undefined;

        // Extract two-tier artifacts (plan / walkthrough) from the raw model response
        const { planDocument, walkthroughDocument, chatSummary } = extractArtifacts(accumulatedContent);

        await this._historyStore.appendMessage({
          id: assistantMessageId,
          role: 'assistant',
          content: chatSummary,
          planDocument,
          walkthroughDocument,
          model: selectedModel,
          timestamp: Date.now(),
        });

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
          if (effectiveReasoningEffort) {
            const formattedEffort =
              effectiveReasoningEffort.charAt(0).toUpperCase() + effectiveReasoningEffort.slice(1).toLowerCase();
            loggedModelName = `${selectedModel} (${formattedEffort})`;
          }

          await this._usageStore.appendRecord({
            type: 'chat_completion',
            project: ProjectResolver.getActiveProjectName(),
            model: loggedModelName,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            cost,
          });
        }

        this._postMessage({
          type: 'MESSAGE_STREAM_DONE',
          messageId: assistantMessageId,
          usage,
          chatSummary,
          planDocument,
          walkthroughDocument,
        });
        this._postMessage({ type: 'SET_BUSY', busy: false });

        // Auto-execution under Allow = Zero Manual Interaction
        await this._handleAutoExecution(accumulatedContent);
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

  private async _handleAutoExecution(content: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }

    const fileActionRegex = /```(?:create_file|edit_file|file):([^\r\n]+)\r?\n([\s\S]*?)```/gi;
    const applyEditPerm = this._permissionManager.getPermission('applyEdit');

    if (applyEditPerm === 'deny') {
      const matches: { filePath: string; fileName: string; editId: string }[] = [];
      let fileMatch;
      let editCount = 0;
      while ((fileMatch = fileActionRegex.exec(content)) !== null) {
        editCount++;
        let filePath = fileMatch[1].trim();
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
    } else if (applyEditPerm === 'allow') {
      let fileMatch;
      let editCount = 0;
      while ((fileMatch = fileActionRegex.exec(content)) !== null) {
        editCount++;
        let filePath = fileMatch[1].trim();
        const lastColon = filePath.lastIndexOf(':');
        if (lastColon > 1) {
          const afterColon = filePath.substring(lastColon + 1).trim();
          if (!afterColon.includes('/') && !afterColon.includes('\\')) {
            filePath = filePath.substring(0, lastColon).trim();
          }
        }
        const newContent = fileMatch[2];
        const editId = `${Date.now()}-${editCount}`;

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
          // Check permission (for new file, verifies createDeleteFiles)
          const permStatus = await this._permissionManager.checkApplyEditPermission(
            relativePath,
            !fileExists
          );

          if (permStatus === 'denied') {
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
              `Auto-apply edit to ${filePath}`
            );
            if (res) {
              checkpointId = res;
            }
          }

          // Apply edit (skipPermissionCheck = true because checked above)
          const success = await DiffPreviewManager.applyEdit(
            fileUri,
            newContent,
            this._permissionManager,
            true
          );

          if (success) {
            // Tag turn checkpoint
            if (checkpointId) {
              const history = await this._historyStore.loadHistory();
              const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
              if (lastUserMsg) {
                const existing = lastUserMsg.affectedFiles ?? [];
                const merged = Array.from(new Set([...existing, filePath]));
                await this._historyStore.tagTurnCheckpoint(lastUserMsg.id, checkpointId, merged);
              }
            }

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
            });
          } else {
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

    // 2. Auto-run proposed terminal commands if runTerminalCommand === 'allow'
    const runTerminalPerm = this._permissionManager.getPermission('runTerminalCommand');
    if (runTerminalPerm === 'allow') {
      const bashRegex = /```(?:bash|sh|shell|cmd|powershell)\s*([\s\S]*?)```/gi;
      let match;
      let cmdCount = 0;
      while ((match = bashRegex.exec(content)) !== null) {
        const command = match[1].trim();
        if (command) {
          cmdCount++;
          const result = await CommandRunner.executeCommand(command, this._permissionManager);
          const outcome = result.executed
            ? `(completed)`
            : result.cancelled
            ? `(cancelled)`
            : `(failed)`;
          const termMsg = {
            id: `${Date.now()}-term-${cmdCount}`,
            role: 'assistant' as const,
            content: `✓ **Ran in terminal:** \`${command}\` ${outcome}`,
            timestamp: Date.now(),
          };
          if (this._historyStore?.appendMessage) {
            await this._historyStore.appendMessage(termMsg);
          }
          this._postMessage({
            type: 'MESSAGE_RECEIVED',
            message: termMsg,
          });
        }
      }
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

    const reviewerModel = this._activeReviewerModelOverride || Configuration.getReviewerModel();
    if (!reviewerModel) {
      vscode.window.showWarningMessage('Please select a Reviewer Model in Settings before starting a review.');
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

    // Check if a reviewer session is already active/open
    const { activeSession } = await this._historyStore.loadReviewerSessions();
    const isSessionActive =
      (activeSession && activeSession.messages && activeSession.messages.length > 0) ||
      (this._reviewerHistory && this._reviewerHistory.length > 0);

    if (isSessionActive) {
      // Repeat click while reviewer session is active:
      // Do NOT create a new session, do NOT auto-send.
      // Update the active artifact context and attach the artifact to the current session's input bar.
      this._activeReviewerArtifactContent = prepared.content;
      this._activeReviewerArtifactType = artifactType;
      if (activeSession) {
        activeSession.artifactContent = prepared.content;
        activeSession.artifactType = artifactType;
        activeSession.artifactMessageId = messageId;
        await this._historyStore.saveReviewerSessions();
      }

      this._postMessage({
        type: 'REVIEWER_ATTACH_ARTIFACT',
        artifactType,
        artifactContent: prepared.content,
        artifactName: artifactType === 'plan' ? 'Plan docs' : 'Results docs',
        artifactUri: prepared.uri.toString(),
        messageId,
      });
      return;
    }

    this._activeReviewerArtifactContent = prepared.content;
    this._activeReviewerArtifactType = artifactType;

    // No active session for this context: start a fresh reviewer session dedicated to this artifact
    const newSession = await this._historyStore.startNewReviewerSession(sessionTitle, {
      artifactType,
      artifactMessageId: messageId,
      artifactContent: prepared.content,
    });

    // The initial user turn displays the configured Reviewer System Prompt so the user sees the exact critique instructions
    const initialUserPrompt = reviewerSystemPrompt;
    this._reviewerHistory = [{ role: 'user', content: initialUserPrompt }];
    this._lastReviewerUserPrompt = initialUserPrompt;

    await this._historyStore.appendReviewerMessage({
      id: `${Date.now()}-user`,
      role: 'user',
      content: initialUserPrompt,
      timestamp: Date.now(),
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
      activeSessionId: newSession.id,
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
    artifactType?: 'plan' | 'walkthrough'
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

    if (artifactContent) {
      this._activeReviewerArtifactContent = artifactContent;
      this._activeReviewerArtifactType = artifactType || 'plan';
      const { activeSession } = await this._historyStore.loadReviewerSessions();
      if (activeSession) {
        activeSession.artifactContent = artifactContent;
        activeSession.artifactType = artifactType || 'plan';
        await this._historyStore.saveReviewerSessions();
      }
    }

    const reviewerModel = this._activeReviewerModelOverride || Configuration.getReviewerModel();
    const reviewerReasoningEffort = this._activeReviewerReasoningEffortOverride || Configuration.getReviewerReasoningEffort();
    const reviewerSystemPrompt = Configuration.getReviewerSystemPrompt();

    this._reviewerHistory.push({ role: 'user', content: userText });
    this._lastReviewerUserPrompt = userText;

    await this._historyStore.appendReviewerMessage({
      id: `${Date.now()}-user`,
      role: 'user',
      content: userText,
      timestamp: Date.now(),
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

    this._postMessage({ type: 'SET_REVIEWER_BUSY', busy: true });
    this._postMessage({ type: 'REVIEWER_STREAM_START' });

    let accumulatedChunk = '';
    const abortController = new AbortController();
    this._activeReviewerAbortController = abortController;

    let effectiveSystemPrompt = systemPrompt;
    if (this._activeReviewerArtifactContent) {
      const artifactLabel =
        this._activeReviewerArtifactType === 'walkthrough' ? 'Results docs' : 'Plan docs';
      effectiveSystemPrompt = `${systemPrompt}\n\n# Document Under Review (${artifactLabel}):\n${this._activeReviewerArtifactContent}`;
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: effectiveSystemPrompt },
      ...this._reviewerHistory,
    ];

    const dataPolicy = Configuration.getDataCollectionPolicy();
    const providerOptions: ProviderRoutingOptions = {
      data_collection: dataPolicy,
      zdr: dataPolicy === 'deny',
    };

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
        this._activeReviewerAbortController = undefined;
        this._reviewerHistory.push({ role: 'assistant', content: accumulatedChunk });

        await this._historyStore.appendReviewerMessage({
          id: `${Date.now()}-assistant`,
          role: 'assistant',
          content: accumulatedChunk,
          model,
          timestamp: Date.now(),
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
      <div id="messages-container" class="chat-container"></div>

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
          <button id="settings-clear-history-btn" class="btn secondary danger-outline">Clear history</button>
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

          <!-- Reviewer Sessions Menu -->
          <div class="session-dropdown-container">
            <button id="reviewer-new-chat-btn" class="icon-btn" title="Reviewer Sessions / New Session" style="font-size:12px; padding:3px 6px;">➕</button>
            <div id="reviewer-session-dropdown" class="session-dropdown hidden">
              <div class="session-dropdown-header">
                <span>Reviewer Sessions</span>
              </div>
              <div id="reviewer-session-item-new" class="session-menu-action">
                <span class="action-icon">➕</span>
                <span class="action-text">New Review Session</span>
              </div>
              <div class="session-dropdown-divider"></div>
              <div class="session-history-title">Previous Reviews</div>
              <div id="reviewer-session-history-list" class="session-history-list"></div>
            </div>
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
        <!-- Artifact Reference Header & Collapsible Document Preview -->
        <div id="reviewer-artifact-section" class="reviewer-artifact-section" style="border-bottom:1px solid var(--border); background:rgba(0,0,0,0.15);">
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

        <!-- Reviewer Conversation Thread -->
        <div id="reviewer-messages" class="messages-container chat-container" style="flex:1; min-height:0; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:12px;"></div>

        <!-- Floating Selection Toolbar for Selective Return to Main Model -->
        <div id="reviewer-selection-toolbar" class="hidden" style="position:absolute; bottom:80px; left:50%; transform:translateX(-50%); background:#1f242c; border:1px solid var(--border); border-radius:6px; padding:4px 8px; box-shadow:0 4px 12px rgba(0,0,0,0.4); display:flex; align-items:center; gap:8px; z-index:100;">
          <span style="font-size:11px; color:#8b949e;">Selected text</span>
          <button id="reviewer-clarify-selection-btn" class="btn secondary" style="font-size:11px; padding:2px 8px;">
            💬 Clarify Selection
          </button>
          <button id="reviewer-send-selection-btn" class="btn primary" style="font-size:11px; padding:2px 8px;">
            ↵ Send to Main Model
          </button>
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
