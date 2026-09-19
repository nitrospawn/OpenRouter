import * as vscode from 'vscode';
import { PermissionManager } from '../permissions/permissionManager';

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
   * Resolves proposed content which may contain SEARCH/REPLACE blocks.
   * If the proposed content contains `<<<< SEARCH`, it applies the search/replace to the original content.
   * Uses strict exact matching. Throws an error if a search block is not found.
   */
  public static resolveProposedContent(originalContent: string, proposedContent: string): string {
    if (!proposedContent.includes('<<<< SEARCH')) {
      return proposedContent;
    }

    // Normalize line endings to LF to prevent strict matching failures on Windows
    originalContent = originalContent.replace(/\r\n/g, '\n');
    proposedContent = proposedContent.replace(/\r\n/g, '\n');

    const blockRegex = /<<<< SEARCH(?:\n([\s\S]*?))?\n====\n([\s\S]*?)\n>>>>/g;
    let match;
    let resolvedContent = originalContent;
    let hasMatches = false;

    // We must reset lastIndex in case we reuse the regex
    blockRegex.lastIndex = 0;

    while ((match = blockRegex.exec(proposedContent)) !== null) {
      hasMatches = true;
      const searchBlock = match[1] ?? '';
      const replaceBlock = match[2];

      if (searchBlock === '') {
        if (originalContent.trim() === '') {
          resolvedContent = replaceBlock;
          continue;
        }
        throw new Error('Empty SEARCH block is not allowed. The AI proposed an invalid edit block.');
      }

      if (!resolvedContent.includes(searchBlock)) {
        throw new Error(
          "The AI's proposed edit no longer matches this file's current content — it may have changed since the edit was proposed. Please ask again."
        );
      }

      // Replace only the first occurrence to avoid replacing multiple identical blocks if not intended.
      // But standard search/replace usually replaces the first exact match it finds.
      resolvedContent = resolvedContent.replace(searchBlock, replaceBlock);
    }

    if (!hasMatches) {
      // It had '<<<< SEARCH' but didn't match the regex pattern exactly.
      throw new Error("The AI's proposed edit contains a malformed SEARCH/REPLACE block. Please ask again.");
    }

    return resolvedContent;
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
    let resolvedContent: string;
    try {
      resolvedContent = this.resolveProposedContent(originalContent, proposedContent);
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
      return;
    }

    this.originalContentMap.set(pathKey, originalContent);
    this.proposedContentMap.set(pathKey, resolvedContent);

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
    permissionManager: PermissionManager,
    skipPermissionCheck: boolean = false
  ): Promise<boolean> {
    let fileExists = true;
    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      fileExists = false;
    }

    if (!skipPermissionCheck) {
      const relativePath = vscode.workspace.asRelativePath(fileUri);
      const permStatus = await permissionManager.checkApplyEditPermission(relativePath, !fileExists);
      if (permStatus === 'denied') {
        return false;
      }
    }

    let originalContent = '';
    if (fileExists) {
      try {
        const data = await vscode.workspace.fs.readFile(fileUri);
        originalContent = new TextDecoder('utf-8').decode(data);
      } catch {
        // ignore
      }
    }

    let resolvedContent: string;
    try {
      resolvedContent = this.resolveProposedContent(originalContent, newContent);
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
      return false;
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
      edit.replace(fileUri, fullRange, resolvedContent);
    }

    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
      vscode.window.showErrorMessage(`Failed to apply edit to ${vscode.workspace.asRelativePath(fileUri)}`);
    }

    return success;
  }
}
