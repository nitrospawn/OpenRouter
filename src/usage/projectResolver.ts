import * as vscode from 'vscode';
import * as path from 'path';

export class ProjectResolver {
  /**
   * Resolves the active project name from the workspace or active document
   */
  public static getActiveProjectName(): string {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (folder) {
        return folder.name;
      }
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].name;
    }

    return 'Default Project';
  }
}
