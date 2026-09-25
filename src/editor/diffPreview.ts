import * as vscode from 'vscode';
import { PermissionManager } from '../permissions/permissionManager';
import { logger } from '../logger';

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

    const blockRegex = /<<<< SEARCH[ \t]*(?:\n([\s\S]*?))?\n====(?!=)[ \t]*(?:\n[ \t]*>>>>(?!>)[ \t]*|\n([\s\S]*?)\n>>>>(?!>)[ \t]*)/g;
    let match;
    let resolvedContent = originalContent;
    let hasMatches = false;

    // We must reset lastIndex in case we reuse the regex
    blockRegex.lastIndex = 0;

    while ((match = blockRegex.exec(proposedContent)) !== null) {
      hasMatches = true;
      let searchBlock = match[1] ?? '';
      let replaceBlock = match[2] ?? '';

      // Unwrap accidental full code fence wrapper around search block if present
      const searchFenceMatch = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/.exec(searchBlock.trim());
      if (searchFenceMatch) {
        searchBlock = searchFenceMatch[1];
      }

      // Unwrap accidental code fence wrapper around replace block
      let cleanReplaceBlock = replaceBlock;
      if (cleanReplaceBlock) {
        cleanReplaceBlock = cleanReplaceBlock.replace(/```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```/g, '$1');
      }

      if (searchBlock === '') {
        if (originalContent.trim() === '') {
          resolvedContent = cleanReplaceBlock;
          continue;
        }
        // If file content is empty or only whitespace, treat as valid new content
        if (resolvedContent.trim() === '') {
          resolvedContent = cleanReplaceBlock;
          continue;
        }
        throw new Error('Empty SEARCH block is not allowed. The AI proposed an invalid edit block.');
      }

      if (resolvedContent.includes(searchBlock)) {
        resolvedContent = resolvedContent.replace(searchBlock, cleanReplaceBlock);
      } else {
        // Fallback 1: If exact match failed due to trailing whitespace differences on lines
        const searchLines = searchBlock.split('\n');
        const resolvedLines = resolvedContent.split('\n');
        let matchedIndex = -1;

        for (let i = 0; i <= resolvedLines.length - searchLines.length; i++) {
          let allMatch = true;
          for (let j = 0; j < searchLines.length; j++) {
            if (resolvedLines[i + j].trimEnd() !== searchLines[j].trimEnd()) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            matchedIndex = i;
            break;
          }
        }

        if (matchedIndex !== -1) {
          const before = resolvedLines.slice(0, matchedIndex);
          const after = resolvedLines.slice(matchedIndex + searchLines.length);
          const replacedLines = cleanReplaceBlock ? cleanReplaceBlock.split('\n') : [];
          resolvedContent = [...before, ...replacedLines, ...after].join('\n');
        } else {
          // Fallback 1b: If leading indentation differs slightly (e.g. 2 spaces vs 4 spaces)
          let leadingMatchIndex = -1;
          for (let i = 0; i <= resolvedLines.length - searchLines.length; i++) {
            let allMatch = true;
            for (let j = 0; j < searchLines.length; j++) {
              if (resolvedLines[i + j].trim() !== searchLines[j].trim()) {
                allMatch = false;
                break;
              }
            }
            if (allMatch) {
              leadingMatchIndex = i;
              break;
            }
          }

          if (leadingMatchIndex !== -1) {
            const before = resolvedLines.slice(0, leadingMatchIndex);
            const after = resolvedLines.slice(leadingMatchIndex + searchLines.length);
            const replacedLines = cleanReplaceBlock ? cleanReplaceBlock.split('\n') : [];
            resolvedContent = [...before, ...replacedLines, ...after].join('\n');
          } else if (
            (searchBlock.trim() === '```' || searchBlock.trim() === '```markdown') &&
            !resolvedContent.includes('```')
          ) {
            // Fallback 2: EOF Append Heuristic
            const appendText = cleanReplaceBlock
              .replace(/^```[a-zA-Z0-9_-]*\r?\n?/, '')
              .replace(/\r?\n?```$/, '')
              .trim();
            if (appendText.length > 0) {
              resolvedContent = resolvedContent.trimEnd() + '\n\n' + appendText + '\n';
            }
          } else {
            const previewLines = searchLines.slice(0, 3).map(l => l.trim()).join(' ');
            throw new Error(
              `The AI's proposed edit no longer matches this file's current content — proposed SEARCH block ("${previewLines.slice(0, 50)}...") could not be found. Please ask again or specify the section to modify.`
            );
          }
        }
      }
    }

    if (!hasMatches) {
      // It had '<<<< SEARCH' but didn't match the regex pattern exactly.
      throw new Error("The AI's proposed edit contains a malformed SEARCH/REPLACE block. Please ask again.");
    }

    return resolvedContent;
  }

  /**
   * Sequentially resolves multiple proposed contents/blocks for a single file in memory.
   * Chaining ensures block N+1 is applied cleanly on top of block N.
   */
  public static resolveMultipleProposedBlocks(originalContent: string, blocks: string[]): string {
    let current = originalContent;
    for (const block of blocks) {
      current = this.resolveProposedContent(current, block);
    }
    return current;
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

    const relPath = vscode.workspace.asRelativePath(fileUri);
    logger.info('EDIT', `Opened diff preview for ${relPath}`);
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      `Diff: ${relPath} (Current ↔ OpenRouter)`
    );
  }

  /**
   * Applies code changes via WorkspaceEdit after checking permission
   */
  public static async applyEdit(
    fileUri: vscode.Uri,
    newContent: string,
    permissionManager: PermissionManager,
    skipPermissionCheck: boolean = false,
    resolvedOverride?: string
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
    if (typeof resolvedOverride === 'string') {
      resolvedContent = resolvedOverride;
    } else {
      try {
        resolvedContent = this.resolveProposedContent(originalContent, newContent);
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
        return false;
      }
    }

    const relPath = vscode.workspace.asRelativePath(fileUri);

    // Idempotency guard: if the file already exists and its current content matches
    // the resolved content, skip writing to disk to avoid duplicate appends.
    const normalizedOriginal = originalContent.replace(/\r\n/g, '\n');
    const normalizedResolved = resolvedContent.replace(/\r\n/g, '\n');
    if (fileExists && normalizedOriginal === normalizedResolved) {
      logger.info('EDIT', `Applied edit successfully to ${relPath} (content already matches, no-op)`);
      return true;
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

    logger.info('FILE', `Writing to file: ${relPath}${!fileExists ? ' (creating new file)' : ''}`);
    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
      logger.error('EDIT', `Failed to apply edit to ${relPath}`);
      vscode.window.showErrorMessage(`Failed to apply edit to ${relPath}`);
    } else {
      logger.info('EDIT', `Applied edit successfully to ${relPath}${!fileExists ? ' (created new file)' : ''}`);
      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        if (typeof doc.save === 'function') {
          await doc.save();
        }
        // If file was newly created, automatically open it in an independent editor tab without stealing chat focus
        if (!fileExists) {
          await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
        }
      } catch {
        // non-fatal
      }
    }

    return success;
  }
}
