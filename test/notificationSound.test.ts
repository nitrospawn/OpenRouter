import test from 'node:test';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { Configuration } from '../src/settings/configuration';

test('Notification Sound Configuration: defaults and mutation verification', async () => {
  // Verify defaults
  (vscode.workspace as any)._config = new Map<string, any>();

  const defaultSound = Configuration.getNotificationSound();
  assert.strictEqual(defaultSound, true, 'notificationSound must default to true (enabled)');

  const defaultTone = Configuration.getNotificationTone();
  assert.strictEqual(defaultTone, 'bell', 'notificationTone must default to "bell"');

  // Verify updating sound toggle
  await Configuration.setNotificationSound(false);
  assert.strictEqual(Configuration.getNotificationSound(), false, 'notificationSound must be updated to false');

  await Configuration.setNotificationSound(true);
  assert.strictEqual(Configuration.getNotificationSound(), true, 'notificationSound must be restored to true');

  // Verify updating tone presets
  await Configuration.setNotificationTone('chime');
  assert.strictEqual(Configuration.getNotificationTone(), 'chime', 'notificationTone must update to chime');

  await Configuration.setNotificationTone('pop');
  assert.strictEqual(Configuration.getNotificationTone(), 'pop', 'notificationTone must update to pop');

  await Configuration.setNotificationTone('ding');
  assert.strictEqual(Configuration.getNotificationTone(), 'ding', 'notificationTone must update to ding');

  await Configuration.setNotificationTone('bell');
  assert.strictEqual(Configuration.getNotificationTone(), 'bell', 'notificationTone must reset to bell');
});

test('Notification Sound: ConfirmationDialogs triggers onPermissionPrompt callback on prompt', async () => {
  const { ConfirmationDialogs } = await import('../src/permissions/confirmationDialogs');
  let promptCount = 0;
  ConfirmationDialogs.onPermissionPrompt = () => {
    promptCount++;
  };

  // Mock showWarningMessage
  const origWarning = vscode.window.showWarningMessage;
  (vscode.window as any).showWarningMessage = async () => 'Allow Once';

  try {
    await ConfirmationDialogs.confirmFileEdit('test.ts', false);
    assert.strictEqual(promptCount, 1, 'confirmFileEdit must trigger onPermissionPrompt');

    await ConfirmationDialogs.confirmFileDelete('test.ts');
    assert.strictEqual(promptCount, 2, 'confirmFileDelete must trigger onPermissionPrompt');

    await ConfirmationDialogs.confirmTerminalCommand('npm test', '.', false);
    assert.strictEqual(promptCount, 3, 'confirmTerminalCommand must trigger onPermissionPrompt');
  } finally {
    (vscode.window as any).showWarningMessage = origWarning;
    ConfirmationDialogs.onPermissionPrompt = undefined;
  }
});

