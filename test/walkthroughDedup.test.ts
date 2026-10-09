import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { extractArtifacts } from '../src/prompt/responseParser';

test('Walkthrough Guard: unfenced walkthrough fallback ignored when message contains commands or edits', () => {
  const contentWithCommand = `
Here is the plan execution.

### Walkthrough
We are investigating the project files.

\`\`\`powershell
Get-Content 'prd.md'
\`\`\`
`;

  const result = extractArtifacts(contentWithCommand);
  assert.strictEqual(
    result.walkthroughDocument,
    undefined,
    'Unfenced walkthrough must not be extracted when message has terminal commands'
  );
  assert.strictEqual(
    result.chatSummary.includes('Results docs ready'),
    false,
    'Chat summary must not include Results docs notice when walkthrough is ignored'
  );
});

test('Walkthrough Guard: unfenced walkthrough fallback ignored when message contains file edits', () => {
  const contentWithEdit = `
### Walkthrough
Updating the export service.

\`\`\`edit_file:lib/features/export/export_service.dart
<<<< SEARCH
oldCode()
====
newCode()
>>>>
\`\`\`
`;

  const result = extractArtifacts(contentWithEdit);
  assert.strictEqual(
    result.walkthroughDocument,
    undefined,
    'Unfenced walkthrough must not be extracted when message has file edits'
  );
  assert.strictEqual(
    result.chatSummary.includes('Results docs ready'),
    false,
    'Chat summary must not include Results docs notice when walkthrough is ignored'
  );
});

test('Walkthrough Guard: panelProvider.ts strips Results docs notice when walkthrough is discarded', () => {
  const providerPath = path.resolve(__dirname, '../../src/webview/panelProvider.ts');
  const providerContent = fs.readFileSync(providerPath, 'utf8');

  // Verify chatSummary cleaning upon premature walkthrough discard
  assert.ok(
    providerContent.includes('chatSummary = chatSummary') &&
      providerContent.includes('.replace(/📄\\s*(?:Results docs ready|Results docs|Walkthrough result|Walkthrough ready|Result walkthrough)'),
    'panelProvider.ts must strip Results docs ready notice when walkthrough is discarded'
  );

  // Verify pending edits & pending commands checks in walkthrough guard
  assert.ok(
    providerContent.includes('hasPendingEdits') &&
      providerContent.includes('hasPendingCommands'),
    'panelProvider.ts must guard against pending edits and terminal commands in walkthrough check'
  );

  // Verify single walkthrough per task session guard
  assert.ok(
    providerContent.includes('Only one walkthrough document is allowed per task') ||
      providerContent.includes('A walkthrough document already exists for this task'),
    'panelProvider.ts must enforce only one walkthrough document per task'
  );
});

test('Walkthrough Guard: continuation prompts explicitly forbid intermediate walkthrough blocks', () => {
  const providerPath = path.resolve(__dirname, '../../src/webview/panelProvider.ts');
  const providerContent = fs.readFileSync(providerPath, 'utf8');

  assert.ok(
    providerContent.includes('Do NOT emit a walkthrough block during intermediate steps'),
    'panelProvider.ts continuation prompts must instruct model not to emit intermediate walkthrough blocks'
  );
});

test('Walkthrough Guard: systemPrompt.ts enforces exactly one walkthrough per task and forbids emitting with edits/commands', () => {
  const promptPath = path.resolve(__dirname, '../../src/prompt/systemPrompt.ts');
  const promptContent = fs.readFileSync(promptPath, 'utf8');

  assert.ok(
    promptContent.includes('EXACTLY ONE WALKTHROUGH PER TASK'),
    'systemPrompt.ts must mandate exactly one walkthrough per task'
  );
  assert.ok(
    promptContent.includes('in the same message as file edits') &&
      promptContent.includes('walkthrough'),
    'systemPrompt.ts must forbid walkthrough in the same message as file edits or commands'
  );
});

test('Walkthrough Guard: main.ts suppresses walkthrough cards on intermediate steps and deduplicates per task', () => {
  const mainPath = path.resolve(__dirname, '../../src/webview/ui/main.ts');
  const mainContent = fs.readFileSync(mainPath, 'utf8');

  assert.ok(
    mainContent.includes("artifactType === 'walkthrough' && isIntermediate"),
    'main.ts must suppress walkthrough cards on intermediate steps'
  );
  assert.ok(
    mainContent.includes("artifactType === 'walkthrough'") &&
      mainContent.includes('hasExistingWalkthroughCard'),
    'main.ts must enforce at most one walkthrough card per task turn'
  );
});
