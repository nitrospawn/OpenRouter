import test from 'node:test';
import assert from 'node:assert';
import { extractFileMentions } from '../src/webview/panelProvider';

test('extractFileMentions: extracts explicit @ mentions', () => {
  const result = extractFileMentions('Please check @src/index.ts and @file:README.md');
  assert.deepStrictEqual(result, ['src/index.ts', 'README.md']);
});

test('extractFileMentions: extracts quoted filenames', () => {
  const result = extractFileMentions('Inspect "PRD.md" and \'database.sql\' and `config.json`');
  assert.deepStrictEqual(result, ['PRD.md', 'database.sql', 'config.json']);
});

test('extractFileMentions: extracts bare filenames with recognized extensions', () => {
  const result = extractFileMentions('I want to work with types.ts and schema.prisma');
  assert.deepStrictEqual(result, ['types.ts', 'schema.prisma']);
});

test('extractFileMentions: extracts intent patterns like copy PRD.md into prdv2.md', () => {
  const result = extractFileMentions('copy PRD.md into prdv2.md');
  assert.deepStrictEqual(result, ['PRD.md', 'prdv2.md']);

  const intentResult = extractFileMentions('based on spec.md, update auth.dart and read schema.json');
  assert.ok(intentResult.includes('spec.md'));
  assert.ok(intentResult.includes('auth.dart'));
  assert.ok(intentResult.includes('schema.json'));
});

test('extractFileMentions: ignores file extensions within URLs', () => {
  const result = extractFileMentions('Check https://example.com/docs/file.ts and read local.ts');
  assert.deepStrictEqual(result, ['local.ts']);
});

test('extractFileMentions: deduplicates and strips punctuation/relative prefixes', () => {
  const result = extractFileMentions('read ./src/utils.ts, and check "./src/utils.ts" again.');
  assert.deepStrictEqual(result, ['src/utils.ts']);
});

test('extractFileMentions: limits output to maximum 5 candidates', () => {
  const result = extractFileMentions('f1.ts f2.ts f3.ts f4.ts f5.ts f6.ts f7.ts');
  assert.strictEqual(result.length, 5);
  assert.deepStrictEqual(result, ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts']);
});

test('extractFileMentions: conversational tier suppresses bare filenames and intent patterns', () => {
  // Bare filenames like express.ts or intent patterns like "copy foo.ts" should be ignored on conversational tier
  const bareMsg = 'I want something similar to express.ts and copy foo.ts';
  const conversationalResult = extractFileMentions(bareMsg, 'conversational');
  assert.deepStrictEqual(conversationalResult, []);

  // Explicit @ mentions and quoted filenames should still be extracted on conversational tier
  const explicitMsg = 'What does @src/index.ts and "PRD.md" do? Also express.ts';
  const explicitResult = extractFileMentions(explicitMsg, 'conversational');
  assert.deepStrictEqual(explicitResult, ['src/index.ts', 'PRD.md']);

  // Editing and executing tiers still extract bare filenames and intent patterns
  const editingResult = extractFileMentions(bareMsg, 'editing');
  assert.ok(editingResult.includes('express.ts'));
  assert.ok(editingResult.includes('foo.ts'));

  const executingResult = extractFileMentions(bareMsg, 'executing');
  assert.ok(executingResult.includes('express.ts'));
  assert.ok(executingResult.includes('foo.ts'));
});

