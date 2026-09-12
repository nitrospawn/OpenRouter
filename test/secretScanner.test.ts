import { test } from 'node:test';
import * as assert from 'node:assert';
import { SecretScanner, calculateShannonEntropy } from '../src/privacy/secretScanner';
import { CommandRunner } from '../src/terminal/commandRunner';

test('SecretScanner: detects AWS Access Keys', () => {
  const awsKey = ['AKIA', 'IOSFODNN', '7EXAMPLE'].join('');
  const input = `deploy to aws with ${awsKey} credentials`;
  const res = SecretScanner.redact(input);
  assert.strictEqual(res.hasSecrets, true);
  assert.strictEqual(res.matches.length, 1);
  assert.strictEqual(res.matches[0].ruleName, 'AWS Access Key');
  assert.ok(res.sanitized.includes('AKIA***redacted***'));
  assert.ok(!res.sanitized.includes(awsKey));
});

test('SecretScanner: detects sk- general API key convention (OpenAI, Anthropic sk-ant-, OpenRouter)', () => {
  const fakeOpenAiKey = ['sk-', 'proj-', 'fakeKeyFixture1234567890'].join('');
  const input1 = `const openAiKey = "${fakeOpenAiKey}";`;
  const res1 = SecretScanner.redact(input1);
  assert.strictEqual(res1.hasSecrets, true);
  assert.ok(res1.sanitized.includes('sk-proj***redacted***'));

  const fakeAnthropicKey = ['sk-', 'ant-', 'api03-testFixture1234567890'].join('');
  const input2 = `anthropic_key: ${fakeAnthropicKey}`;
  const res2 = SecretScanner.redact(input2);
  assert.strictEqual(res2.hasSecrets, true);
  assert.ok(res2.sanitized.includes('sk-ant-***redacted***'));
});

test('SecretScanner: detects GitHub PAT and Slack tokens', () => {
  const fakeGhp = ['ghp_', 'mockFixture1234567890abcdef123456789'].join('');
  const fakeXoxb = ['xoxb-', '1234567890-', 'abcdef123456'].join('');
  const input = `tokens: ${fakeGhp} and ${fakeXoxb}`;
  const res = SecretScanner.redact(input);
  assert.strictEqual(res.hasSecrets, true);
  assert.strictEqual(res.matches.length, 2);
  assert.ok(res.sanitized.includes('ghp_***redacted***'));
  assert.ok(res.sanitized.includes('xox-***redacted***'));
});

test('SecretScanner: detects context-bound key assignments in .env formats', () => {
  const envContent = `
PORT=3000
DATABASE_URL=postgres://user:pass@localhost:5432/db
DB_PASSWORD="superSecretPassword987!"
API_KEY='k7s9f2p0x4m1q8w3v5z6'
`;
  const res = SecretScanner.redact(envContent);
  assert.strictEqual(res.hasSecrets, true);
  assert.ok(!res.sanitized.includes('superSecretPassword987!'));
  assert.ok(!res.sanitized.includes('k7s9f2p0x4m1q8w3v5z6'));
  assert.ok(res.sanitized.includes('[REDACTED:CREDENTIAL]'));
});

test('SecretScanner: preserves non-sensitive high-entropy strings without auth context (false-positive prevention)', () => {
  // Commit hash (40-hex SHA)
  const gitSha = 'commit 4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const resSha = SecretScanner.redact(gitSha);
  assert.strictEqual(resSha.hasSecrets, false);
  assert.strictEqual(resSha.sanitized, gitSha);

  // UUID
  const uuid = 'user id is 123e4567-e89b-12d3-a456-426614174000';
  const resUuid = SecretScanner.redact(uuid);
  assert.strictEqual(resUuid.hasSecrets, false);
  assert.strictEqual(resUuid.sanitized, uuid);

  // Normal code snippet with entropy
  const jsCode = 'const result = btoa("Hello World This is normal text");';
  const resCode = SecretScanner.redact(jsCode);
  assert.strictEqual(resCode.hasSecrets, false);
});

test('SecretScanner: does not redact benign identifiers or dictionary values even when assigned to secret-like variables', () => {
  const benignAssignments = [
    'const tokenType = "bearer_auth";',
    'const tokenStatus = "active_pending";',
    'const authTokenHeader = "Authorization";',
    'const secretQuestion = "maiden_name";',
    'const apiKeyFormat = "json_object";',
    'const passwordHashAlgo = "sha256_crypt";',
    'const token = "my_custom_token";',
    'const secret = "production";',
    'const password = "administrator";',
  ];

  for (const line of benignAssignments) {
    const res = SecretScanner.redact(line);
    assert.strictEqual(res.hasSecrets, false, `Expected line to remain untouched: ${line}`);
    assert.strictEqual(res.sanitized, line);
  }
});

test('SecretScanner: calculates Shannon entropy reliably', () => {
  const lowEntropy = 'aaaaaaaaaaaaaaaa';
  const highEntropy = '4k9#mP0!xL8$wQ2@';
  assert.ok(calculateShannonEntropy(lowEntropy) < 1.0);
  assert.ok(calculateShannonEntropy(highEntropy) >= 3.5);
});

test('SecretScanner: detects and masks multi-line PEM private keys', () => {
  const pem = [
    '-----' + 'BEGIN RSA PRIVATE KEY' + '-----',
    'MIIEowIBAAKCAQEA0Y1+exampleFakeKeyData1234567890',
    '-----' + 'END RSA PRIVATE KEY' + '-----',
  ].join('\n');
  const res = SecretScanner.redact(pem);
  assert.strictEqual(res.hasSecrets, true);
  assert.ok(res.sanitized.includes('[REDACTED_PRIVATE_KEY]'));
  assert.ok(!res.sanitized.includes('exampleFakeKeyData1234567890'));
});

test('CommandRunner: sanitizeCommandOutput redacts secrets from terminal output', () => {
  const fakeStripeKey = ['sk_live_', '1234567890abcdef1234567890'].join('');
  const cmdOutput = `export STRIPE_KEY=${fakeStripeKey}\nDone.`;
  const sanitized = CommandRunner.sanitizeCommandOutput(cmdOutput);
  assert.ok(!sanitized.includes(fakeStripeKey));
  assert.ok(sanitized.includes('REDACTED') || sanitized.includes('***redacted***'));
});
