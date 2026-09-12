import * as vscode from 'vscode';
import { PermissionManager } from '../permissions/permissionManager';
import { ConfirmationDialogs } from '../permissions/confirmationDialogs';

export class DiffPreviewManager {
  private static readonly SCHEME = 'openrouter-diff';
  private static originalContentMap = new Map<string, string>();
  private static proposedContentMap = new Map<string, string>();

  public static initialize(context: vscode.ExtensionContext) {
    const textDocumentContentProvider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent(uri: vscode.Uri): string {
        if (uri.query === 'original') {
          return DiffPreviewManager.originalContentMap.get(uri.path) || '';
        }
        return DiffPreviewManager.proposedContentMap.get(uri.path) || '';
      },
    };

    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        DiffPreviewManager.SCHEME,
        textDocumentContentProvider
      )
    );
  }

  /**
   * Opens side-by-side diff comparing current file content against proposed content
   */
  public static async openDiffPreview(
    fileUri: vscode.Uri,
    proposedContent: string
  ): Promise<void> {
    let originalContent = '';
    try {
      const data = await vscode.workspace.fs.readFile(fileUri);
      originalContent = new TextDecoder('utf-8').decode(data);
    } catch {
      // New file, original is empty
      originalContent = '';
    }

    const pathKey = fileUri.path;
    this.originalContentMap.set(pathKey, originalContent);
    this.proposedContentMap.set(pathKey, proposedContent);

    const originalUri = vscode.Uri.parse(
      `${this.SCHEME}:${pathKey}?original#${fileUri.fsPath} (Current)`
    );
    const proposedUri = vscode.Uri.parse(
      `${this.SCHEME}:${pathKey}?proposed#${fileUri.fsPath} (Proposed)`
    );

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      `Diff: ${vscode.workspace.asRelativePath(fileUri)} (Current ↔ OpenRouter)`
    );
  }

  /**
   * Applies code changes via WorkspaceEdit after checking permission
   */
  public static async applyEdit(
    fileUri: vscode.Uri,
    newContent: string,
    permissionManager: PermissionManager
  ): Promise<boolean> {
    const state = permissionManager.getPermission('applyEdit');

    if (state === 'deny') {
      vscode.window.showErrorMessage('Applying edits is currently disabled in OpenRouter permissions.');
      return false;
    }

    let fileExists = true;
    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      fileExists = false;
    }

    if (state === 'ask') {
      const confirmed = await ConfirmationDialogs.confirmFileEdit(
        vscode.workspace.asRelativePath(fileUri),
        !fileExists
      );

      if (confirmed === 'deny') {
        vscode.window.showInformationMessage('Edit cancelled.');
        return false;
      }

      if (confirmed === 'allow_session') {
        await permissionManager.setPermission('applyEdit', 'allow_session');
      }
    }

    const edit = new vscode.WorkspaceEdit();

    if (!fileExists) {
      edit.createFile(fileUri, { ignoreIfExists: true });
      edit.insert(fileUri, new vscode.Position(0, 0), newContent);
    } else {
      const document = await vscode.workspace.openTextDocument(fileUri);
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
      edit.replace(fileUri, fullRange, newContent);
    }

    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
      vscode.window.showErrorMessage(`Failed to apply edit to ${vscode.workspace.asRelativePath(fileUri)}`);
    }

    return success;
  }
}
