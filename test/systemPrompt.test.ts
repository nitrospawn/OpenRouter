import test from 'node:test';
import assert from 'node:assert';
import { buildSystemPrompt } from '../src/prompt/systemPrompt';

test('buildSystemPrompt: includes all four sequential behavioral directives', () => {
  const prompt = buildSystemPrompt();

  // The 4-step rule
  assert.ok(prompt.includes('SECTION 6 — THE FOUR-STEP RULE (FOLLOW THIS ORDER ON EVERY REQUEST)'));
  assert.ok(prompt.includes('STEP 1 → UNDERSTAND  (resolve what the user wants)'));
  assert.ok(prompt.includes('STEP 2 → DECIDE      (plan only when a plan is genuinely needed — see rules below)'));
  assert.ok(prompt.includes('STEP 3 → ACT         (create/edit files, run commands — no pausing mid-task)'));
  assert.ok(prompt.includes('STEP 4 → VERIFY      (confirm the result is correct before declaring done)'));
});

test('buildSystemPrompt: explicitly forbids mid-response pseudo tool-calls and explains context mechanism', () => {
  const prompt = buildSystemPrompt();

  // Tooling restrictions & context explanation
  assert.ok(prompt.includes('You do NOT have tool-calling ability. There is NO tool loop watching your output.'));
  assert.ok(prompt.includes('NEVER emit fake tool calls like `read_file:...` or `search:...`.'));
  assert.ok(prompt.includes('has ALREADY been injected into this prompt by the extension BEFORE you were called.'));
});

test('buildSystemPrompt: enforces strict order of operations in core workflow', () => {
  const prompt = buildSystemPrompt();

  const idxOrder = prompt.indexOf('THE FOUR-STEP RULE');
  const idxP1 = prompt.indexOf('STEP 1 → UNDERSTAND');
  const idxP2 = prompt.indexOf('STEP 2 → DECIDE');
  const idxP3 = prompt.indexOf('STEP 3 → ACT');
  const idxP4 = prompt.indexOf('STEP 4 → VERIFY');

  assert.ok(idxOrder !== -1);
  assert.ok(idxP1 > idxOrder);
  assert.ok(idxP2 > idxP1);
  assert.ok(idxP3 > idxP2);
  assert.ok(idxP4 > idxP3);
});

test('buildSystemPrompt: skips search entirely when target file is explicitly stated', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('If the user names a file explicitly (e.g. "edit auth.ts"), go straight to that file. Do not search for it first.'));
});

test('buildSystemPrompt: handles nonexistent named file with fallback search & plain language clarification', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('Only ask the user for a file if it genuinely does not exist anywhere'));
  assert.ok(prompt.includes('Only ask a clarifying question if you have genuinely tried and failed to resolve ambiguity from the available context.'));
  assert.ok(prompt.includes('When you do ask, give concrete options in plain language: "I found two candidate files'));
});

test('buildSystemPrompt: supports plan override phrases and trivial single-file exceptions', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('"just do it"'));
  assert.ok(prompt.includes('"skip the plan"'));
  assert.ok(prompt.includes('"go ahead"'));
  assert.ok(prompt.includes('Trivial single-file change: typo fix, rename, one-liner'));
  assert.ok(prompt.includes('ACT DIRECTLY — NO PLAN NEEDED'));
});

test('buildSystemPrompt: enforces terminal confirmation requirement for verification test runs', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('--- HOW TO RUN TERMINAL COMMANDS ---'));
  assert.ok(prompt.includes('never pipe output through anything that masks the exit code'));
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
  assert.ok(prompt.includes('WORKSPACE FILES'));
  assert.ok(prompt.includes('src/util.ts'));
  assert.ok(prompt.includes('REFERENCED FILE (LIVE BUFFER — AUTHORITATIVE)'));
  assert.ok(prompt.includes('export const x = 1;'));
});

test('buildSystemPrompt: injects dynamic OS and shell environment for Windows (win32)', () => {
  const prompt = buildSystemPrompt({
    environment: {
      platform: 'win32',
      shell: 'cmd.exe',
    },
  });

  assert.ok(prompt.includes('Operating System: Windows (win32)'));
  assert.ok(prompt.includes('Default Shell: cmd.exe'));
  assert.ok(prompt.includes('You are on WINDOWS'));
  assert.ok(prompt.includes('Current dir   → cd (no arguments) in cmd'));
  assert.ok(prompt.includes('```cmd'));
});

test('buildSystemPrompt: injects dynamic OS and shell environment for POSIX (darwin/linux)', () => {
  const prompt = buildSystemPrompt({
    environment: {
      platform: 'darwin',
      shell: 'zsh',
    },
  });

  assert.ok(prompt.includes('Operating System: macOS (darwin)'));
  assert.ok(prompt.includes('Default Shell: zsh'));
  assert.ok(prompt.includes('Standard zsh syntax applies'));
  assert.ok(prompt.includes('```bash'));
});

test('buildSystemPrompt: injects recent terminal outputs into prompt context', () => {
  const prompt = buildSystemPrompt({
    terminalOutputs: '[Exit code: 0] Tests ran cleanly.',
  });

  assert.ok(prompt.includes('RECENT TERMINAL OUTPUTS'));
  assert.ok(prompt.includes('[Exit code: 0] Tests ran cleanly.'));
});

test('buildSystemPrompt: enforces Plan Storage Directive forbidding model from asking to save plan as file', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('RULES FOR PLAN BLOCKS:'));
  assert.ok(prompt.includes('The extension saves the plan automatically. NEVER offer to save it as a file.'));
});

test('buildSystemPrompt: enforces Autonomous Multi-Step Execution directive forbidding pausing between steps', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('STEP 3 → ACT         (create/edit files, run commands — no pausing mid-task)'));
  assert.ok(prompt.includes('Execute ALL steps without pausing. No mid-task check-ins.'));
});



