import test from 'node:test';
import assert from 'node:assert';
import { DiffPreviewManager } from '../src/editor/diffPreview';
import { ChunkManager } from '../src/editor/chunkManager';
import { buildSystemPrompt } from '../src/prompt/systemPrompt';

test('TargetedEdit: applies SEARCH/REPLACE block correctly (happy path)', () => {
  const originalContent = `function hello() {
  console.log('world');
}

export function auth() {
  return true;
}
`;

  const proposedContent = `<<<< SEARCH
export function auth() {
  return true;
}
====
export function auth(token: string) {
  return token === 'secret';
}
>>>>`;

  const expectedContent = `function hello() {
  console.log('world');
}

export function auth(token: string) {
  return token === 'secret';
}
`;

  const resolved = DiffPreviewManager.resolveProposedContent(originalContent, proposedContent);
  assert.strictEqual(resolved, expectedContent);
});

test('TargetedEdit: fails cleanly with error when SEARCH block does not match exactly', () => {
  const originalContent = `function hello() {
  console.log('world');
}

export function auth() {
  return true;
}
`;

  // Provide a search block that does not exist in the original file
  const proposedContent = `<<<< SEARCH
export function auth(oldParam: any) {
  return true;
}
====
export function auth(token: string) {
  return token === 'secret';
}
>>>>`;

  assert.throws(
    () => {
      DiffPreviewManager.resolveProposedContent(originalContent, proposedContent);
    },
    (err: any) => {
      return err.message.includes('The AI\'s proposed edit no longer matches this file\'s current content');
    },
    'Should throw exact match failure error'
  );
});

test('TargetedEdit: falls back to full-file replace when no SEARCH blocks are present', () => {
  const originalContent = `function hello() {
  console.log('world');
}`;

  const proposedContent = `function goodbye() {
  console.log('world');
}`;

  const resolved = DiffPreviewManager.resolveProposedContent(originalContent, proposedContent);
  assert.strictEqual(resolved, proposedContent);
});

test('TargetedEdit: fails on malformed SEARCH/REPLACE block', () => {
  const originalContent = `function hello() {
  console.log('world');
}`;

  // Malformed: missing ==== 
  const proposedContent = `<<<< SEARCH
function hello() {
  console.log('world');
}
>>>>`;

  assert.throws(
    () => {
      DiffPreviewManager.resolveProposedContent(originalContent, proposedContent);
    },
    (err: any) => {
      return err.message.includes('malformed SEARCH/REPLACE block');
    },
    'Should throw malformed block error'
  );
});

test('TargetedEdit: correctly parses SEARCH block containing actual >>>> strings (e.g. git merge conflict markers)', () => {
  const originalContent = `function hello() {
<<<<<<< HEAD
  console.log('world');
=======
  console.log('universe');
>>>>>>> branch-a
}`;

  const proposedContent = `<<<< SEARCH
<<<<<<< HEAD
  console.log('world');
=======
  console.log('universe');
>>>>>>> branch-a
====
  console.log('multiverse');
>>>>`;

  const expectedContent = `function hello() {
  console.log('multiverse');
}`;

  const resolved = DiffPreviewManager.resolveProposedContent(originalContent, proposedContent);
  assert.strictEqual(resolved, expectedContent);
});

test('TargetedEdit: fails cleanly on file drift (file changed after AI proposed edit)', () => {
  // 1. Original file state when AI gathered context (the expectation)
  const stateWhenContextGathered = `function hello() {
  console.log('world');
}`;

  // 2. AI proposes an edit based on that state
  const aiProposedEdit = `<<<< SEARCH
function hello() {
  console.log('world');
}
====
function hello(name: string) {
  console.log('world ' + name);
}
>>>>`;

  // 3. User edits the file locally before applying the edit (simulating drift)
  const currentDiskState = `function hello() {
  console.log('world!'); // user changed this manually
}`;

  // 4. Applying the edit should now fail because the SEARCH block matches the old state, not the current state
  assert.throws(
    () => {
      DiffPreviewManager.resolveProposedContent(currentDiskState, aiProposedEdit);
    },
    (err: any) => {
      return err.message.includes('The AI\'s proposed edit no longer matches this file\'s current content');
    },
    'Should throw exact match failure error due to drift'
  );
});

test('TargetedEdit: empty SEARCH block against genuinely empty file succeeds (Turn 1 initial creation)', () => {
  const emptyOriginalContent = '';
  const proposedContent = `<<<< SEARCH
====
# tonye raine
>>>>`;

  const resolved = DiffPreviewManager.resolveProposedContent(emptyOriginalContent, proposedContent);
  assert.strictEqual(resolved, '# tonye raine', 'Empty SEARCH block against empty file must resolve to REPLACE block');

  // Also verify with whitespace-only empty file
  const whitespaceOriginalContent = '   \n  ';
  const resolved2 = DiffPreviewManager.resolveProposedContent(whitespaceOriginalContent, proposedContent);
  assert.strictEqual(resolved2, '# tonye raine');
});

test('TargetedEdit: empty SEARCH block against non-empty file fails with clear error (Turn 2 regression)', () => {
  const nonEmptyOriginalContent = '# tonye raine\n';
  const proposedContent = `<<<< SEARCH
====
# tonye raine
# second line
>>>>`;

  assert.throws(
    () => {
      DiffPreviewManager.resolveProposedContent(nonEmptyOriginalContent, proposedContent);
    },
    (err: any) => {
      return err.message.includes('Empty SEARCH block is not allowed');
    },
    'Empty SEARCH block against non-empty file must fail with clear error'
  );
});

test('TargetedEdit: anchored SEARCH block against non-empty file succeeds (appending with context)', () => {
  const nonEmptyOriginalContent = `# tonye raine\n`;
  const proposedContent = `<<<< SEARCH
# tonye raine
====
# tonye raine
# say my name
>>>>`;

  const resolved = DiffPreviewManager.resolveProposedContent(nonEmptyOriginalContent, proposedContent);
  assert.strictEqual(resolved, '# tonye raine\n# say my name\n', 'Anchored SEARCH block against non-empty file must succeed');
});

test('System Prompt: contains explicit guidance for empty SEARCH blocks and anchored additions', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('CRITICAL RULE FOR APPENDING / ADDING CONTENT & EMPTY SEARCH BLOCKS'));
  assert.ok(prompt.includes('ONLY valid when the target file is genuinely empty'));
  assert.ok(prompt.includes('Empty SEARCH block is not allowed'));
});

test('DiffPreviewManager.applyEdit: auto-opens newly created file with preserveFocus and saves document', async () => {
  const vscode = require('vscode');
  const { PermissionManager } = require('../src/permissions/permissionManager');
  const permManager = new PermissionManager();
  const newFileUri = vscode.Uri.file('C:/mock/workspace/new-feature.ts');

  let statCalled = false;
  vscode.workspace.fs.stat = async (uri: any) => {
    statCalled = true;
    throw new Error('File not found'); // simulates new file
  };

  let saved = false;
  let shownDoc: any = null;
  let shownOpts: any = null;

  vscode.workspace.openTextDocument = async (uri: any) => ({
    getText: () => '',
    positionAt: (offset: number) => new vscode.Position(0, offset),
    save: async () => {
      saved = true;
      return true;
    },
  });

  vscode.window.showTextDocument = async (doc: any, opts: any) => {
    shownDoc = doc;
    shownOpts = opts;
    return { document: doc };
  };

  const success = await DiffPreviewManager.applyEdit(
    newFileUri,
    'export const a = 1;',
    permManager,
    true
  );

  assert.strictEqual(success, true, 'applyEdit must return true');
  assert.strictEqual(saved, true, 'doc.save() must be called automatically');
  assert.ok(shownDoc, 'showTextDocument must be called for newly created file');
  assert.strictEqual(shownOpts.preserveFocus, true, 'preserveFocus must be true to not interrupt chat');
  assert.strictEqual(shownOpts.preview, false, 'preview must be false so files open independently in new tabs');
});

test('TargetedEdit: handles trailing whitespace and marker variations on SEARCH/REPLACE markers', () => {
  const original = `Line 1\nLine 2\nLine 3\n`;
  // Markers have trailing spaces and tabs
  const proposed = `<<<< SEARCH   \nLine 2\n====  \nLine 2 updated\n>>>>   `;
  const resolved = DiffPreviewManager.resolveProposedContent(original, proposed);
  assert.strictEqual(resolved, `Line 1\nLine 2 updated\nLine 3\n`);
});

test('TargetedEdit: automatically unwraps spurious accidental code fences inside replace block', () => {
  const original = `## Section\nSome text\n`;
  // Model accidentally wrapped the comment in a ```text code fence inside the replace block
  const proposed = `<<<< SEARCH\nSome text\n====\nSome text\n\`\`\`text\n<!-- Thank you -->\n\`\`\`\n>>>>`;
  const resolved = DiffPreviewManager.resolveProposedContent(original, proposed);
  assert.strictEqual(resolved, `## Section\nSome text\n<!-- Thank you -->\n`);
});

test('TargetedEdit: matches and applies SEARCH block with line-trailing whitespace differences (trimEnd fallback)', () => {
  const original = `function test() {\n  return 42;\n}\n`;
  // Search block has trailing spaces after { and return 42;
  const proposed = `<<<< SEARCH\nfunction test() {   \n  return 42;  \n}\n====\nfunction test() {\n  return 100;\n}\n>>>>`;
  const resolved = DiffPreviewManager.resolveProposedContent(original, proposed);
  assert.strictEqual(resolved, `function test() {\n  return 100;\n}\n`);
});

test('TargetedEdit: action regex parses edit_file block containing inner code fences without premature truncation', () => {
  const fileActionRegex = /(?:```|````)(?:create_file|edit_file|file):([^\r\n]+)\r?\n((?:[\s\S]*?<<<< SEARCH[\s\S]*?\n>>>>[^\r\n]*|[\s\S]*?))\r?\n(?:```|````)/gi;
  const rawResponse = `Here is the fix:
\`\`\`edit_file:PRD.md
<<<< SEARCH
---

### Phase Dependency Summary
====
---

### Phase Dependency Summary

\`\`\`text
<!-- Thank you -->
\`\`\`
>>>>
\`\`\`
Hope this helps!`;

  const match = fileActionRegex.exec(rawResponse);
  assert.ok(match, 'Must match the edit_file block');
  assert.strictEqual(match[1].trim(), 'PRD.md');
  assert.ok(match[2].includes('<<<< SEARCH'));
  assert.ok(match[2].includes('===='));
  assert.ok(match[2].includes('>>>>'));

  // Stripping custom action block from chat text leaves leading and trailing prose intact
  const cleaned = rawResponse.replace(fileActionRegex, '').trim();
  assert.ok(cleaned.includes('Here is the fix:'));
  assert.ok(cleaned.includes('Hope this helps!'));
  assert.ok(!cleaned.includes('===='));
  assert.ok(!cleaned.includes('>>>>'));
});

test('TargetedEdit: EOF append fallback gracefully succeeds when model searches for prompt fence ``` on file without backticks', () => {
  const original = `# Project PRD\n\nSome introductory text.\n\n### Phase Dependency Summary\n`;
  // The model mistook the prompt's closing markdown fence for the last line of the file and emitted:
  const proposed = `<<<< SEARCH
\`\`\`
====
\`\`\`

thank you
>>>>`;
  const resolved = DiffPreviewManager.resolveProposedContent(original, proposed);
  assert.ok(resolved.includes('### Phase Dependency Summary'));
  assert.ok(resolved.includes('thank you'));
  assert.ok(resolved.endsWith('thank you\n'));
});

test('TargetedEdit: unwraps accidental code fences when model wraps both search and replace blocks', () => {
  const original = `function compute() {\n  return 1;\n}\n`;
  const proposed = `<<<< SEARCH
\`\`\`ts
function compute() {
  return 1;
}
\`\`\`
====
\`\`\`ts
function compute() {
  return 2;
}
\`\`\`
>>>>`;
  const resolved = DiffPreviewManager.resolveProposedContent(original, proposed);
  assert.strictEqual(resolved, `function compute() {\n  return 2;\n}\n`);
});

test('TargetedEdit: successfully applies code deletion with empty REPLACE block (====\n>>>>)', () => {
  const original = `class FailureTaxonomy {
  void liveMethod() {
    print('live');
  }

  void _RecoveryStub() {
    print('stub');
  }
}
`;

  const proposed = `<<<< SEARCH
  void _RecoveryStub() {
    print('stub');
  }
====
>>>>`;

  const resolved = DiffPreviewManager.resolveProposedContent(original, proposed);
  assert.strictEqual(
    resolved,
    `class FailureTaxonomy {\n  void liveMethod() {\n    print('live');\n  }\n\n\n}\n`
  );
  assert.ok(!resolved.includes('_RecoveryStub'));
});

test('TargetedEdit: successfully applies mixed replacements and deletions in a single proposal', () => {
  const original = `function step1() { return 1; }\nfunction deadMethod() { return 0; }\nfunction step2() { return 2; }\n`;

  const proposed = `<<<< SEARCH
function step1() { return 1; }
====
function step1() { return 100; }
>>>>

<<<< SEARCH
function deadMethod() { return 0; }
====
>>>>

<<<< SEARCH
function step2() { return 2; }
====
function step2() { return 200; }
>>>>`;

  const resolved = DiffPreviewManager.resolveProposedContent(original, proposed);
  assert.strictEqual(
    resolved,
    `function step1() { return 100; }\n\nfunction step2() { return 200; }\n`
  );
  assert.ok(!resolved.includes('deadMethod'));
});


