import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { HistoryStore } from '../conversation/historyStore';
import { extractArtifacts } from '../prompt/responseParser';

export class ArtifactDocumentManager {
  /**
   * Opens or regenerates a fresh, standalone Markdown document for an implementation plan
   * or walkthrough.
   *
   * Architectural & Design Guarantees:
   * 1. Single Source of Truth & Fresh Regeneration:
   *    If messageId is provided, the document is freshly retrieved from historyStore to ensure
   *    reopened conversations produce the authoritative saved plan/walkthrough without relying
   *    on persistent open tab state.
   * 2. Read-Only Presentation:
   *    The document is presented in an editor tab.
   * 3. Native Comments API Compatibility & Git Safety:
   *    The document is saved to a real file URI under the extension's workspace storage directory
   *    (`storageUri/artifacts/`) or OS temp directory, inherently keeping it completely outside
   *    the user's workspace git tracking. This prevents sensitive reasoning artifacts from ever
   *    being committed to user repositories, while maintaining standard `file://` URIs for VS Code's
   *    native Comments API and CommentController.
   */

  /**
   * Checks whether a given URI represents an internal artifact document (plan or walkthrough)
   * stored in workspaceStorage or temp directories.
   */
  public static isArtifactUri(uri?: vscode.Uri): boolean {
    if (!uri) return false;
    const normalized = uri.fsPath.replace(/\\/g, '/').toLowerCase();
    return (
      normalized.includes('/artifacts/implementation_plan_') ||
      normalized.includes('/artifacts/walkthrough_') ||
      normalized.includes('openrouter-artifacts') ||
      normalized.includes('qubators.openrouter/artifacts')
    );
  }

  /**
   * Resolves the target file URI for a given artifact without necessarily opening it in the editor.
   */
  public static getArtifactUri(
    artifactType: 'plan' | 'walkthrough',
    messageId?: string,
    storageUri?: vscode.Uri
  ): vscode.Uri {
    const fileName = `${artifactType === 'plan' ? 'implementation_plan' : 'walkthrough'}_${messageId || 'default'}.md`;
    if (storageUri) {
      return vscode.Uri.joinPath(storageUri, 'artifacts', fileName);
    }
    const tempPath = path.join(os.tmpdir(), 'openrouter-artifacts', fileName);
    return vscode.Uri.file(tempPath);
  }

  /**
   * Writes the fresh content from historyStore to disk and returns the file URI and document.
   *
   * Resilient Multi-Tier Resolution Strategy:
   * Tier 1: Direct message lookup by messageId (including fallback extraction from msg.content if un-extracted).
   * Tier 2: Caller-provided fallbackContent.
   * Tier 3: Backward search across active chat session messages for the most recent valid artifact.
   * Tier 4: Active reviewer session artifactContent fallback.
   * Tier 5: Disk scan for matching artifact files under storageUri/artifacts/ or temp directory,
   *         resolving the most recently modified matching artifact file.
   */
  public static async prepareArtifactFile(
    historyStore: HistoryStore,
    artifactType: 'plan' | 'walkthrough',
    messageId?: string,
    fallbackContent?: string,
    storageUri?: vscode.Uri
  ): Promise<{ uri: vscode.Uri; content: string } | undefined> {
    let content: string | undefined;
    let targetMessage: any = undefined;

    // 1. Direct message lookup by messageId
    if (messageId) {
      try {
        const msg = await historyStore.getMessageById(messageId);
        if (msg) {
          targetMessage = msg;
          content = artifactType === 'plan' ? msg.planDocument : msg.walkthroughDocument;
          // If not stored in planDocument/walkthroughDocument, attempt parsing from raw message content
          if ((!content || content.trim().length === 0) && msg.content) {
            const extracted = extractArtifacts(msg.content);
            const extractedDoc = artifactType === 'plan' ? extracted.planDocument : extracted.walkthroughDocument;
            if (extractedDoc && extractedDoc.trim().length > 0) {
              content = extractedDoc;
            }
          }
        }
      } catch {
        // Message lookup failure — proceed to next tier
      }
    }

    // 2. Caller-provided fallback content
    if ((!content || content.trim().length === 0) && fallbackContent && fallbackContent.trim().length > 0) {
      content = fallbackContent;
    }

    // 3. Search backwards through the active chat session for the most recent valid artifact
    if (!content || content.trim().length === 0) {
      try {
        const { activeSession } = await historyStore.loadSessions();
        if (activeSession && activeSession.messages && activeSession.messages.length > 0) {
          for (let i = activeSession.messages.length - 1; i >= 0; i--) {
            const m = activeSession.messages[i];
            const candidate = artifactType === 'plan' ? m.planDocument : m.walkthroughDocument;
            if (candidate && candidate.trim().length > 0) {
              content = candidate;
              break;
            }
            if (m.content) {
              const extracted = extractArtifacts(m.content);
              const extractedCandidate = artifactType === 'plan' ? extracted.planDocument : extracted.walkthroughDocument;
              if (extractedCandidate && extractedCandidate.trim().length > 0) {
                content = extractedCandidate;
                break;
              }
            }
          }
        }
      } catch {
        // Session history traversal failure — proceed to next tier
      }
    }

    // 4. Check active reviewer sessions
    if (!content || content.trim().length === 0) {
      try {
        const { activeSession } = await historyStore.loadReviewerSessions();
        if (
          activeSession &&
          activeSession.artifactContent &&
          activeSession.artifactContent.trim().length > 0 &&
          (!activeSession.artifactType || activeSession.artifactType === artifactType)
        ) {
          content = activeSession.artifactContent;
        }
      } catch {
        // Reviewer session lookup failure — proceed to next tier
      }
    }

    // 5. Disk fallback: check for existing artifact files on disk in storageUri or temp directory
    if (!content || content.trim().length === 0) {
      try {
        const artifactsDir = storageUri
          ? vscode.Uri.joinPath(storageUri, 'artifacts')
          : vscode.Uri.file(path.join(os.tmpdir(), 'openrouter-artifacts'));

        // 5a. Check if exact target file for this messageId already exists on disk
        if (messageId) {
          const exactFileUri = ArtifactDocumentManager.getArtifactUri(artifactType, messageId, storageUri);
          try {
            const fileData = await vscode.workspace.fs.readFile(exactFileUri);
            const text = new TextDecoder().decode(fileData);
            if (text && text.trim().length > 0) {
              content = text;
            }
          } catch {
            // File does not exist yet
          }
        }

        // 5b. Find the most recently modified artifact file matching prefix via vscode.workspace.fs
        if (!content || content.trim().length === 0) {
          const prefix = artifactType === 'plan' ? 'implementation_plan_' : 'walkthrough_';
          try {
            const entries = await vscode.workspace.fs.readDirectory(artifactsDir);
            const matchingFiles = entries
              .filter(([name]) => name.startsWith(prefix) && name.endsWith('.md'))
              .map(([name]) => name);

            if (matchingFiles.length > 0) {
              const filesWithStats = await Promise.all(
                matchingFiles.map(async (name) => {
                  const fUri = vscode.Uri.joinPath(artifactsDir, name);
                  try {
                    const stat = await vscode.workspace.fs.stat(fUri);
                    return { name, uri: fUri, mtime: stat.mtime };
                  } catch {
                    return { name, uri: fUri, mtime: 0 };
                  }
                })
              );
              filesWithStats.sort((a, b) => b.mtime - a.mtime);
              if (filesWithStats.length > 0 && filesWithStats[0].mtime > 0) {
                const newest = filesWithStats[0];
                const fileData = await vscode.workspace.fs.readFile(newest.uri);
                const text = new TextDecoder().decode(fileData);
                if (text && text.trim().length > 0) {
                  content = text;
                }
              }
            }
          } catch {
            // Directory read or stat failure
          }
        }

        // 5c. Node fs fallback in case vscode.workspace.fs.readDirectory is not supported or empty
        if ((!content || content.trim().length === 0) && fs.existsSync && fs.existsSync(artifactsDir.fsPath)) {
          const prefix = artifactType === 'plan' ? 'implementation_plan_' : 'walkthrough_';
          try {
            const fileNames = fs.readdirSync(artifactsDir.fsPath).filter((f) => f.startsWith(prefix) && f.endsWith('.md'));
            if (fileNames.length > 0) {
              const filesWithStats = fileNames.map((f) => {
                const fullPath = path.join(artifactsDir.fsPath, f);
                try {
                  const stat = fs.statSync(fullPath);
                  return { fullPath, mtime: stat.mtimeMs };
                } catch {
                  return { fullPath, mtime: 0 };
                }
              });
              filesWithStats.sort((a, b) => b.mtime - a.mtime);
              if (filesWithStats.length > 0 && filesWithStats[0].mtime > 0) {
                const newestContent = fs.readFileSync(filesWithStats[0].fullPath, 'utf8');
                if (newestContent && newestContent.trim().length > 0) {
                  content = newestContent;
                }
              }
            }
          } catch {
            // Node fs scan error
          }
        }
      } catch {
        // Artifacts directory resolution failure
      }
    }

    if (content === undefined || content === null || content.trim().length === 0) {
      return undefined;
    }

    // Cache recovered document back onto the message if found
    if (targetMessage) {
      if (artifactType === 'plan' && !targetMessage.planDocument) {
        targetMessage.planDocument = content;
      } else if (artifactType === 'walkthrough' && !targetMessage.walkthroughDocument) {
        targetMessage.walkthroughDocument = content;
      }
    }

    const targetUri = ArtifactDocumentManager.getArtifactUri(artifactType, messageId, storageUri);

    try {
      const parentDir = vscode.Uri.file(path.dirname(targetUri.fsPath));
      await vscode.workspace.fs.createDirectory(parentDir);
    } catch {
      // Directory may already exist
    }

    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(targetUri, encoder.encode(content));

    return { uri: targetUri, content };
  }

  public static async openArtifactDocument(
    historyStore: HistoryStore,
    artifactType: 'plan' | 'walkthrough',
    messageId?: string,
    fallbackContent?: string,
    storageUri?: vscode.Uri
  ): Promise<vscode.TextDocument | undefined> {
    const prepared = await ArtifactDocumentManager.prepareArtifactFile(
      historyStore,
      artifactType,
      messageId,
      fallbackContent,
      storageUri
    );

    if (!prepared) {
      vscode.window.showErrorMessage(`No ${artifactType} document content found.`);
      return undefined;
    }

    // Open document in an independent editor tab
    const doc = await vscode.workspace.openTextDocument(prepared.uri);
    await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: false,
    });

    return doc;
  }
}

