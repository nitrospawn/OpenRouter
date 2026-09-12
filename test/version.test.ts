import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { EXTENSION_VERSION } from '../src/version';

test('Version Consistency: EXTENSION_VERSION matches package.json version', () => {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);

  assert.strictEqual(
    EXTENSION_VERSION,
    pkg.version,
    `src/version.ts (${EXTENSION_VERSION}) must match package.json version (${pkg.version})`
  );
});
