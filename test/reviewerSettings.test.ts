import test from 'node:test';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { Configuration } from '../src/settings/configuration';

test('Reviewer Configuration: master toggle defaults to OFF in fresh workspace', () => {
  // Ensure clean workspace state
  (vscode.workspace as any)._currentWorkspaceKey = 'fresh-workspace-1';
  
  const isEnabled = Configuration.getReviewerEnabled();
  assert.strictEqual(isEnabled, false, 'Reviewer Model master toggle must default to OFF (false)');
  
  const reviewerModel = Configuration.getReviewerModel();
  assert.strictEqual(reviewerModel, '', 'Reviewer Model should default to empty string');
  
  const reasoningEffort = Configuration.getReviewerReasoningEffort();
  assert.strictEqual(reasoningEffort, 'medium', 'Reasoning effort should default to medium');

  const systemPrompt = Configuration.getReviewerSystemPrompt();
  assert.strictEqual(
    systemPrompt,
    Configuration.DEFAULT_REVIEWER_SYSTEM_PROMPT,
    'System prompt should default to DEFAULT_REVIEWER_SYSTEM_PROMPT'
  );
});

test('Reviewer Configuration: settings are persisted per-workspace and do not leak across workspaces', async () => {
  // Workspace A: Configure Reviewer Model
  (vscode.workspace as any)._currentWorkspaceKey = 'project-alpha';
  
  await Configuration.setReviewerEnabled(true);
  await Configuration.setReviewerModel('anthropic/claude-3.7-sonnet');
  await Configuration.setReviewerReasoningEffort('high');
  await Configuration.setReviewerSystemPrompt('Custom reviewer prompt for Project Alpha');

  assert.strictEqual(Configuration.getReviewerEnabled(), true);
  assert.strictEqual(Configuration.getReviewerModel(), 'anthropic/claude-3.7-sonnet');
  assert.strictEqual(Configuration.getReviewerReasoningEffort(), 'high');
  assert.strictEqual(Configuration.getReviewerSystemPrompt(), 'Custom reviewer prompt for Project Alpha');

  // Switch to Workspace B: should show its own settings (defaults), not Workspace A's settings
  (vscode.workspace as any)._currentWorkspaceKey = 'project-beta';

  assert.strictEqual(Configuration.getReviewerEnabled(), false, 'Workspace B should have master toggle OFF by default');
  assert.strictEqual(Configuration.getReviewerModel(), '', 'Workspace B should have no reviewer model set');
  assert.strictEqual(Configuration.getReviewerReasoningEffort(), 'medium', 'Workspace B should have default reasoning effort');
  assert.strictEqual(
    Configuration.getReviewerSystemPrompt(),
    Configuration.DEFAULT_REVIEWER_SYSTEM_PROMPT,
    'Workspace B should have default system prompt'
  );

  // Switch back to Workspace A: original settings remain intact
  (vscode.workspace as any)._currentWorkspaceKey = 'project-alpha';
  assert.strictEqual(Configuration.getReviewerEnabled(), true);
  assert.strictEqual(Configuration.getReviewerModel(), 'anthropic/claude-3.7-sonnet');
  assert.strictEqual(Configuration.getReviewerReasoningEffort(), 'high');
  assert.strictEqual(Configuration.getReviewerSystemPrompt(), 'Custom reviewer prompt for Project Alpha');
});

test('Reviewer Configuration: Reset to Default restores prompt for current workspace only', async () => {
  // Setup Workspace 1 with custom prompt
  (vscode.workspace as any)._currentWorkspaceKey = 'ws-one';
  await Configuration.setReviewerSystemPrompt('Specialized prompt for WS One');

  // Setup Workspace 2 with custom prompt
  (vscode.workspace as any)._currentWorkspaceKey = 'ws-two';
  await Configuration.setReviewerSystemPrompt('Specialized prompt for WS Two');

  assert.strictEqual(Configuration.getReviewerSystemPrompt(), 'Specialized prompt for WS Two');

  // Reset WS Two to default
  await Configuration.resetReviewerSystemPrompt();
  assert.strictEqual(
    Configuration.getReviewerSystemPrompt(),
    Configuration.DEFAULT_REVIEWER_SYSTEM_PROMPT,
    'WS Two prompt should now be restored to default'
  );

  // Check WS One: untouched!
  (vscode.workspace as any)._currentWorkspaceKey = 'ws-one';
  assert.strictEqual(
    Configuration.getReviewerSystemPrompt(),
    'Specialized prompt for WS One',
    'WS One prompt must remain untouched after resetting WS Two'
  );
});

test('Reviewer Configuration: live mid-session update reflects immediately without reload', async () => {
  (vscode.workspace as any)._currentWorkspaceKey = 'live-session-ws';
  
  assert.strictEqual(Configuration.getReviewerEnabled(), false);
  
  // Toggle ON mid-session
  await Configuration.setReviewerEnabled(true);
  assert.strictEqual(Configuration.getReviewerEnabled(), true, 'Toggle update must be immediate');

  // Pick model mid-session
  await Configuration.setReviewerModel('openai/o3-mini');
  assert.strictEqual(Configuration.getReviewerModel(), 'openai/o3-mini', 'Model update must be immediate');

  // Update reasoning effort mid-session
  await Configuration.setReviewerReasoningEffort('low');
  assert.strictEqual(Configuration.getReviewerReasoningEffort(), 'low', 'Reasoning effort update must be immediate');

  // Edit prompt text mid-session
  await Configuration.setReviewerSystemPrompt('Strict security audit mode');
  assert.strictEqual(Configuration.getReviewerSystemPrompt(), 'Strict security audit mode', 'Prompt update must be immediate');
});
