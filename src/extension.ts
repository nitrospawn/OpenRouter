import * as vscode from 'vscode';
import { SecretStore } from './auth/secretStore';
import { HistoryStore } from './conversation/historyStore';
import { PermissionManager, PermissionCategory } from './permissions/permissionManager';
import { DiffPreviewManager } from './editor/diffPreview';
import { OpenRouterPanelProvider } from './webview/panelProvider';
import { DiagnosticManager } from './diagnostics/diagnosticManager';

import { UsageStore } from './usage/usageStore';

export function activate(context: vscode.ExtensionContext) {
  const secretStore = new SecretStore(context);
  const historyStore = new HistoryStore(context.storageUri);
  const permissionManager = new PermissionManager(context);
  const usageStore = new UsageStore(context.globalStorageUri);

  // Initialize Diff Preview virtual text document provider
  DiffPreviewManager.initialize(context);

  const panelProvider = new OpenRouterPanelProvider(
    context.extensionUri,
    secretStore,
    historyStore,
    permissionManager,
    usageStore,
    context.storageUri
  );

  // Register Webview View Provider in the View Container
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OpenRouterPanelProvider.viewType,
      panelProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('openrouter.updateApiKey', async () => {
      const updated = await secretStore.promptForApiKey();
      if (updated) {
        await panelProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouter.clearApiKey', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to clear your OpenRouter API key?',
        { modal: true },
        'Yes, Clear'
      );
      if (confirm === 'Yes, Clear') {
        await secretStore.clearApiKey();
        vscode.window.showInformationMessage('OpenRouter API key cleared.');
        await panelProvider.refresh();
      }
    })
  );

  // Staged Clear History Flow (PRD §3.5 & §5.4)
  context.subscriptions.push(
    vscode.commands.registerCommand('openrouter.clearHistory', async () => {
      const projectName = vscode.workspace.workspaceFolders?.[0]?.name || 'current workspace';
      const category = await vscode.window.showQuickPick(
        [
          { label: '💬 Chat Conversation History', value: 'chat', description: `Deletes conversations for this project (${projectName}) only` },
          { label: '📊 Usage & Audit Data', value: 'usage', description: 'Deletes token and command logs across all projects' },
          { label: '🧹 All History & Usage Data', value: 'all', description: `Clears chat history for ${projectName} and all usage logs` },
        ],
        { placeHolder: 'What would you like to clear?' }
      );

      if (!category) return;

      // Step 2: Confirmation
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to clear: ${category.label}? This cannot be undone.`,
        { modal: true },
        'Yes, Delete'
      );

      if (confirm !== 'Yes, Delete') return;

      // Step 3: Execute deletion scoped to selection
      if (category.value === 'chat' || category.value === 'all') {
        await historyStore.clearHistory();
      }
      if (category.value === 'usage' || category.value === 'all') {
        await usageStore.clearUsageData();
      }

      vscode.window.showInformationMessage(`Cleared: ${category.label}`);
      await panelProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouter.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'openrouter');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouter.managePermissions', async () => {
      const items = [
        { label: 'Read Active File / Selection Context', category: 'readActiveContext' as PermissionCategory },
        { label: 'Propose Code Edits (Diff Preview)', category: 'proposeEdit' as PermissionCategory },
        { label: 'Apply Code Edits', category: 'applyEdit' as PermissionCategory },
        { label: 'Create / Delete Files', category: 'createDeleteFiles' as PermissionCategory },
        { label: 'Run Terminal Commands', category: 'runTerminalCommand' as PermissionCategory },
        { label: 'Read Unopened Workspace Files', category: 'readWorkspaceFiles' as PermissionCategory },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a permission category to configure',
      });

      if (selected) {
        const current = permissionManager.getPermission(selected.category);
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'Allow', description: 'Always allowed' },
            { label: 'Allow for Session', description: 'Allowed until VS Code window closes' },
            { label: 'Ask (Default)', description: 'Prompt each time' },
            { label: 'Deny', description: 'Block action entirely' },
          ],
          { placeHolder: `Current status: ${current}. Select new state:` }
        );

        if (choice) {
          const mapping: Record<string, any> = {
            'Allow': 'allow',
            'Allow for Session': 'allow_session',
            'Ask (Default)': 'ask',
            'Deny': 'deny',
          };
          await permissionManager.setPermission(selected.category, mapping[choice.label]);
          vscode.window.showInformationMessage(`Updated ${selected.label} to: ${choice.label}`);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouter.focusChat', async () => {
      await vscode.commands.executeCommand('openrouter.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouter.resetPanelLocation', async () => {
      await vscode.commands.executeCommand('openrouter.chatView.focus');
      try {
        await vscode.commands.executeCommand('workbench.action.resetFocusedViewLocation');
      } catch {}
      vscode.window.showInformationMessage('OpenRouter panel reset to left Activity Bar.');
    })
  );

  // Phase 8: Diagnostics-to-AI Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('openrouter.fixDiagnostic', async (arg1?: any, arg2?: any) => {
      let targetDiagnostic: vscode.Diagnostic | undefined;
      let targetDoc: vscode.TextDocument | undefined;

      // Handle invocation from Problems panel context or editor context
      if (arg2 && arg2 instanceof vscode.Diagnostic) {
        targetDiagnostic = arg2;
        if (arg1 instanceof vscode.Uri) {
          targetDoc = await vscode.workspace.openTextDocument(arg1);
        }
      } else if (arg1 && typeof arg1 === 'object' && 'diagnostic' in arg1) {
        targetDiagnostic = arg1.diagnostic;
        if (arg1.uri instanceof vscode.Uri) {
          targetDoc = await vscode.workspace.openTextDocument(arg1.uri);
        }
      }

      // Fallback: If triggered from active editor cursor without direct diagnostic argument
      if (!targetDiagnostic || !targetDoc) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          targetDoc = editor.document;
          const pos = editor.selection.active;
          const diags = vscode.languages.getDiagnostics(targetDoc.uri);
          targetDiagnostic = diags.find((d) => d.range.contains(pos)) || diags[0];
        }
      }

      if (!targetDiagnostic || !targetDoc) {
        vscode.window.showInformationMessage('OpenRouter: No diagnostic found at the current location.');
        return;
      }

      // Check readActiveContext permission
      const perm = permissionManager.getPermission('readActiveContext');
      if (perm === 'deny') {
        vscode.window.showErrorMessage('Cannot send diagnostic: Reading active context is disabled in OpenRouter permissions.');
        return;
      }

      const prompt = DiagnosticManager.formatSingleProblemPrompt(targetDiagnostic, targetDoc);
      await vscode.commands.executeCommand('openrouter.chatView.focus');
      await panelProvider.sendDirectPrompt(prompt);
    })
  );

  // Register CodeActionProvider for QuickFix so right-clicking a diagnostic or viewing QuickFix in Problems panel includes OpenRouter
  context.subscriptions.push(
    vscode.languages.registerCodeActionProvider(
      { scheme: 'file' },
      {
        provideCodeActions(
          document: vscode.TextDocument,
          range: vscode.Range | vscode.Selection,
          context: vscode.CodeActionContext
        ): vscode.CodeAction[] {
          if (!context.diagnostics || context.diagnostics.length === 0) {
            return [];
          }
          return context.diagnostics.map((diag) => {
            const action = new vscode.CodeAction(
              'OpenRouter: Ask AI to Fix This Problem',
              vscode.CodeActionKind.QuickFix
            );
            action.command = {
              command: 'openrouter.fixDiagnostic',
              title: 'OpenRouter: Ask AI to Fix This Problem',
              arguments: [document.uri, diag],
            };
            action.diagnostics = [diag];
            return action;
          });
        },
      },
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouter.sendCurrentProblems', async () => {
      await vscode.commands.executeCommand('openrouter.chatView.focus');
      panelProvider.insertInputText('@current_problems', true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('openrouter.sendAllProblems', async () => {
      await vscode.commands.executeCommand('openrouter.chatView.focus');
      panelProvider.insertInputText('@all_problems', true);
    })
  );
}

export function deactivate() {}
