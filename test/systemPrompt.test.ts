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

  // 3. Targeted Navigation
  assert.ok(prompt.includes('Phase 3: Targeted Navigation & Precision Code Generation'));
  assert.ok(prompt.includes('Targeted scope over full-file dumping'));

  // 4. Code Verification Before Declaring Completion
  assert.ok(prompt.includes('Phase 4: Code Verification Before Declaring Completion'));
  assert.ok(prompt.includes('Re-check VS Code diagnostics on affected files'));
});

test('buildSystemPrompt: explicitly forbids mid-response pseudo tool-calls and explains context mechanism', () => {
  const prompt = buildSystemPrompt();

  // Tooling restrictions
  assert.ok(prompt.includes('You do NOT have the ability to invoke tools (such as read_file, search_workspace, grep, or terminal runners) mid-response.'));
  assert.ok(prompt.includes('There is NO tool-calling loop or mechanism in this extension watching for or executing tool calls.'));
  assert.ok(prompt.includes('NEVER emit fake or pseudo tool-call syntax (such as `read_file:...`, `search:...`, or similar) expecting it to be executed.'));
  
  // Pre-gathered context explanation
  assert.ok(prompt.includes('pre-gathered by the extension and injected directly into the prompt BEFORE you are called.'));
  
  // Missing file instruction
  assert.ok(prompt.includes('If a Required File Is Not in Context:'));
  assert.ok(prompt.includes('Do NOT simulate a tool call (e.g. do NOT write `read_file:...`).'));
  assert.ok(prompt.includes('Directly and politely ask the user to open or provide the relevant content of that file'));
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
  assert.ok(prompt.includes('When target file is explicitly named:'));
  assert.ok(prompt.includes('proceed directly against that named file using the provided file context without questioning where it is'));
});

test('buildSystemPrompt: handles nonexistent named file with fallback search & plain language clarification', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('Nonexistent Named File Fallback:'));
  assert.ok(prompt.includes('do NOT hallucinate its contents or pretend to fetch it via a tool call'));
  assert.ok(prompt.includes('Check the workspace file tree list in your prompt for near matches or related files'));
  assert.ok(prompt.includes('ask the user for clarification in plain language, suggesting the closest candidate files found'));
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

test('buildSystemPrompt: injects dynamic OS and shell environment for Windows (win32)', () => {
  const prompt = buildSystemPrompt({
    environment: {
      platform: 'win32',
      shell: 'cmd.exe',
    },
  });

  assert.ok(prompt.includes('Operating System: Windows (win32)'));
  assert.ok(prompt.includes('Default Terminal Shell: cmd.exe'));
  assert.ok(prompt.includes('You are running on Windows using cmd.exe'));
  assert.ok(prompt.includes('To show current working directory in cmd.exe, use `cd` without arguments (do NOT use `pwd`)'));
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
  assert.ok(prompt.includes('Default Terminal Shell: zsh'));
  assert.ok(prompt.includes('Standard bash/POSIX syntax applies'));
  assert.ok(prompt.includes('```bash'));
});

test('buildSystemPrompt: injects recent terminal outputs into prompt context', () => {
  const prompt = buildSystemPrompt({
    terminalOutputs: '[Exit code: 0] Tests ran cleanly.',
  });

  assert.ok(prompt.includes('--- Recent Terminal Outputs ---'));
  assert.ok(prompt.includes('[Exit code: 0] Tests ran cleanly.'));
});

test('buildSystemPrompt: enforces Plan Storage Directive forbidding model from asking to save plan as file', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('Plan Storage Directive (CRITICAL)'));
  assert.ok(prompt.includes('NEVER ask or offer to save the plan as a file'));
  assert.ok(prompt.includes('The plan is ALREADY saved as an artifact by the extension'));
});

test('buildSystemPrompt: enforces Autonomous Multi-Step Execution directive forbidding pausing between steps', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('Autonomous Multi-Step Execution (NO MID-TASK PAUSING)'));
  assert.ok(prompt.includes('DO NOT PAUSE TO ASK PERMISSION BETWEEN STEPS'));
  assert.ok(prompt.includes('STRICTLY PROHIBITED during plan implementation'));
});


