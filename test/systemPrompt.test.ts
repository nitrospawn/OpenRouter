import test from 'node:test';
import assert from 'node:assert';
import { buildSystemPrompt } from '../src/prompt/systemPrompt';

test('buildSystemPrompt: includes all four sequential behavioral directives', () => {
  const prompt = buildSystemPrompt();

  // 1. Context Resolution & Clarification
  assert.ok(prompt.includes('Phase 1: Context-Aware Clarification — Resolve Before Asking'));
  assert.ok(prompt.includes('Do NOT default to asking the user "which file?" or "where is this?"'));

  // 2. Default to Plan
  assert.ok(prompt.includes('Phase 2: Default-to-Plan Behavior'));
  assert.ok(prompt.includes('first produce a short implementation plan in plain language'));

  // 3. Search Before Read
  assert.ok(prompt.includes('Phase 3: Search-Before-Read Code Navigation'));
  assert.ok(prompt.includes('Prefer targeted search and grep-style tools/queries'));

  // 4. Code Verification Before Declaring Completion
  assert.ok(prompt.includes('Phase 4: Code Verification Before Declaring Completion'));
  assert.ok(prompt.includes('Re-check VS Code diagnostics on affected files'));
});

test('buildSystemPrompt: enforces strict order of operations in core workflow', () => {
  const prompt = buildSystemPrompt();

  const idxOrder = prompt.indexOf('Core Workflow & Order of Operations');
  const idxP1 = prompt.indexOf('1. Context Resolution & Clarification');
  const idxP2 = prompt.indexOf('2. Implementation Planning');
  const idxP3 = prompt.indexOf('3. Action Execution & Targeted Navigation');
  const idxP4 = prompt.indexOf('4. Post-Application Verification');

  assert.ok(idxOrder !== -1);
  assert.ok(idxP1 > idxOrder);
  assert.ok(idxP2 > idxP1);
  assert.ok(idxP3 > idxP2);
  assert.ok(idxP4 > idxP3);
});

test('buildSystemPrompt: skips search entirely when target file is explicitly stated', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('Skip search entirely when the file/location is already explicitly stated'));
  assert.ok(prompt.includes('proceed directly against that named file without first running a workspace search'));
});

test('buildSystemPrompt: handles nonexistent named file with fallback search & plain language clarification', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('Nonexistent Named File Fallback:'));
  assert.ok(prompt.includes('do NOT hallucinate its contents or fail silently'));
  assert.ok(prompt.includes('Check the workspace file tree for near matches or related files'));
  assert.ok(prompt.includes('ask for clarification using plain language and list the closest candidate files found'));
});

test('buildSystemPrompt: supports plan override phrases and trivial single-file exceptions', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('"just do it"'));
  assert.ok(prompt.includes('"skip the plan"'));
  assert.ok(prompt.includes('"go ahead"'));
  assert.ok(prompt.includes('Trivial fixes exception:'));
  assert.ok(prompt.includes('Genuinely trivial, single-file, low-risk, unambiguous changes'));
});

test('buildSystemPrompt: enforces terminal confirmation requirement for verification test runs', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('Terminal Confirmation Requirement:'));
  assert.ok(prompt.includes('MUST go through the user\'s explicit confirmation/permission flow'));
  assert.ok(prompt.includes('Never treat test runs as silent internal actions'));
});

test('buildSystemPrompt: injects active file buffer, workspace files, and referenced files', () => {
  const prompt = buildSystemPrompt({
    activeFile: {
      relativePath: 'src/main.ts',
      languageId: 'typescript',
      fileContent: 'console.log("active");',
      selectedText: 'console.log("active");',
    },
    workspaceFiles: ['src/main.ts', 'src/util.ts'],
    referencedFile: {
      relativePath: 'src/util.ts',
      content: 'export const x = 1;',
    },
  });

  assert.ok(prompt.includes('File: src/main.ts (typescript)'));
  assert.ok(prompt.includes('console.log("active");'));
  assert.ok(prompt.includes('--- Workspace Files ---'));
  assert.ok(prompt.includes('src/util.ts'));
  assert.ok(prompt.includes('--- Referenced Workspace File (LIVE BUFFER - AUTHORITATIVE) ---'));
  assert.ok(prompt.includes('export const x = 1;'));
});
