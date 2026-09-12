export interface MockUri {
  fsPath: string;
  path: string;
  scheme: string;
  toString: () => string;
}

export const workspace: any = {
  workspaceFolders: [
    {
      uri: {
        fsPath: 'C:/mock/workspace',
        path: '/C:/mock/workspace',
        scheme: 'file',
        toString: () => 'file:///C:/mock/workspace',
      },
      name: 'test-project',
      index: 0,
    },
  ],
  textDocuments: [],
  asRelativePath: (uri: any) => {
    const p = typeof uri === 'string' ? uri : uri.fsPath || uri.path;
    return p.replace(/^C:\/mock\/workspace\//, '').replace(/^\/C:\/mock\/workspace\//, '');
  },
  getWorkspaceFolder: (uri: any) => {
    return workspace.workspaceFolders[0];
  },
  findFiles: async (pattern: string, exclude: string, maxResults?: number) => {
    return [];
  },
  fs: {
    readFile: async (uri: any) => new Uint8Array(),
    writeFile: async (uri: any, content: any) => undefined,
    createDirectory: async (uri: any) => undefined,
  },
  applyEdit: async (edit: any) => true,
};

export const Uri = {
  file: (pathStr: string) => ({
    fsPath: pathStr,
    path: pathStr,
    scheme: 'file',
    toString: () => `file:///${pathStr}`,
  }),
  joinPath: (base: { fsPath: string; path: string }, ...segments: string[]) => ({
    fsPath: `${base.fsPath}/${segments.join('/')}`,
    path: `${base.path}/${segments.join('/')}`,
    scheme: 'file',
    toString: () => `file:///${base.fsPath}/${segments.join('/')}`,
  }),
};

export const window: any = {
  activeTextEditor: undefined,
  visibleTextEditors: [],
  terminals: [],
  createTerminal: (options: any) => {
    const t = {
      name: options?.name || 'OpenRouter Terminal',
      show: () => {},
      sendText: (_cmd: string) => {},
    };
    window.terminals.push(t);
    return t;
  },
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
};

export const commands = {
  executeCommand: async () => undefined,
};

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  constructor(public start: Position, public end: Position) {}
}

export class WorkspaceEdit {
  public operations: any[] = [];
  public createFile(uri: any, options?: any) {
    this.operations.push({ type: 'createFile', uri, options });
  }
  public insert(uri: any, position: Position, newText: string) {
    this.operations.push({ type: 'insert', uri, position, newText });
  }
  public replace(uri: any, range: Range, newText: string) {
    this.operations.push({ type: 'replace', uri, range, newText });
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  public source?: string;
  public code?: string | number;
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error
  ) {}
}

export class CodeAction {
  public command?: any;
  public diagnostics?: Diagnostic[];
  constructor(public title: string, public kind?: any) {}
}

export const CodeActionKind = {
  QuickFix: { value: 'quickfix' },
};

export const languages: any = {
  _diagnostics: new Map<string, Diagnostic[]>(),
  _codeActionProviders: [] as any[],
  registerCodeActionProvider: (selector: any, provider: any, metadata?: any) => {
    const entry = { selector, provider, metadata };
    languages._codeActionProviders.push(entry);
    return {
      dispose: () => {
        const idx = languages._codeActionProviders.indexOf(entry);
        if (idx !== -1) languages._codeActionProviders.splice(idx, 1);
      },
    };
  },
  getDiagnostics: (uri?: any) => {
    if (uri) {
      const key = uri.fsPath || uri.path || uri.toString();
      return languages._diagnostics.get(key) || [];
    }
    const all: [any, Diagnostic[]][] = [];
    for (const [key, diags] of languages._diagnostics.entries()) {
      all.push([Uri.file(key), diags]);
    }
    return all;
  },
  setDiagnostics: (uri: any, diags: Diagnostic[]) => {
    const key = uri.fsPath || uri.path || uri.toString();
    languages._diagnostics.set(key, diags);
  },
  clearDiagnostics: () => {
    languages._diagnostics.clear();
  },
};

