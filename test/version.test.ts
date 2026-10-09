import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { EXTENSION_VERSION } from '../src/version';

test('Version Consistency: EXTENSION_VERSION matches package.json and version.md', () => {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);

  assert.strictEqual(
    EXTENSION_VERSION,
    pkg.version,
    `src/version.ts (${EXTENSION_VERSION}) must match package.json version (${pkg.version})`
  );
  assert.strictEqual(EXTENSION_VERSION, '0.5.1');

  const versionMdPath = path.resolve(__dirname, '../../version.md');
  const versionMd = fs.readFileSync(versionMdPath, 'utf8');
  assert.ok(
    versionMd.includes(`## [${EXTENSION_VERSION}]`),
    `version.md must include heading for ## [${EXTENSION_VERSION}]`
  );
});
