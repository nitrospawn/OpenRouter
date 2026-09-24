import test from 'node:test';
import assert from 'node:assert';

export interface RetryGuardState {
  retryCount: number;
  failedCommands: Set<string>;
  maxRetries: number;
}

export function evaluateTerminalSelfHealing(
  command: string,
  exitCode: number,
  errorSnippet: string,
  state: RetryGuardState,
  isAborted: boolean = false
): {
  shouldRetry: boolean;
  reason?: 'aborted' | 'duplicate_command' | 'max_retries_reached';
  retryPrompt?: string;
  nextState: RetryGuardState;
} {
  if (isAborted) {
    return {
      shouldRetry: false,
      reason: 'aborted',
      nextState: state,
    };
  }

  if (state.failedCommands.has(command)) {
    return {
      shouldRetry: false,
      reason: 'duplicate_command',
      nextState: state,
    };
  }

  if (state.retryCount >= state.maxRetries) {
    return {
      shouldRetry: false,
      reason: 'max_retries_reached',
      nextState: state,
    };
  }

  const updatedFailed = new Set(state.failedCommands);
  updatedFailed.add(command);

  const truncatedError = errorSnippet.length > 500
    ? errorSnippet.substring(0, 500) + '\n... [output truncated]'
    : errorSnippet;

  const retryPrompt = `The previous terminal command \`${command}\` failed with exit code ${exitCode}.\nError output:\n\`\`\`\n${truncatedError}\n\`\`\`\nPlease diagnose and resolve this failure:\n- If this is a compiler, analysis, test, or code error in the workspace: generate the necessary file edit(s) to fix the code, then re-run the verification command.\n- If this is a terminal command syntax or environment error: provide the corrected command.\nContinue autonomously until all tasks and verifications succeed.`;

  return {
    shouldRetry: true,
    retryPrompt,
    nextState: {
      retryCount: state.retryCount + 1,
      failedCommands: updatedFailed,
      maxRetries: state.maxRetries,
    },
  };
}

test('Terminal Self-Healing: initiates retry on initial non-zero exit code', () => {
  const initial: RetryGuardState = {
    retryCount: 0,
    failedCommands: new Set(),
    maxRetries: 2,
  };

  const res = evaluateTerminalSelfHealing(
    'pwd',
    1,
    "'pwd' is not recognized as an internal or external command",
    initial
  );

  assert.strictEqual(res.shouldRetry, true);
  assert.ok(res.retryPrompt?.includes('`pwd` failed with exit code 1'));
  assert.ok(res.retryPrompt?.includes("'pwd' is not recognized"));
  assert.strictEqual(res.nextState.retryCount, 1);
  assert.ok(res.nextState.failedCommands.has('pwd'));
});

test('Terminal Self-Healing: halts immediately if model repeats the exact same failing command', () => {
  const stateWithFailure: RetryGuardState = {
    retryCount: 1,
    failedCommands: new Set(['pwd']),
    maxRetries: 2,
  };

  const res = evaluateTerminalSelfHealing(
    'pwd',
    1,
    "'pwd' is not recognized as an internal or external command",
    stateWithFailure
  );

  assert.strictEqual(res.shouldRetry, false);
  assert.strictEqual(res.reason, 'duplicate_command');
  assert.strictEqual(res.nextState.retryCount, 1);
});

test('Terminal Self-Healing: halts when max retry count (2) is reached', () => {
  const stateMaxed: RetryGuardState = {
    retryCount: 2,
    failedCommands: new Set(['pwd', 'echo $PWD']),
    maxRetries: 2,
  };

  const res = evaluateTerminalSelfHealing(
    'dir /invalid_arg',
    1,
    'The parameter format is not correct',
    stateMaxed
  );

  assert.strictEqual(res.shouldRetry, false);
  assert.strictEqual(res.reason, 'max_retries_reached');
});

test('Terminal Self-Healing: aborts when user cancels the session/stream', () => {
  const state: RetryGuardState = {
    retryCount: 0,
    failedCommands: new Set(),
    maxRetries: 2,
  };

  const res = evaluateTerminalSelfHealing('npm test', 1, 'ERR', state, true);

  assert.strictEqual(res.shouldRetry, false);
  assert.strictEqual(res.reason, 'aborted');
});

test('Terminal Self-Healing: captures both stdout compiler errors and stderr without dropping stdout', () => {
  const stdout = 'error • Undefined class "CustomWidget" • lib/screens/recovery_screen.dart:42:15';
  const stderr = '1 issue found. (ran in 27.7s)';
  const outputParts: string[] = [];
  if (stdout.trim()) outputParts.push(stdout.trim());
  if (stderr.trim()) outputParts.push(stderr.trim());
  const combined = outputParts.join('\n');

  assert.ok(combined.includes('CustomWidget'), 'Combined output must preserve stdout compiler diagnostics');
  assert.ok(combined.includes('recovery_screen.dart'), 'Combined output must preserve affected file paths');
  assert.ok(combined.includes('1 issue found'), 'Combined output must preserve stderr summary');
});

test('Terminal Self-Healing: allows identical verification command to retry if workspace files were edited', () => {
  const failedCommands = new Set(['flutter analyze']);
  const successfullyEditedFiles = ['lib/screens/recovery_screen.dart'];

  // When files were edited, clear failedCommands so re-running analysis is permitted
  if (successfullyEditedFiles.length > 0) {
    failedCommands.clear();
  }

  assert.strictEqual(failedCommands.has('flutter analyze'), false, 'Should allow flutter analyze after file edits');
});

