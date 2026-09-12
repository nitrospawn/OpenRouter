import * as vscode from 'vscode';
import * as fs from 'fs';
import { PermissionManager } from '../permissions/permissionManager';

export interface EditorContext {
  hasContext: boolean;
  relativePath?: string;
  languageId?: string;
  selectedText?: string;
  fileContent?: string;
}

export class ContextReader {
  public static getActiveEditorContext(permissionManager: PermissionManager): EditorContext {
    const permission = permissionManager.getPermission('readActiveContext');
    if (permission === 'deny') {
      return { hasContext: false };
    }

    // Always prefer activeTextEditor, but if webview has focus, activeTextEditor can be undefined.
    // Fall back to visibleTextEditors to get the user's open editor.
    let editor = vscode.window.activeTextEditor;
    if (!editor && vscode.window.visibleTextEditors && vscode.window.visibleTextEditors.length > 0) {
      editor = vscode.window.visibleTextEditors.find((e) => e.document && e.document.uri && e.document.uri.scheme === 'file')
        || vscode.window.visibleTextEditors[0];
    }

    if (!editor || !editor.document) {
      return { hasContext: false };
    }

    const document = editor.document;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const relativePath = workspaceFolder
      ? vscode.workspace.asRelativePath(document.uri)
      : document.fileName;

    const selection = editor.selection;
    const selectedText = selection && !selection.isEmpty ? document.getText(selection) : undefined;
    // Read live in-editor buffer directly from document.getText() (reflects unsaved edits)
    const fileContent = document.getText();

    return {
      hasContext: true,
      relativePath,
      languageId: document.languageId,
      selectedText,
      fileContent: fileContent.length > 25000 ? fileContent.slice(0, 25000) + '\n...[truncated]' : fileContent,
    };
  }

  /**
   * Reads workspace files or finds a file matching a query in the workspace.
   * Checks open in-memory document buffers first before reading from disk to ensure dirty/unsaved edits are included.
   */
  public static async findAndReadWorkspaceFile(
    fileNameQuery: string,
    permissionManager: PermissionManager
  ): Promise<{ relativePath: string; content: string } | null> {
    const perm = permissionManager.getPermission('readWorkspaceFiles');
    if (perm === 'deny') {
      return null;
    }

    const files = await vscode.workspace.findFiles(`**/${fileNameQuery}`, '**/node_modules/**', 1);
    if (files.length === 0) {
      return null;
    }

    const targetUri = files[0];
    const relativePath = vscode.workspace.asRelativePath(targetUri);

    // 1. Check if the file is currently open in an editor buffer (live unsaved edits)
    if (vscode.workspace.textDocuments && vscode.workspace.textDocuments.length > 0) {
      const openDoc = vscode.workspace.textDocuments.find(
        (doc) => doc.uri && (doc.uri.toString() === targetUri.toString() || doc.uri.fsPath === targetUri.fsPath)
      );
      if (openDoc) {
        const liveContent = openDoc.getText();
        return {
          relativePath,
          content: liveContent.length > 25000 ? liveContent.slice(0, 25000) + '\n...[truncated]' : liveContent,
        };
      }
    }

    // 2. Fall back to reading from disk if not open in memory
    try {
      const data = await vscode.workspace.fs.readFile(targetUri);
      const content = new TextDecoder('utf-8').decode(data);
      return {
        relativePath,
        content: content.length > 25000 ? content.slice(0, 25000) + '\n...[truncated]' : content,
      };
    } catch {
      return null;
    }
  }

  /**
   * Returns a list of all relative file paths in the active workspace
   */
  public static async listWorkspaceFiles(
    permissionManager: PermissionManager
  ): Promise<string[]> {
    const perm = permissionManager.getPermission('readWorkspaceFiles');
    if (perm === 'deny') {
      return [];
    }

    try {
      const uris = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.vscode/**}',
        100
      );
      if (uris.length > 0) {
        return uris.map((u) => vscode.workspace.asRelativePath(u));
      }

      // Fallback: direct filesystem read if findFiles is indexing or empty
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 0) {
        const rootPath = folders[0].uri.fsPath;
        const entries = fs.readdirSync(rootPath, { withFileTypes: true });
        return entries
          .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      }
      return [];
    } catch {
      return [];
    }
  }
}
