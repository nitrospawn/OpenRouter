import * as vscode from 'vscode';
import { SecretStore } from '../auth/secretStore';
import { OpenRouterClient, OpenRouterModel, ChatMessageContentPart, ProviderRoutingOptions } from '../api/openrouterClient';
import { detectModelCapabilities } from '../api/modelCapabilities';
import { HistoryStore } from '../conversation/historyStore';
import { Configuration } from '../settings/configuration';
import { PermissionManager } from '../permissions/permissionManager';
import { DiffPreviewManager } from '../editor/diffPreview';
import { ContextReader } from '../editor/contextReader';
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
import { EXTENSION_VERSION } from '../version';

export class OpenRouterPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openrouter.chatView';

  private _view?: vscode.WebviewView;
  private _cachedModels: OpenRouterModel[] = [];
  private _shadowRepo?: ShadowRepo;
  private _checkpointManager?: CheckpointManager;
  private _scopedRestore?: ScopedRestore;
  private _activeAbortController?: AbortController;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _secretStore: SecretStore,
    private readonly _historyStore: HistoryStore,
    private readonly _permissionManager: PermissionManager,
    private readonly _usageStore: UsageStore,
    private readonly _storageUri?: vscode.Uri
  ) {
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
            const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, data.filePath);
            await DiffPreviewManager.openDiffPreview(fileUri, data.newContent);
          }
          break;
        }

        case 'ACCEPT_EDIT': {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, data.filePath);

            // Step 1: Create a shadow-git checkpoint of the affected file before applying the edit
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

            // Step 2: Apply the workspace edit
            const success = await DiffPreviewManager.applyEdit(
              fileUri,
              data.newContent,
              this._permissionManager
            );

            // Step 3: Tag the most-recent user message with this checkpoint so the undo
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
            const affectedFiles = data.edits.map((e) => e.filePath);

            // Step 1: Create a single unified shadow-git checkpoint for all affected files
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

            // Step 2: Apply each edit sequentially
            for (const edit of data.edits) {
              const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, edit.filePath);
              const success = await DiffPreviewManager.applyEdit(
                fileUri,
                edit.newContent,
                this._permissionManager
              );

              this._postMessage({
                type: 'EDIT_APPLIED',
                editId: edit.editId,
                success,
                checkpointId, // All edits share this common checkpointId for unified per-turn undo
              });
            }

            // Step 3: Tag the most-recent user message with the unified checkpoint
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

  private async _sendSettingsData() {
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

    const formatted = this._cachedModels.map((m) => {
      // Model supports ZDR if top_provider does not allow data collection or explicit support flag
      const supportsZdr = m.top_provider?.allow_data_collection === false || m.supports_zdr === true;
      return {
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        pricing: m.pricing,
        supports_zdr: supportsZdr,
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
        return {
          id: m.id,
          name: m.name,
          context_length: m.context_length,
          pricing: m.pricing,
          supports_zdr: supportsZdr,
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

    this._postMessage({ type: 'SET_BUSY', busy: true });
    this._postMessage({ type: 'MESSAGE_STREAM_START', messageId: `${Date.now()}-assistant` });

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

    const systemPrompt = buildSystemPrompt({
      activeFile: editorCtx.hasContext && editorCtx.relativePath ? {
        relativePath: editorCtx.relativePath,
        languageId: editorCtx.languageId,
        selectedText: editorCtx.selectedText,
        fileContent: editorCtx.fileContent,
      } : undefined,
      workspaceFiles,
      referencedFile: referencedFileResult || undefined,
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
          messageId: `${Date.now()}-assistant`,
          chunk,
        });
      },
      async (usage) => {
        this._activeAbortController = undefined;
        await this._historyStore.appendMessage({
          id: `${Date.now()}-assistant`,
          role: 'assistant',
          content: accumulatedContent,
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
          messageId: `${Date.now()}-assistant`,
          usage,
        });
        this._postMessage({ type: 'SET_BUSY', busy: false });
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

    this._postMessage({
      type: 'USAGE_REPORT_DATA',
      summary,
      records,
      projects,
      models,
    });
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
    <div id="view-usage" class="tab-content-view hidden" style="display:flex; flex-direction:column; flex:1; min-height:0; overflow-y:auto; padding:16px; gap:14px;">
      <div class="settings-header">
        <button id="usage-back-btn" class="settings-back-btn">‹ Usage Report</button>
      </div>

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

    <!-- TAB 3: In-Panel Settings View (Matching User Mockup) -->
    <div id="view-settings" class="tab-content-view hidden" style="display:flex; flex-direction:column; flex:1; min-height:0; overflow-y:auto; padding:16px; gap:18px;">
      <!-- Header with back button -->
      <div class="settings-header">
        <button id="settings-back-btn" class="settings-back-btn">‹ Settings</button>
      </div>

      <!-- Account Section -->
      <div class="settings-group">
        <div class="settings-group-title">Account</div>
        <div class="settings-row">
          <span id="settings-masked-key" class="settings-masked-text">sk-or-••••••••••••</span>
          <button id="settings-update-key-btn" class="btn secondary">Update key</button>
        </div>
      </div>

      <!-- Panel position Section -->
      <div class="settings-group">
        <div class="settings-group-title">Panel position</div>
        <div class="segmented-control">
          <button id="pos-left-btn" class="segment-btn active">Left</button>
          <button id="pos-right-btn" class="segment-btn">Right</button>
        </div>
        <div id="position-guide-box" class="position-guide-box hidden">
          <div class="guide-title">
            <span id="guide-title-text">👉 How to move Chat to the Right:</span>
            <button id="guide-close-btn" class="guide-close-btn" title="Dismiss">✕</button>
          </div>
          <div id="guide-body-text" class="guide-body">
            <div>1. Right-click the <strong>OpenRouter (✨)</strong> icon or "Chat" header.</div>
            <div>2. Click <strong>"Move to Secondary Side Bar"</strong>.</div>
            <div style="margin-top: 4px; opacity: 0.8;">(Or simply drag &amp; drop the ✨ icon to the right side bar).</div>
          </div>
        </div>
      </div>

      <!-- Default model Section -->
      <div class="settings-group">
        <div class="settings-group-title">Default model</div>
        <select id="settings-default-model" class="settings-select">
          <option value="">Loading models...</option>
        </select>
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
            <button class="perm-pill deny">Denied</button>
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
          <a href="https://openrouter.ai/docs/privacy" target="_blank" style="color: var(--vscode-textLink-foreground); text-decoration: none;">
            🔗 OpenRouter Privacy &amp; Data Policy documentation
          </a>
        </div>
        <div style="margin-top: 4px; font-size: 10px; opacity: 0.65; line-height: 1.3;">
          Note: Existing chat history saved prior to enabling secret redaction is persisted as-is and not retroactively rescanned.
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

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
