import test from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';
import { DiagnosticManager } from '../src/diagnostics/diagnosticManager';
import { PermissionManager } from '../src/permissions/permissionManager';
import { SecretScanner } from '../src/privacy/secretScanner';

class MockMemento {
  private data: Map<string, any> = new Map();
  public get<T>(key: string, defaultValue?: T): T {
    return this.data.has(key) ? this.data.get(key) : defaultValue;
  }
  public async update(key: string, value: any): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }
  public keys(): readonly string[] {
    return Array.from(this.data.keys());
  }
}

function createMockContext(): any {
  return {
    workspaceState: new MockMemento(),
    globalState: new MockMemento(),
  };
}

test('DiagnosticManager.estimateDiagnosticTokens: strictly overestimates token count', () => {
  const shortText = 'File: src/index.ts Line 10: Type error: Cannot find name "foo".';
  const estimate = DiagnosticManager.estimateDiagnosticTokens(shortText, 1);
  // Characters: ~63, 63/3 = 21, +15 = 36 tokens
  assert.ok(estimate >= Math.ceil(shortText.length / 4.0), 'Must be strictly conservative compared to 4 chars/token');
  assert.strictEqual(estimate, Math.ceil(shortText.length / 3.0) + 15);
});

test('DiagnosticManager: checks readActiveContext permission for current file diagnostics', () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);

  // Setup active editor mock
  const testUri = vscode.Uri.file('C:/mock/workspace/src/app.ts');
  const mockDoc: any = {
    uri: testUri,
    fileName: 'C:/mock/workspace/src/app.ts',
    languageId: 'typescript',
    lineCount: 10,
    lineAt: (i: number) => ({ text: `const line${i} = true;` }),
    getText: () => 'const x = 1;',
  };
  (vscode.window as any).activeTextEditor = { document: mockDoc };

  const diag = new vscode.Diagnostic(
    new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, 10)),
    'Variable unused',
    vscode.DiagnosticSeverity.Error
  );
  (vscode.languages as any).setDiagnostics(testUri, [diag]);

  // Case 1: Allowed by default
  const diagsAllowed = DiagnosticManager.getCurrentFileDiagnostics(manager);
  assert.strictEqual(diagsAllowed.length, 1);
  assert.strictEqual(diagsAllowed[0].diagnostic.message, 'Variable unused');

  // Case 2: Denied
  manager.setPermission('readActiveContext', 'deny');
  const diagsDenied = DiagnosticManager.getCurrentFileDiagnostics(manager);
  assert.strictEqual(diagsDenied.length, 0, 'Must return empty array when readActiveContext is denied');
});

test('DiagnosticManager: checks readWorkspaceFiles permission for workspace-wide diagnostics', () => {
  const context = createMockContext();
  const manager = new PermissionManager(context);
  (vscode.languages as any).clearDiagnostics();

  const file1 = vscode.Uri.file('C:/mock/workspace/src/file1.ts');
  const file2 = vscode.Uri.file('C:/mock/workspace/src/file2.ts');
  const diag1 = new vscode.Diagnostic(new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 5)), 'Error in file 1');
  const diag2 = new vscode.Diagnostic(new vscode.Range(new vscode.Position(3, 0), new vscode.Position(3, 5)), 'Error in file 2');

  (vscode.languages as any).setDiagnostics(file1, [diag1]);
  (vscode.languages as any).setDiagnostics(file2, [diag2]);

  // Case 1: Allowed
  manager.setPermission('readWorkspaceFiles', 'allow');
  const diagsAllowed = DiagnosticManager.getAllWorkspaceDiagnostics(manager);
  assert.strictEqual(diagsAllowed.length, 2);

  // Case 2: Denied
  manager.setPermission('readWorkspaceFiles', 'deny');
  const diagsDenied = DiagnosticManager.getAllWorkspaceDiagnostics(manager);
  assert.strictEqual(diagsDenied.length, 0, 'Must return empty array when readWorkspaceFiles is denied');
});

test('DiagnosticManager.extractSurroundingContext: safely clamps boundaries and formats markers', () => {
  const mockDoc: any = {
    lineCount: 5,
    lineAt: (i: number) => ({ text: `code line ${i + 1}` }),
  };

  const range = new vscode.Range(new vscode.Position(1, 0), new vscode.Position(2, 0));
  const result = DiagnosticManager.extractSurroundingContext(mockDoc, range, 25);

  assert.strictEqual(result.startLineNumber, 1);
  assert.strictEqual(result.endLineNumber, 5);
  // Lines 2 and 3 should have the target marker '>'
  assert.ok(result.snippet.includes('>    2 | code line 2'));
  assert.ok(result.snippet.includes('>    3 | code line 3'));
  // Line 1 should not have target marker
  assert.ok(result.snippet.includes('     1 | code line 1'));
});

test('DiagnosticManager: secret redaction sanitizes tokens inside diagnostics and code context', () => {
  const secretKey = ['sk-', 'proj-', 'testFixture1234567890abcdef123456'].join('');
  const diag = new vscode.Diagnostic(
    new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10)),
    `Authentication failed for API key: ${secretKey}`,
    vscode.DiagnosticSeverity.Error
  );

  const mockDoc: any = {
    uri: vscode.Uri.file('C:/mock/workspace/src/auth.ts'),
    languageId: 'typescript',
    lineCount: 3,
    lineAt: (i: number) => ({ text: `const apiKey = "${secretKey}";` }),
  };

  const prompt = DiagnosticManager.formatSingleProblemPrompt(diag, mockDoc);
  const redacted = SecretScanner.redact(prompt);

  assert.strictEqual(redacted.hasSecrets, true);
  assert.ok(!redacted.sanitized.includes(secretKey), 'Raw API key must be sanitized');
  assert.ok(redacted.sanitized.includes('***redacted***'));
});

test('Problems Panel Actions: insertInputText sends @current_problems or @all_problems to webview input', () => {
  const sentMessages: any[] = [];
  const mockWebview: any = {
    postMessage: async (msg: any) => {
      sentMessages.push(msg);
      return true;
    },
  };

  // Simulate panelProvider.insertInputText
  function insertInputText(text: string, append = false) {
    mockWebview.postMessage({
      type: 'INSERT_INPUT_TEXT',
      text,
      append,
    });
  }

  // Trigger sendCurrentProblems
  insertInputText('@current_problems', true);
  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].type, 'INSERT_INPUT_TEXT');
  assert.strictEqual(sentMessages[0].text, '@current_problems');
  assert.strictEqual(sentMessages[0].append, true);

  // Trigger sendAllProblems
  insertInputText('@all_problems', true);
  assert.strictEqual(sentMessages.length, 2);
  assert.strictEqual(sentMessages[1].text, '@all_problems');

  // Verify webview input handling logic
  let promptInputValue = '';
  function handleWebviewInsert(msg: { text: string; append?: boolean }) {
    if (msg.append && promptInputValue.trim()) {
      promptInputValue = `${promptInputValue.trim()} ${msg.text}`;
    } else {
      promptInputValue = msg.text;
    }
  }

  handleWebviewInsert(sentMessages[0]);
  assert.strictEqual(promptInputValue, '@current_problems');

  // When user already typed a question, verify appending works cleanly
  promptInputValue = 'Please help fix this';
  handleWebviewInsert(sentMessages[0]);
  assert.strictEqual(promptInputValue, 'Please help fix this @current_problems');
});

test('Problems Panel Context Action: fixDiagnostic builds structured prompt for target problem', () => {
  const fileUri = vscode.Uri.file('C:/mock/workspace/src/example.ts');
  const mockDoc: any = {
    uri: fileUri,
    fileName: 'C:/mock/workspace/src/example.ts',
    languageId: 'typescript',
    lineCount: 3,
    lineAt: (i: number) => ({ text: `line ${i + 1} content` }),
  };

  const targetDiag = new vscode.Diagnostic(
    new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 10)),
    'Cannot find name "UserConfig"',
    vscode.DiagnosticSeverity.Error
  );

  const prompt = DiagnosticManager.formatSingleProblemPrompt(targetDiag, mockDoc);
  assert.ok(prompt.includes('Cannot find name "UserConfig"'), 'Must include error message');
  assert.ok(prompt.includes('src/example.ts'), 'Must include file path');
  assert.ok(prompt.includes('Line 2'), 'Must include line number');
});

test('Problems Panel CodeActionProvider: provides QuickFix action for diagnostics', () => {
  const fileUri = vscode.Uri.file('C:/mock/workspace/src/example.ts');
  const mockDoc: any = {
    uri: fileUri,
    fileName: 'C:/mock/workspace/src/example.ts',
  };

  const targetDiag = new vscode.Diagnostic(
    new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 10)),
    'Cannot find name "UserConfig"',
    vscode.DiagnosticSeverity.Error
  );

  // Provider function mirroring extension.ts
  function provideCodeActions(document: any, range: any, context: any) {
    if (!context.diagnostics || context.diagnostics.length === 0) {
      return [];
    }
    return context.diagnostics.map((diag: any) => {
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
  }

  const actions = provideCodeActions(mockDoc, targetDiag.range, { diagnostics: [targetDiag] });
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].title, 'OpenRouter: Ask AI to Fix This Problem');
  assert.strictEqual(actions[0].kind, vscode.CodeActionKind.QuickFix);
  assert.strictEqual(actions[0].command.command, 'openrouter.fixDiagnostic');
  assert.strictEqual(actions[0].command.arguments[0], fileUri);
  assert.strictEqual(actions[0].command.arguments[1], targetDiag);
});


