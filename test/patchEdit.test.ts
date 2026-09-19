import test from 'node:test';
import assert from 'node:assert';
import { DiffPreviewManager } from '../src/editor/diffPreview';
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
