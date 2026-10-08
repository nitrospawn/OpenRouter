import test from 'node:test';
import assert from 'node:assert';
import * as vscode from 'vscode';
import { ContextReader } from '../src/editor/contextReader';
import { PermissionManager } from '../src/permissions/permissionManager';

class MockMemento {
  private data: Map<string, any> = new Map();
  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
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

function createPermissionManager(): PermissionManager {
  return new PermissionManager({
    workspaceState: new MockMemento(),
    globalState: new MockMemento(),
  } as any);
}

test('ContextReader: reads fresh live in-memory editor buffer when file is edited across turns', () => {
  const permManager = createPermissionManager();

  // Simulate Turn 1: Editor has version 1 of file
  let docContent = 'def calculate_sum(a, b):\n    return a - b  # Bug: subtraction instead of addition';
  const mockDoc: any = {
    uri: vscode.Uri.file('C:/mock/workspace/math.py'),
    fileName: 'C:/mock/workspace/math.py',
    languageId: 'python',
    getText: (range?: any) => docContent,
  };

  const mockEditor: any = {
    document: mockDoc,
    selection: { isEmpty: true },
  };

  (vscode.window as any).activeTextEditor = mockEditor;
  (vscode.window as any).visibleTextEditors = [mockEditor];
  (vscode.workspace as any).textDocuments = [mockDoc];

  // Turn 1 read
  const turn1Context = ContextReader.getActiveEditorContext(permManager);
  assert.strictEqual(turn1Context.hasContext, true);
  assert.strictEqual(turn1Context.relativePath, 'math.py');
  assert.ok(turn1Context.fileContent?.includes('return a - b'));

  // User edits file in editor buffer (without saving to disk yet)
  docContent = 'def calculate_sum(a, b):\n    return a + b  # Fixed: addition now';

  // Turn 2 read: must immediately and freshly reflect the modified editor buffer
  const turn2Context = ContextReader.getActiveEditorContext(permManager);
  assert.strictEqual(turn2Context.hasContext, true);
  assert.ok(turn2Context.fileContent?.includes('return a + b'));
  assert.strictEqual(turn2Context.fileContent?.includes('return a - b'), false);
});

test('ContextReader: falls back to visibleTextEditors when activeTextEditor is undefined (webview focus)', () => {
  const permManager = createPermissionManager();

  const docContent = 'console.log("Hello from visible editor");';
  const mockDoc: any = {
    uri: vscode.Uri.file('C:/mock/workspace/index.ts'),
    fileName: 'C:/mock/workspace/index.ts',
    languageId: 'typescript',
    getText: () => docContent,
  };

  const mockEditor: any = {
    document: mockDoc,
    selection: { isEmpty: true },
  };

  // When webview input has focus, activeTextEditor is undefined
  (vscode.window as any).activeTextEditor = undefined;
  (vscode.window as any).visibleTextEditors = [mockEditor];
  (vscode.workspace as any).textDocuments = [mockDoc];

  const ctx = ContextReader.getActiveEditorContext(permManager);
  assert.strictEqual(ctx.hasContext, true);
  assert.strictEqual(ctx.relativePath, 'index.ts');
  assert.strictEqual(ctx.fileContent, docContent);
});

test('ContextReader.findAndReadWorkspaceFile: prioritizes unsaved in-memory textDocument over disk content', async () => {
  const permManager = createPermissionManager();

  const diskContent = 'DISK CONTENT: OLD VERSION';
  const memoryContent = 'MEMORY BUFFER: LIVE EDITED CONTENT';

  const fileUri = vscode.Uri.file('C:/mock/workspace/src/app.ts');

  // Mock workspace findFiles to return our target
  (vscode.workspace as any).findFiles = async (pattern: string) => {
    return [fileUri];
  };

  // Mock disk read
  (vscode.workspace as any).fs.readFile = async () => {
    return new TextEncoder().encode(diskContent);
  };

  // Open document in editor with unsaved memory content
  const openDoc: any = {
    uri: fileUri,
    getText: () => memoryContent,
  };
  (vscode.workspace as any).textDocuments = [openDoc];

  const result = await ContextReader.findAndReadWorkspaceFile('app.ts', permManager);
  assert.ok(result);
  assert.strictEqual(result?.relativePath, 'src/app.ts');
  // Must return memoryContent, NOT diskContent!
  assert.strictEqual(result?.content, memoryContent);
});

test('ContextReader.findAndReadWorkspaceFile: matches open documents case-insensitively (e.g. prd.md matches PRD.md)', async () => {
  const permManager = createPermissionManager();
  const prdContent = '# Product Requirements Document\nOffline-First Android Note-Taking App';
  const prdUri = vscode.Uri.file('C:/mock/workspace/PRD.md');

  const openDoc: any = {
    uri: prdUri,
    getText: () => prdContent,
  };
  (vscode.workspace as any).textDocuments = [openDoc];
  (vscode.workspace as any).findFiles = async () => []; // findFiles fails (case sensitivity)

  // Query in lowercase 'prd.md' while open document is 'PRD.md'
  const result = await ContextReader.findAndReadWorkspaceFile('prd.md', permManager);
  assert.ok(result, 'Should resolve PRD.md from lowercase query');
  assert.strictEqual(result?.relativePath, 'PRD.md');
  assert.strictEqual(result?.content, prdContent);
});

test('ContextReader: excludes .openrouter and activity_log.md from active editor context and file search', async () => {
  const permManager = createPermissionManager();
  const logDoc: any = {
    uri: vscode.Uri.file('C:/mock/workspace/.openrouter/activity_log.md'),
    fileName: 'C:/mock/workspace/.openrouter/activity_log.md',
    languageId: 'markdown',
    getText: () => '# Activity Log\n- Secret past activity',
  };
  const mockEditor: any = {
    document: logDoc,
    selection: { isEmpty: true },
  };

  (vscode.window as any).activeTextEditor = mockEditor;
  (vscode.window as any).visibleTextEditors = [mockEditor];
  (vscode.workspace as any).textDocuments = [logDoc];

  // Should ignore active editor context when user has activity_log.md open
  const ctx = ContextReader.getActiveEditorContext(permManager);
  assert.strictEqual(ctx.hasContext, false, 'Should not ingest .openrouter/activity_log.md as active editor code file');

  // Should reject reading activity_log.md via findAndReadWorkspaceFile
  const readDirect = await ContextReader.findAndReadWorkspaceFile('activity_log.md', permManager);
  assert.strictEqual(readDirect, null, 'Should block direct query for activity_log.md');

  const readRel = await ContextReader.findAndReadWorkspaceFile('.openrouter/activity_log.md', permManager);
  assert.strictEqual(readRel, null, 'Should block query for .openrouter/activity_log.md');
});


