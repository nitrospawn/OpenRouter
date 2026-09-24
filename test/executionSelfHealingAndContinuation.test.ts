import { test, describe } from 'node:test';
import * as assert from 'node:assert';

describe('Execution Continuity & Self-Healing Engine', () => {
  // 1. Extended fileActionRegex Test
  const fileActionRegex = /(?:```|````)(?:create_file|edit_file|file|create|edit|patch|(?!plan|walkthrough)[a-zA-Z0-9_-]+):([^\r\n]+)\r?\n((?:[\s\S]*?<<<< SEARCH[\s\S]*?\n>>>>[^\r\n]*|[\s\S]*?))\r?\n(?:```|````)/gi;

  function parseMatches(text: string): Array<{ tag: string; filePath: string }> {
    const results: Array<{ tag: string; filePath: string }> = [];
    const re = new RegExp(fileActionRegex.source, fileActionRegex.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      let filePath = match[1].trim();
      if (!filePath.includes('.') && !filePath.includes('/') && !filePath.includes('\\')) {
        continue;
      }
      results.push({ tag: match[0], filePath });
    }
    return results;
  }

  test('fileActionRegex: matches standard create_file and edit_file tags', () => {
    const text = '```edit_file:lib/media/media_repository.dart\n<<<< SEARCH\nfoo\n====\nbar\n>>>>\n```';
    const matches = parseMatches(text);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].filePath, 'lib/media/media_repository.dart');
  });

  test('fileActionRegex: matches shorthand edit: and create: tags', () => {
    const text1 = '```edit:lib/dev_flags.dart\n<<<< SEARCH\nfoo\n====\nbar\n>>>>\n```';
    const matches1 = parseMatches(text1);
    assert.strictEqual(matches1.length, 1);
    assert.strictEqual(matches1[0].filePath, 'lib/dev_flags.dart');

    const text2 = '```create:lib/utils.dart\nvoid test() {}\n```';
    const matches2 = parseMatches(text2);
    assert.strictEqual(matches2.length, 1);
    assert.strictEqual(matches2[0].filePath, 'lib/utils.dart');
  });

  test('fileActionRegex: matches language-prefixed tags (e.g. dart:path, ts:path)', () => {
    const text = '```dart:lib/media/media_repository.dart\n<<<< SEARCH\nfetchMedia()\n====\nfetchMediaAsync()\n>>>>\n```';
    const matches = parseMatches(text);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].filePath, 'lib/media/media_repository.dart');
  });

  test('fileActionRegex: ignores plain language blocks, plan, and walkthrough blocks', () => {
    const text = `
\`\`\`dart
void main() {}
\`\`\`

\`\`\`plan:my_plan
# Implementation Plan
\`\`\`

\`\`\`walkthrough:results
# Walkthrough
\`\`\`
`;
    const matches = parseMatches(text);
    assert.strictEqual(matches.length, 0);
  });

  // 2. Permission Evaluation with allow_session
  function isActionAllowed(permState: string): boolean {
    return permState === 'allow' || permState === 'allow_session';
  }

  test('Permissions: allow_session is evaluated as allowed for both edits and terminal', () => {
    assert.strictEqual(isActionAllowed('allow'), true);
    assert.strictEqual(isActionAllowed('allow_session'), true);
    assert.strictEqual(isActionAllowed('ask'), false);
    assert.strictEqual(isActionAllowed('deny'), false);
  });

  // 3. File Edit Self-Healing Retry
  interface EditRetryState {
    retryCount: number;
    maxRetries: number;
  }

  function evaluateFileEditSelfHealing(
    relativePath: string,
    error: string,
    currentFileContent: string,
    state: EditRetryState,
    isAborted: boolean = false
  ): {
    shouldRetry: boolean;
    retryPrompt?: string;
    nextState: EditRetryState;
  } {
    if (isAborted || state.retryCount >= state.maxRetries) {
      return {
        shouldRetry: false,
        nextState: state,
      };
    }

    const truncated = currentFileContent.length > 5000
      ? currentFileContent.slice(0, 5000) + '\n... [truncated]'
      : currentFileContent;

    const retryPrompt = `The proposed edit to \`${relativePath}\` could not be applied.\nReason: ${error}\n\nHere is the current content of \`${relativePath}\`:\n\`\`\`\n${truncated}\n\`\`\`\n\nPlease output a corrected \`\`\`edit_file:${relativePath} block where the <<<< SEARCH block matches the lines from the file above exactly. Continue executing until all tasks and verifications succeed.`;

    return {
      shouldRetry: true,
      retryPrompt,
      nextState: {
        retryCount: state.retryCount + 1,
        maxRetries: state.maxRetries,
      },
    };
  }

  test('File Edit Self-Healing: initiates retry with real file content on SEARCH block failure', () => {
    const state = { retryCount: 0, maxRetries: 5 };
    const res = evaluateFileEditSelfHealing(
      'lib/media/media_repository.dart',
      'SEARCH block not found in file',
      'class MediaRepository {\n  void fetchMedia() {}\n}',
      state
    );

    assert.strictEqual(res.shouldRetry, true);
    assert.strictEqual(res.nextState.retryCount, 1);
    assert.ok(res.retryPrompt?.includes('SEARCH block not found in file'));
    assert.ok(res.retryPrompt?.includes('class MediaRepository'));
  });

  test('File Edit Self-Healing: halts when max retry count is reached', () => {
    const state = { retryCount: 5, maxRetries: 5 };
    const res = evaluateFileEditSelfHealing(
      'lib/media/media_repository.dart',
      'SEARCH block not found in file',
      'content',
      state
    );

    assert.strictEqual(res.shouldRetry, false);
  });

  // 4. Multi-Step Continuation Independent of Terminal Permissions
  function evaluateFileEditContinuation(
    successfullyEditedFiles: string[],
    successfulCommands: string[],
    hasWalkthrough: boolean,
    terminalPermission: string,
    autoTurns: number,
    maxAutoFollowups: number = 10
  ): { shouldContinue: boolean; prompt?: string } {
    // Independent of terminalPermission!
    if (
      successfulCommands.length === 0 &&
      successfullyEditedFiles.length > 0 &&
      !hasWalkthrough &&
      autoTurns < maxAutoFollowups
    ) {
      return {
        shouldContinue: true,
        prompt: `Applied the following edit(s) successfully:\n${successfullyEditedFiles.map((f) => `- \`${f}\``).join('\n')}\n\nPlease proceed directly with the next step in the implementation plan without pausing for confirmation, or provide the final walkthrough if all implementation and verification steps are complete.`,
      };
    }
    return { shouldContinue: false };
  }

  test('Multi-Step Continuation: triggers even when terminal permission is "ask"', () => {
    const res = evaluateFileEditContinuation(
      ['lib/media/media_repository.dart'],
      [],
      false,
      'ask', // Terminal is "ask", but file continuation MUST trigger!
      0
    );

    assert.strictEqual(res.shouldContinue, true);
    assert.ok(res.prompt?.includes('Applied the following edit(s) successfully'));
  });

  test('Multi-Step Continuation: stops when walkthrough document is already emitted', () => {
    const res = evaluateFileEditContinuation(
      ['lib/media/media_repository.dart'],
      [],
      true, // Final walkthrough is present!
      'allow',
      0
    );

    assert.strictEqual(res.shouldContinue, false);
  });

  // 5. Autonomous Conversational Stall Recovery
  function evaluateStallRecovery(
    isAutoFollowUp: boolean,
    editedFilesCount: number,
    commandsCount: number,
    failedEditsCount: number,
    hasWalkthrough: boolean,
    autoTurns: number,
    maxTurns: number = 10
  ): { isStalled: boolean; prompt?: string } {
    if (
      isAutoFollowUp &&
      editedFilesCount === 0 &&
      commandsCount === 0 &&
      failedEditsCount === 0 &&
      !hasWalkthrough &&
      autoTurns < maxTurns
    ) {
      return {
        isStalled: true,
        prompt: `Please proceed directly with the implementation without pausing for confirmation. Emit the required file edits (\`\`\`edit_file:<path>) or terminal commands for the next step, or provide the final \`\`\`walkthrough block if all implementation and verification steps are complete.`,
      };
    }
    return { isStalled: false };
  }

  test('Stall Recovery: triggers continuation when model only chats mid-execution without actions or walkthrough', () => {
    const res = evaluateStallRecovery(
      true, // In autonomous execution
      0, // No edits emitted
      0, // No commands emitted
      0, // No edit failures
      false, // No walkthrough
      1
    );

    assert.strictEqual(res.isStalled, true);
    assert.ok(res.prompt?.includes('Please proceed directly with the implementation without pausing for confirmation'));
  });

  test('Stall Recovery: does not trigger when task concluded with walkthrough', () => {
    const res = evaluateStallRecovery(
      true,
      0,
      0,
      0,
      true, // Completed
      1
    );

    assert.strictEqual(res.isStalled, false);
  });

  // 6. Broadened Execution Intent Regex
  const isExecutionIntentRegex = /^(?:proceed(?: with (?:the )?plan)?|continue(?: with (?:the )?plan)?|please continue|implement(?: the plan)?|execute(?: the plan)?|go ahead(?: and (?:proceed|execute|implement))?|carry on|start(?: (?:the )?plan)?|do it|approved?|apply (?:the )?plan|yes(?: please)?(?:,? (?:proceed|continue|go ahead|do it))?|ok(?:,? (?:proceed|continue|go ahead|do it))?)[.! ]*$/i;

  test('Execution Intent: matches varied user approval phrases', () => {
    const validIntents = [
      'proceed',
      'Proceed with the plan',
      'continue',
      'please continue',
      'carry on',
      'start',
      'do it',
      'approved',
      'go ahead',
      'yes',
      'yes please',
      'yes, proceed',
      'ok',
      'ok, continue',
      'execute the plan',
      'apply the plan',
    ];

    for (const phrase of validIntents) {
      assert.strictEqual(isExecutionIntentRegex.test(phrase.trim()), true, `Failed to match: "${phrase}"`);
    }

    const nonIntents = [
      'what do you think?',
      'how does this work',
      'can we change the database?',
      'what is the weather today',
    ];

    for (const phrase of nonIntents) {
      assert.strictEqual(isExecutionIntentRegex.test(phrase.trim()), false, `Incorrectly matched non-intent: "${phrase}"`);
    }
  });

  // 7. Non-Blocking File Edits During Plan Execution
  function shouldAutoApplyEdits(
    applyEditPerm: 'allow' | 'allow_session' | 'ask' | 'deny',
    isExecutionActive: boolean,
    activePlanExists: boolean
  ): boolean {
    if (applyEditPerm === 'deny') return false;
    const isApplyEditAllowed = applyEditPerm === 'allow' || applyEditPerm === 'allow_session';
    const isAutoApplyDuringPlan = applyEditPerm === 'ask' && (isExecutionActive || activePlanExists);
    return isApplyEditAllowed || isAutoApplyDuringPlan;
  }

  test('Non-Blocking Edits: auto-applies under "ask" during active plan execution', () => {
    // Under general ask without active plan -> does not auto-apply
    assert.strictEqual(shouldAutoApplyEdits('ask', false, false), false);

    // Under ask with active execution or plan -> auto-applies non-blocking with checkpoints
    assert.strictEqual(shouldAutoApplyEdits('ask', true, false), true);
    assert.strictEqual(shouldAutoApplyEdits('ask', false, true), true);
    assert.strictEqual(shouldAutoApplyEdits('ask', true, true), true);

    // Under deny -> never auto-applies even during plan
    assert.strictEqual(shouldAutoApplyEdits('deny', true, true), false);

    // Under allow -> always auto-applies
    assert.strictEqual(shouldAutoApplyEdits('allow', false, false), true);
    assert.strictEqual(shouldAutoApplyEdits('allow_session', false, false), true);
  });

  // 8. Auto-Resume on Upstream Token Limit Cutoff (finish_reason === 'length')
  function evaluateTokenCutoffResume(
    finishReason: string | undefined,
    isExecActive: boolean,
    hasAutoTriggered: boolean,
    autoTurns: number,
    maxTurns: number = 5
  ): { shouldResume: boolean; prompt?: string } {
    if (!hasAutoTriggered && finishReason === 'length' && isExecActive && autoTurns < maxTurns) {
      return {
        shouldResume: true,
        prompt: 'Your previous response reached the maximum output token limit and was cut off mid-generation. Please continue directly from the exact point where you stopped, completing all remaining planned modifications, tasks, and verifications.',
      };
    }
    return { shouldResume: false };
  }

  test('Token Cutoff Resume: auto-resumes when finish_reason is "length" during execution', () => {
    const res = evaluateTokenCutoffResume('length', true, false, 0);
    assert.strictEqual(res.shouldResume, true);
    assert.ok(res.prompt?.includes('reached the maximum output token limit and was cut off'));

    // Does not resume if finish_reason was normal 'stop'
    const normalStop = evaluateTokenCutoffResume('stop', true, false, 0);
    assert.strictEqual(normalStop.shouldResume, false);

    // Does not resume if auto-followup already triggered
    const alreadyHandled = evaluateTokenCutoffResume('length', true, true, 0);
    assert.strictEqual(alreadyHandled.shouldResume, false);
  });
});

