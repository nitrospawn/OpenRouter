import { test, describe } from 'node:test';
import * as assert from 'node:assert';

describe('Collapsible Terminal Responses & Model Auto-Continuation', () => {
  // 1. Terminal Card Identification
  function isTerminalCard(content: string): boolean {
    return (
      content.startsWith('✓ **Ran in terminal:**') ||
      content.startsWith('Ran in terminal:') ||
      content.includes('**Ran in terminal:**')
    );
  }

  // 2. Terminal Output Parsing and Collapse Structure
  interface ParsedTerminalCard {
    commandLine: string;
    outputSnippet?: string;
    lineCount: number;
  }

  function parseTerminalCard(content: string): ParsedTerminalCard {
    const codeFenceMatch = content.match(/```(?:\w+)?\r?\n([\s\S]*?)```/);
    let outputSnippet: string | undefined;
    let lineCount = 0;

    if (codeFenceMatch) {
      outputSnippet = codeFenceMatch[1];
      const lines = outputSnippet.split(/\r?\n/).filter((l) => l.trim().length > 0);
      lineCount = lines.length;
    }

    const commandLine = content.split('\n')[0].replace(/\*\*/g, '').trim();

    return {
      commandLine,
      outputSnippet,
      lineCount,
    };
  }

  // 3. Auto-continuation Decision & Formatting Engine
  interface AutoContinuationEvaluation {
    shouldContinue: boolean;
    reason?: 'no_successful_commands' | 'aborted' | 'max_turns_reached';
    continuationPrompt?: string;
    nextTurnCount: number;
    messageRecord?: {
      role: 'system';
      isAutoFollowUp: boolean;
      content: string;
    };
  }

  const MAX_AUTO_FOLLOWUPS = 2;

  function evaluateAutoContinuation(
    successfulCommands: Array<{ command: string; output: string }>,
    currentAutoTurns: number,
    isAborted: boolean = false
  ): AutoContinuationEvaluation {
    if (isAborted) {
      return {
        shouldContinue: false,
        reason: 'aborted',
        nextTurnCount: currentAutoTurns,
      };
    }

    if (!successfulCommands || successfulCommands.length === 0) {
      return {
        shouldContinue: false,
        reason: 'no_successful_commands',
        nextTurnCount: currentAutoTurns,
      };
    }

    if (currentAutoTurns >= MAX_AUTO_FOLLOWUPS) {
      return {
        shouldContinue: false,
        reason: 'max_turns_reached',
        nextTurnCount: currentAutoTurns,
      };
    }

    let prompt = `The following terminal command(s) executed successfully in the user's workspace:\n\n`;
    for (const item of successfulCommands) {
      const out = item.output.length > 3000
        ? item.output.substring(0, 3000) + '\n... [output truncated]'
        : item.output || '(No output produced)';
      prompt += `Command: \`${item.command}\`\nOutput:\n\`\`\`\n${out}\n\`\`\`\n\n`;
    }
    prompt += `Based on the terminal command results above, please complete your response to the user's inquiry.`;

    return {
      shouldContinue: true,
      continuationPrompt: prompt,
      nextTurnCount: currentAutoTurns + 1,
      messageRecord: {
        role: 'system',
        isAutoFollowUp: true,
        content: prompt,
      },
    };
  }

  test('Terminal Card Detection: identifies terminal cards vs standard markdown messages', () => {
    assert.strictEqual(isTerminalCard('✓ **Ran in terminal:** `type Docs\\PRD.md` (completed, exit code: 0)'), true);
    assert.strictEqual(isTerminalCard('Ran in terminal: echo hello'), true);
    assert.strictEqual(isTerminalCard('Let me check the PRD document to answer your question.'), false);
    assert.strictEqual(isTerminalCard('```bash\ntype Docs\\PRD.md\n```'), false);
  });

  test('Collapsible Terminal Output: extracts snippet and computes line counts for header display', () => {
    const termMsg = `✓ **Ran in terminal:** \`type Docs\\PRD.md\` (completed, exit code: 0)
\`\`\`
# PRD — Flutter Notes & Tasks App (v3.0)

## 1. Overview
**Product:** A local-first, cross-platform notes and tasks manager for Android, iOS, Windows, macOS, Linux, and the web.
\`\`\``;

    const parsed = parseTerminalCard(termMsg);
    assert.ok(parsed.commandLine.includes('Ran in terminal:'));
    assert.ok(parsed.outputSnippet?.includes('Flutter Notes & Tasks App'));
    assert.strictEqual(parsed.lineCount, 3);
  });

  test('Terminal Auto-Continuation: triggers continuation turn when commands succeed', () => {
    const successList = [
      {
        command: 'type Docs\\PRD.md',
        output: '# PRD — Flutter Notes & Tasks App (v3.0)\n**Product:** A local-first, cross-platform notes and tasks manager for Android, iOS, Windows, macOS, Linux, and the web.',
      },
    ];

    const result = evaluateAutoContinuation(successList, 0, false);
    assert.strictEqual(result.shouldContinue, true);
    assert.strictEqual(result.nextTurnCount, 1);
    assert.ok(result.continuationPrompt?.includes('type Docs\\PRD.md'));
    assert.ok(result.continuationPrompt?.includes('Flutter Notes & Tasks App'));
    assert.ok(result.continuationPrompt?.includes("Based on the terminal command results above, please complete your response to the user's inquiry."));

    // Verify role safety and auto-follow-up flag
    assert.strictEqual(result.messageRecord?.role, 'system');
    assert.strictEqual(result.messageRecord?.isAutoFollowUp, true);
  });

  test('Terminal Auto-Continuation: halts when max follow-up limit (2) is reached', () => {
    const successList = [{ command: 'git status', output: 'On branch main' }];

    const result = evaluateAutoContinuation(successList, 2, false);
    assert.strictEqual(result.shouldContinue, false);
    assert.strictEqual(result.reason, 'max_turns_reached');
  });

  test('Terminal Auto-Continuation: aborts immediately if user cancelled the session', () => {
    const successList = [{ command: 'dir', output: 'Directory of C:\\' }];

    const result = evaluateAutoContinuation(successList, 0, true);
    assert.strictEqual(result.shouldContinue, false);
    assert.strictEqual(result.reason, 'aborted');
  });

  test('History Filtering: filters out isAutoFollowUp from UI messages while retaining assistant answer', () => {
    const mockSessionMessages = [
      {
        id: 'msg-1',
        role: 'user',
        content: 'in the prd is ths app an android or iso or desktop app',
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: 'Let me check the PRD document to answer your question.\n```cmd\ntype Docs\\PRD.md\n```',
      },
      {
        id: 'msg-3',
        role: 'system',
        content: '✓ **Ran in terminal:** `type Docs\\PRD.md` (completed, exit code: 0)\n```\n# PRD — Flutter Notes & Tasks App (v3.0)\n```',
      },
      {
        id: 'msg-4',
        role: 'system',
        isAutoFollowUp: true,
        content: 'The following terminal command(s) executed successfully...',
      },
      {
        id: 'msg-5',
        role: 'assistant',
        content: 'Based on the PRD document, the app is a cross-platform notes and tasks manager supporting Android, iOS, Windows, macOS, Linux, and the web.',
      },
    ];

    const uiMessages = mockSessionMessages.filter((m: any) => !m.isAutoFollowUp);

    assert.strictEqual(uiMessages.length, 4);
    assert.strictEqual(uiMessages.some((m) => (m as any).id === 'msg-4'), false, 'Auto-followup prompt must not be rendered');
    assert.strictEqual(uiMessages[0].role, 'user');
    assert.strictEqual(uiMessages[1].role, 'assistant');
    assert.strictEqual(uiMessages[2].role, 'system');
    assert.strictEqual(uiMessages[3].role, 'assistant');
    assert.ok(uiMessages[3].content.includes('cross-platform notes and tasks manager'));
  });
});
