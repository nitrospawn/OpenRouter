import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PermissionManager } from '../permissions/permissionManager';
import { ArtifactDocumentManager } from './artifactDocumentManager';

export interface EditorContext {
  hasContext: boolean;
  relativePath?: string;
  languageId?: string;
  selectedText?: string;
  fileContent?: string;
  isArtifactDocument?: boolean;
  artifactType?: 'plan' | 'walkthrough';
}

export class ContextReader {
  public static getActiveEditorContext(permissionManager: PermissionManager): EditorContext {
    const permission = permissionManager.getPermission('readActiveContext');
    if (permission === 'deny') {
      return { hasContext: false };
    }

    // Always prefer activeTextEditor, but if activeTextEditor is an artifact document or undefined,
    // search for any visible workspace editor first.
    let editor = vscode.window.activeTextEditor;
    if (editor && ArtifactDocumentManager.isArtifactUri(editor.document.uri)) {
      const workspaceEditor = vscode.window.visibleTextEditors?.find(
        (e) => e.document && e.document.uri && e.document.uri.scheme === 'file' && !ArtifactDocumentManager.isArtifactUri(e.document.uri)
      );
      if (workspaceEditor) {
        editor = workspaceEditor;
      }
    } else if (!editor && vscode.window.visibleTextEditors && vscode.window.visibleTextEditors.length > 0) {
      editor = vscode.window.visibleTextEditors.find(
        (e) => e.document && e.document.uri && e.document.uri.scheme === 'file' && !ArtifactDocumentManager.isArtifactUri(e.document.uri)
      ) || vscode.window.visibleTextEditors[0];
    }

    if (!editor || !editor.document) {
      return { hasContext: false };
    }

    const document = editor.document;
    const isArtifact = ArtifactDocumentManager.isArtifactUri(document.uri);
    const artifactType: 'plan' | 'walkthrough' | undefined = isArtifact
      ? (document.fileName.includes('implementation_plan') ? 'plan' : 'walkthrough')
      : undefined;

    // Guard: Ignore internal extension files, memory logs, and files outside workspace
    const normFileName = document.fileName.replace(/\\/g, '/');
    const isInternalLog = normFileName.includes('globalStorage') ||
      normFileName.includes('log-today.txt') ||
      normFileName.includes('usage_audit_log.json') ||
      normFileName.includes('/.openrouter/') ||
      normFileName.endsWith('/activity_log.md') ||
      normFileName.endsWith('activity_log.md');
    if (isInternalLog) {
      return { hasContext: false };
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!isArtifact && !workspaceFolder) {
      return { hasContext: false };
    }

    const relativePath = isArtifact
      ? undefined // Do NOT expose internal AppData path as an editable workspace path!
      : vscode.workspace.asRelativePath(document.uri);

    const selection = editor.selection;
    const selectedText = selection && !selection.isEmpty ? document.getText(selection) : undefined;
    // Read live in-editor buffer directly from document.getText() (reflects unsaved edits, untruncated)
    const fileContent = document.getText();

    return {
      hasContext: true,
      relativePath,
      languageId: document.languageId,
      selectedText,
      fileContent,
      isArtifactDocument: isArtifact,
      artifactType,
    };
  }

  /**
   * Reads workspace files or finds a file matching a query in the workspace.
   * Checks open in-memory document buffers first before reading from disk to ensure dirty/unsaved edits
   * are included and case-insensitive matching works seamlessly across platforms.
   */
  public static async findAndReadWorkspaceFile(
    fileNameQuery: string,
    permissionManager: PermissionManager
  ): Promise<{ relativePath: string; content: string } | null> {
    const perm = permissionManager.getPermission('readWorkspaceFiles');
    if (perm === 'deny') {
      return null;
    }

    const cleanQuery = fileNameQuery.trim().replace(/^['"]|['"]$/g, '');
    if (!cleanQuery) {
      return null;
    }
    const lowerQuery = cleanQuery.toLowerCase();
    const queryBasename = path.basename(cleanQuery).toLowerCase();

    // Guard: Prevent reading internal memory logs or files in .openrouter as workspace code files
    const normalizedQuery = cleanQuery.replace(/\\/g, '/').toLowerCase();
    if (
      normalizedQuery.includes('.openrouter') ||
      normalizedQuery === 'activity_log.md' ||
      normalizedQuery.endsWith('/activity_log.md')
    ) {
      return null;
    }

    // 1. Check open in-memory document buffers first (live unsaved edits & case-insensitive match)
    if (vscode.workspace.textDocuments && vscode.workspace.textDocuments.length > 0) {
      // Prioritize exact match first
      let openDoc = vscode.workspace.textDocuments.find(
        (doc) => doc.uri && (
          vscode.workspace.asRelativePath(doc.uri) === cleanQuery ||
          path.basename(doc.uri.fsPath) === cleanQuery
        )
      );
      // Fall back to case-insensitive match (e.g. prd.md -> PRD.md)
      if (!openDoc) {
        openDoc = vscode.workspace.textDocuments.find(
          (doc) => doc.uri && (
            vscode.workspace.asRelativePath(doc.uri).toLowerCase() === lowerQuery ||
            path.basename(doc.uri.fsPath).toLowerCase() === queryBasename
          )
        );
      }
      // If no extension was provided in query, search open documents by file stem
      if (!openDoc && !cleanQuery.includes('.')) {
        openDoc = vscode.workspace.textDocuments.find(
          (doc) => doc.uri && (
            path.parse(doc.uri.fsPath).name.toLowerCase() === lowerQuery ||
            path.parse(vscode.workspace.asRelativePath(doc.uri)).name.toLowerCase() === lowerQuery
          )
        );
      }

      if (openDoc) {
        return {
          relativePath: vscode.workspace.asRelativePath(openDoc.uri),
          content: openDoc.getText(),
        };
      }
    }

    // 2. Query workspace files via findFiles
    let targetUri: vscode.Uri | undefined;
    const hasExtension = cleanQuery.includes('.');
    const globPattern = hasExtension ? `**/${cleanQuery}` : `**/${cleanQuery}.*`;
    const files = await vscode.workspace.findFiles(globPattern, '{**/node_modules/**,**/.openrouter/**}', 5);
    if (files && files.length > 0) {
      targetUri = files.sort((a, b) => a.fsPath.length - b.fsPath.length)[0];
    } else {
      // 3. Fall back to search in workspace files list (with extension search fallback)
      const allFiles = await this.listWorkspaceFiles(permissionManager);
      let matchedRelPath = allFiles.find(
        (f) => f.toLowerCase() === lowerQuery || path.basename(f).toLowerCase() === queryBasename
      );
      if (!matchedRelPath && !hasExtension) {
        const stemMatches = allFiles.filter(
          (f) => path.parse(f).name.toLowerCase() === lowerQuery
        );
        if (stemMatches.length > 0) {
          matchedRelPath = stemMatches.sort((a, b) => a.length - b.length)[0];
        }
      }
      if (matchedRelPath) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
          targetUri = vscode.Uri.joinPath(folders[0].uri, matchedRelPath);
        }
      }
    }

    if (!targetUri) {
      return null;
    }

    const relativePath = vscode.workspace.asRelativePath(targetUri);

    // Double check open document for targetUri (in case URI casing differed)
    if (vscode.workspace.textDocuments && vscode.workspace.textDocuments.length > 0) {
      const openDoc = vscode.workspace.textDocuments.find(
        (doc) => doc.uri && (
          doc.uri.toString() === targetUri.toString() ||
          doc.uri.fsPath.toLowerCase() === targetUri.fsPath.toLowerCase()
        )
      );
      if (openDoc) {
        return {
          relativePath,
          content: openDoc.getText(),
        };
      }
    }

    // 4. Fall back to reading from disk if not open in memory (untruncated)
    try {
      const data = await vscode.workspace.fs.readFile(targetUri);
      const content = new TextDecoder('utf-8').decode(data);
      return {
        relativePath,
        content,
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
        '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.vscode/**,**/.openrouter/**}',
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
          .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '.openrouter')
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      }
      return [];
    } catch {
      return [];
    }
  }
}
