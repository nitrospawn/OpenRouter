import test from 'node:test';
import assert from 'node:assert';
import { TerminalOutputTracker } from '../src/terminal/terminalOutputTracker';
import { SecretScanner } from '../src/privacy/secretScanner';
import * as vscode from 'vscode';

// Mock TerminalShellExecution
class MockTerminalShellExecution implements vscode.TerminalShellExecution {
  commandLine: vscode.TerminalShellExecutionCommandLine = { value: '', isTrusted: true, confidence: 0 };
  cwd: vscode.Uri | undefined;
  
  private _chunks: string[] = [];
  
  constructor(chunks: string[]) {
    this._chunks = chunks;
  }
  
  read(): AsyncIterable<string> {
    const chunks = this._chunks;
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            if (i < chunks.length) {
              return { value: chunks[i++], done: false };
            }
            return { value: undefined, done: true };
          }
        };
      }
    };
  }
}

test('TerminalOutputTracker: captures, sanitizes, and truncates correctly', async () => {
    // Inject a secret in the middle of a very long string
    const secret = ['sk-', 'proj-', 'fakeKeyFixture1234567890'].join('');
    const head = 'A'.repeat(1000); // 1000 chars, so secret is in the first 2000
    const tail = 'B'.repeat(11000); // long enough to force truncation
    const rawOutput = head + '\n' + secret + '\n' + tail;

    const mockExecution = new MockTerminalShellExecution([rawOutput]);
    
    // We can't await trackExecution easily because it detaches, so we call startReading directly for testing
    // To do this, we can just use the public method and wait a bit, or use any cast to call private method
    TerminalOutputTracker.trackExecution(mockExecution as any, 'test_cmd', '/');
    
    // Wait for async stream to process
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const formatted = TerminalOutputTracker.getRecentOutputsFormatted();
    console.log("FORMATTED 1:", formatted);
    
    // 1. Should be in the output
    assert.ok(formatted.includes('test_cmd'));
    
    // 2. Secret should be redacted
    assert.ok(!formatted.includes(secret), 'Secret was not redacted');
    assert.ok(formatted.includes('***redacted***'), 'Redaction placeholder missing');
    
    // 3. Output should be truncated (head 2000, tail 8000)
    assert.ok(formatted.includes('...[output truncated due to size]...'), 'Truncation message missing');
    
    // Because the string is > 10000, it should be truncated.
    // The secret was at index 3000, which is in the truncated middle part!
    // Wait, if it's truncated, the secret might be gone anyway.
    // Let's also test a secret in the head.
  });

  test('TerminalOutputTracker: redact runs BEFORE truncation', async () => {
    // Secret right at the 2000 character boundary
    const secret = ['sk-', 'proj-', 'fakeKeyFixture1234567890'].join('');
    // Let's put the secret at index 1990
    const head = 'A'.repeat(1990);
    const tail = 'B'.repeat(11000);
    const rawOutput = head + '\n' + secret + '\n' + tail; 

    const mockExecution = new MockTerminalShellExecution([rawOutput]);
    TerminalOutputTracker.trackExecution(mockExecution as any, 'test_cmd_boundary', '/');
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const formatted = TerminalOutputTracker.getRecentOutputsFormatted();
    
    // The secret should be redacted. If it was truncated first, the secret might be split into 'sk-ant-api' and the rest dropped, 
    // which would fail the redaction regex. Since we redact first, it will become [REDACTED].
    assert.ok(!formatted.includes(secret), 'Secret was not redacted');
    assert.ok(formatted.includes('***redacted***'), 'Redaction placeholder missing');
  });
