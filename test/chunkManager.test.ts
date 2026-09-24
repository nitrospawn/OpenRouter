import test from 'node:test';
import assert from 'node:assert';
import { ChunkManager } from '../src/editor/chunkManager';

test('ChunkManager: token estimation computes conservative ratio', () => {
  assert.strictEqual(ChunkManager.estimateTokens(''), 0);
  const text = 'abcdefghij'; // 10 chars
  // 10 / 3.8 = 2.63 -> 3 tokens
  assert.strictEqual(ChunkManager.estimateTokens(text), 3);
});

test('ChunkManager: calculateAvailableFileTokens reserves overhead', () => {
  // 128k context with 10k history, 4k prompt, 4k output
  const available = ChunkManager.calculateAvailableFileTokens(128000, 10000);
  assert.strictEqual(available, 128000 - (10000 + 4000 + 4000));
  // Under extreme overhead, guarantees at least 2000 tokens
  const minimal = ChunkManager.calculateAvailableFileTokens(4000, 10000);
  assert.strictEqual(minimal, 2000);
});

test('ChunkManager: createFileBatches returns 1 batch when file fits within budget', () => {
  const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
  const batches = ChunkManager.createFileBatches(content, 1000);

  assert.strictEqual(batches.length, 1);
  assert.strictEqual(batches[0].batchIndex, 1);
  assert.strictEqual(batches[0].totalBatches, 1);
  assert.strictEqual(batches[0].startLine, 1);
  assert.strictEqual(batches[0].endLine, 5);
  assert.strictEqual(batches[0].totalLines, 5);
  assert.strictEqual(batches[0].content, content);
});

test('ChunkManager: createFileBatches partitions content when exceeding budget', () => {
  // Generate 100 lines
  const lines: string[] = [];
  for (let i = 1; i <= 100; i++) {
    lines.push(`Line ${i}: this is some simulated code or documentation content.`);
  }
  const content = lines.join('\n');

  // Budget of 200 tokens (approx 760 chars; each line is ~65 chars, so ~10 lines per batch)
  const batches = ChunkManager.createFileBatches(content, 200, 5);

  assert.ok(batches.length > 1, `Expected multiple batches, got ${batches.length}`);
  assert.strictEqual(batches[0].startLine, 1);
  assert.strictEqual(batches[batches.length - 1].endLine, 100);
  assert.strictEqual(batches[0].totalLines, 100);

  // Check continuity and overlap
  for (let i = 0; i < batches.length; i++) {
    assert.strictEqual(batches[i].batchIndex, i + 1);
    assert.strictEqual(batches[i].totalBatches, batches.length);
    assert.ok(batches[i].content.length > 0);
  }
});

test('ChunkManager: selectRelevantBatch selects tail batch for append intent', () => {
  const batches = [
    { batchIndex: 1, totalBatches: 3, startLine: 1, endLine: 50, totalLines: 150, content: 'Batch 1' },
    { batchIndex: 2, totalBatches: 3, startLine: 45, endLine: 100, totalLines: 150, content: 'Batch 2' },
    { batchIndex: 3, totalBatches: 3, startLine: 95, endLine: 150, totalLines: 150, content: 'Batch 3' },
  ];

  const appendPrompt = 'add the comment "thank you" to the end of the file';
  const selected = ChunkManager.selectRelevantBatch(batches, appendPrompt);
  assert.strictEqual(selected.batchIndex, 3);
  assert.strictEqual(selected.content, 'Batch 3');
});

test('ChunkManager: selectRelevantBatch selects batch matching line number mention', () => {
  const batches = [
    { batchIndex: 1, totalBatches: 3, startLine: 1, endLine: 50, totalLines: 150, content: 'Batch 1' },
    { batchIndex: 2, totalBatches: 3, startLine: 45, endLine: 100, totalLines: 150, content: 'Batch 2' },
    { batchIndex: 3, totalBatches: 3, startLine: 95, endLine: 150, totalLines: 150, content: 'Batch 3' },
  ];

  const linePrompt = 'what is on line 75 of PRD.md?';
  const selected = ChunkManager.selectRelevantBatch(batches, linePrompt);
  assert.strictEqual(selected.batchIndex, 2);
  assert.strictEqual(selected.content, 'Batch 2');
});

test('ChunkManager: selectRelevantBatch selects batch containing active editor selection', () => {
  const batches = [
    { batchIndex: 1, totalBatches: 3, startLine: 1, endLine: 50, totalLines: 150, content: 'function alpha() {}' },
    { batchIndex: 2, totalBatches: 3, startLine: 45, endLine: 100, totalLines: 150, content: 'function beta() {}' },
    { batchIndex: 3, totalBatches: 3, startLine: 95, endLine: 150, totalLines: 150, content: 'function gamma() {}' },
  ];

  const selected = ChunkManager.selectRelevantBatch(batches, 'refactor this function', 'function beta()');
  assert.strictEqual(selected.batchIndex, 2);
});
