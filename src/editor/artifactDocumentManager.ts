import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { HistoryStore } from '../conversation/historyStore';

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
   */
  public static async prepareArtifactFile(
    historyStore: HistoryStore,
    artifactType: 'plan' | 'walkthrough',
    messageId?: string,
    fallbackContent?: string,
    storageUri?: vscode.Uri
  ): Promise<{ uri: vscode.Uri; content: string } | undefined> {
    let content: string | undefined;

    if (messageId) {
      const msg = await historyStore.getMessageById(messageId);
      if (msg) {
        content = artifactType === 'plan' ? msg.planDocument : msg.walkthroughDocument;
      }
    }

    if (content === undefined) {
      content = fallbackContent;
    }

    if (content === undefined || content === null) {
      return undefined;
    }

    const targetUri = ArtifactDocumentManager.getArtifactUri(artifactType, messageId, storageUri);

    try {
      const parentDir = vscode.Uri.file(path.dirname(targetUri.fsPath));
      await vscode.workspace.fs.createDirectory(parentDir);
    } catch {
      // ignore
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

    // Open document as preview (read-only style presentation in editor tab)
    const doc = await vscode.workspace.openTextDocument(prepared.uri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: false,
    });

    return doc;
  }
}

