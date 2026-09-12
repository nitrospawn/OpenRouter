import * as vscode from 'vscode';
import { PermissionManager } from '../permissions/permissionManager';

export interface StructuredDiagnostic {
  uri: vscode.Uri;
  relativePath: string;
  diagnostic: vscode.Diagnostic;
}

export class DiagnosticManager {
  /**
   * Retrieves diagnostics for the current active/visible editor.
   * Scoped to open editor buffer, requires 'readActiveContext' permission.
   */
  public static getCurrentFileDiagnostics(
    permissionManager: PermissionManager,
    includeWarnings = false
  ): StructuredDiagnostic[] {
    const perm = permissionManager.getPermission('readActiveContext');
    if (perm === 'deny') {
      return [];
    }

    let editor = vscode.window.activeTextEditor;
    if (!editor && vscode.window.visibleTextEditors && vscode.window.visibleTextEditors.length > 0) {
      editor = vscode.window.visibleTextEditors.find(
        (e) => e.document && e.document.uri && e.document.uri.scheme === 'file'
      ) || vscode.window.visibleTextEditors[0];
    }

    if (!editor || !editor.document) {
      return [];
    }

    const docUri = editor.document.uri;
    const allDiags = vscode.languages.getDiagnostics(docUri);

    const filtered = allDiags.filter((d) => {
      if (d.severity === vscode.DiagnosticSeverity.Error) return true;
      if (includeWarnings && d.severity === vscode.DiagnosticSeverity.Warning) return true;
      return false;
    });

    const relativePath = vscode.workspace.asRelativePath(docUri);
    return filtered.map((diag) => ({
      uri: docUri,
      relativePath,
      diagnostic: diag,
    }));
  }

  /**
   * Retrieves diagnostics across all files in the workspace.
   * Scoped to whole project, strictly requires 'readWorkspaceFiles' permission.
   */
  public static getAllWorkspaceDiagnostics(
    permissionManager: PermissionManager,
    includeWarnings = false
  ): StructuredDiagnostic[] {
    const perm = permissionManager.getPermission('readWorkspaceFiles');
    if (perm === 'deny') {
      return [];
    }

    const allEntries = vscode.languages.getDiagnostics();
    const results: StructuredDiagnostic[] = [];

    for (const [uri, diags] of allEntries) {
      // Exclude non-file schemes or node_modules/git
      if (uri.scheme !== 'file') continue;
      const relativePath = vscode.workspace.asRelativePath(uri);
      if (relativePath.includes('node_modules/') || relativePath.includes('.git/')) continue;

      const filtered = diags.filter((d) => {
        if (d.severity === vscode.DiagnosticSeverity.Error) return true;
        if (includeWarnings && d.severity === vscode.DiagnosticSeverity.Warning) return true;
        return false;
      });

      for (const diag of filtered) {
        results.push({
          uri,
          relativePath,
          diagnostic: diag,
        });
      }
    }

    return results;
  }

  /**
   * Extracts ±paddingLines around the diagnostic range with line numbering.
   */
  public static extractSurroundingContext(
    document: vscode.TextDocument,
    range: vscode.Range,
    paddingLines = 25
  ): { snippet: string; startLineNumber: number; endLineNumber: number } {
    const totalLines = document.lineCount;
    const startLine = Math.max(0, range.start.line - paddingLines);
    const endLine = Math.min(totalLines - 1, range.end.line + paddingLines);

    const lines: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      const lineText = document.lineAt(i).text;
      const isTarget = i >= range.start.line && i <= range.end.line;
      const marker = isTarget ? '>' : ' ';
      const lineNumStr = String(i + 1).padStart(4, ' ');
      lines.push(`${marker} ${lineNumStr} | ${lineText}`);
    }

    return {
      snippet: lines.join('\n'),
      startLineNumber: startLine + 1,
      endLineNumber: endLine + 1,
    };
  }

  /**
   * Formats a single problem into a structured prompt turn with surrounding code.
   */
  public static formatSingleProblemPrompt(
    diagnostic: vscode.Diagnostic,
    document: vscode.TextDocument
  ): string {
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    const severityLabel =
      diagnostic.severity === vscode.DiagnosticSeverity.Error
        ? 'Error'
        : diagnostic.severity === vscode.DiagnosticSeverity.Warning
        ? 'Warning'
        : 'Information';

    const source = diagnostic.source ? `[${diagnostic.source}] ` : '';
    const code = diagnostic.code ? ` (${diagnostic.code})` : '';
    const range = diagnostic.range;
    const location = `Line ${range.start.line + 1}:${range.start.character + 1} - Line ${range.end.line + 1}:${range.end.character + 1}`;

    const { snippet, startLineNumber, endLineNumber } = this.extractSurroundingContext(document, range, 25);

    return `Please fix the following VS Code diagnostic:

File: ${relativePath}
Location: ${location}
Severity: ${severityLabel}
Message: ${source}${diagnostic.message}${code}

Surrounding Code (Lines ${startLineNumber} - ${endLineNumber}):
\`\`\`${document.languageId || 'text'}
${snippet}
\`\`\`

Please resolve this problem and provide the corrected code using an \`\`\`edit_file:${relativePath} code block.`;
  }

  /**
   * Formats a list of diagnostics into a structured bulk report.
   */
  public static formatBulkProblemsPrompt(
    diagnostics: StructuredDiagnostic[],
    scopeLabel: string
  ): string {
    if (diagnostics.length === 0) {
      return `No active problems found in ${scopeLabel}.`;
    }

    // Group by relativePath
    const grouped = new Map<string, StructuredDiagnostic[]>();
    for (const item of diagnostics) {
      const list = grouped.get(item.relativePath) || [];
      list.push(item);
      grouped.set(item.relativePath, list);
    }

    let report = `--- Diagnostics Report (${scopeLabel}: ${diagnostics.length} issue${diagnostics.length === 1 ? '' : 's'}) ---\n`;
    report += `Please resolve the following diagnostic issues across the codebase:\n\n`;

    for (const [filePath, items] of grouped.entries()) {
      report += `### File: ${filePath} (${items.length} issue${items.length === 1 ? '' : 's'})\n`;
      for (const item of items) {
        const d = item.diagnostic;
        const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARNING';
        const src = d.source ? `[${d.source}] ` : '';
        const code = d.code ? ` (${d.code})` : '';
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        report += `- [${sev}] Line ${line}:${col} - ${src}${d.message}${code}\n`;
      }
      report += '\n';
    }

    report += `\nPlease analyze the root causes and provide fixes using \`\`\`edit_file:<path>\`\`\` blocks for each affected file.`;
    return report;
  }

  /**
   * Conservative token estimation formula:
   * Math.ceil(chars / 3.0) + (count * 15)
   */
  public static estimateDiagnosticTokens(text: string, diagnosticCount: number): number {
    return Math.ceil(text.length / 3.0) + diagnosticCount * 15;
  }
}
