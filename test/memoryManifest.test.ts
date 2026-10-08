import test from 'node:test';
import assert from 'node:assert';
import { MemoryManifest } from '../src/memory/memoryManifest';

test('MemoryManifest: parseMarkdown parses active, in-progress, and reverted entries with metadata', () => {
  const md = `# OpenRouter Workspace Activity Log & Model Memory

- [2026-09-24 22:30] ✓ COMPLETED: Added user authentication <!-- META:{"id":"task-1","timestamp":1700000000000,"status":"completed","checkpointId":"chk-123","affectedFiles":["src/auth.ts"]} -->
- [2026-09-24 22:45] ⏳ IN PROGRESS: Implementing database layer <!-- META:{"id":"task-2","timestamp":1700001000000,"status":"in_progress","checkpointId":"chk-456","affectedFiles":["src/db.ts"]} -->
- ~~[2026-09-24 22:50] Reverted feature~~ [REVERTED by user] <!-- META:{"id":"task-3","timestamp":1700002000000,"status":"reverted","checkpointId":"chk-789","affectedFiles":["src/old.ts"]} -->
`;

  const entries = MemoryManifest.parseMarkdown(md);
  assert.strictEqual(entries.length, 3);

  assert.strictEqual(entries[0].id, 'task-1');
  assert.strictEqual(entries[0].status, 'completed');
  assert.strictEqual(entries[0].checkpointId, 'chk-123');
  assert.deepStrictEqual(entries[0].affectedFiles, ['src/auth.ts']);

  assert.strictEqual(entries[1].id, 'task-2');
  assert.strictEqual(entries[1].status, 'in_progress');
  assert.strictEqual(entries[1].checkpointId, 'chk-456');

  assert.strictEqual(entries[2].id, 'task-3');
  assert.strictEqual(entries[2].status, 'reverted');
  assert.strictEqual(entries[2].checkpointId, 'chk-789');
});

test('MemoryManifest: handles plain markdown lines without meta comment gracefully', () => {
  const md = `- [2026-09-24 22:00] ✓ COMPLETED: Quick manual fix
- ~~[2026-09-24 22:10] Old test~~ [REVERTED by user]
`;

  const entries = MemoryManifest.parseMarkdown(md);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].status, 'completed');
  assert.strictEqual(entries[0].taskTitle, 'Quick manual fix');
  assert.strictEqual(entries[1].status, 'reverted');
  assert.strictEqual(entries[1].taskTitle, 'Old test');
});

test('Configuration: Workspace Memory in Context defaults to true and updates per-workspace', async () => {
  const { Configuration } = await import('../src/settings/configuration');

  // Default is true
  assert.strictEqual(Configuration.getWorkspaceMemoryInContext(), true);

  // Toggle off
  await Configuration.setWorkspaceMemoryInContext(false);
  assert.strictEqual(Configuration.getWorkspaceMemoryInContext(), false);

  // Toggle back on immediately without reload
  await Configuration.setWorkspaceMemoryInContext(true);
  assert.strictEqual(Configuration.getWorkspaceMemoryInContext(), true);
});

test('GitignoreRespect: protects .openrouter directory from shadow git restore / commits', async () => {
  const { GitignoreRespect } = await import('../src/shadowGit/gitignoreRespect');

  assert.strictEqual(GitignoreRespect.isIgnored('C:/mock/workspace', '.openrouter/activity_log.md'), true);
  assert.strictEqual(GitignoreRespect.isIgnored('C:/mock/workspace', '.openrouter\\activity_log.md'), true);
  assert.strictEqual(GitignoreRespect.isIgnored('C:/mock/workspace', 'src/app.ts'), false);
});

test('MemoryManifest: storageUri initialization directs manifest Uri to storageUri/memory/activity_log.md', async () => {
  const vscode = await import('vscode');
  const mockStorageUri = vscode.Uri.file('C:/Users/test/AppData/Roaming/Code/User/workspaceStorage/test-hash');

  MemoryManifest.initialize(mockStorageUri);
  const manifestUri = MemoryManifest.getManifestUri();

  assert.ok(manifestUri !== null);
  const normalizedPath = manifestUri.fsPath.replace(/\\/g, '/');
  assert.ok(
    normalizedPath.endsWith('/memory/activity_log.md'),
    `Expected path to end with /memory/activity_log.md, got ${normalizedPath}`
  );
  assert.ok(
    normalizedPath.includes('workspaceStorage/test-hash'),
    `Expected path to include storage directory, got ${normalizedPath}`
  );

  // Clean up
  MemoryManifest.initialize(undefined);
});

