import test from 'node:test';
import assert from 'node:assert';
import { isReadOnly, getInspectionDescription } from '../src/terminal/commandClassifier';
import { CommandRunner } from '../src/terminal/commandRunner';

test('CommandClassifier: classifies standard inspection commands as read-only', () => {
  // Windows CMD & PowerShell read commands
  assert.strictEqual(isReadOnly('type src/index.ts'), true);
  assert.strictEqual(isReadOnly('dir'), true);
  assert.strictEqual(isReadOnly('dir /s /b'), true);
  assert.strictEqual(isReadOnly('Get-Content ./package.json'), true);
  assert.strictEqual(isReadOnly('gc src/main.ts'), true);
  assert.strictEqual(isReadOnly('Get-ChildItem -Path src'), true);
  assert.strictEqual(isReadOnly('gci'), true);
  assert.strictEqual(isReadOnly('findstr /s /i "test" *.ts'), true);
  assert.strictEqual(isReadOnly('Select-String -Path "*.ts" -Pattern "test"'), true);
  assert.strictEqual(isReadOnly('where node'), true);
  assert.strictEqual(isReadOnly('where.exe npm'), true);

  // POSIX inspection commands
  assert.strictEqual(isReadOnly('cat package.json'), true);
  assert.strictEqual(isReadOnly('ls'), true);
  assert.strictEqual(isReadOnly('ls -la src/'), true);
  assert.strictEqual(isReadOnly('grep -rn "TODO" .'), true);
  assert.strictEqual(isReadOnly('find . -name "*.json"'), true);
  assert.strictEqual(isReadOnly('head -n 20 file.txt'), true);
  assert.strictEqual(isReadOnly('tail -f log.txt'), true);
  assert.strictEqual(isReadOnly('wc -l src/index.ts'), true);
  assert.strictEqual(isReadOnly('which git'), true);
  assert.strictEqual(isReadOnly('pwd'), true);
  assert.strictEqual(isReadOnly('echo "checking status"'), true);
  assert.strictEqual(isReadOnly('git status'), true);
  assert.strictEqual(isReadOnly('git diff'), true);
  assert.strictEqual(isReadOnly('git log -n 5'), true);
});

test('CommandClassifier: classifies mutating and side-effecting commands as Tier 2 (NOT read-only)', () => {
  assert.strictEqual(isReadOnly('npm install'), false);
  assert.strictEqual(isReadOnly('npm run build'), false);
  assert.strictEqual(isReadOnly('npm test'), false);
  assert.strictEqual(isReadOnly('yarn add lodash'), false);
  assert.strictEqual(isReadOnly('pnpm install'), false);
  assert.strictEqual(isReadOnly('pip install requests'), false);
  assert.strictEqual(isReadOnly('git commit -m "update"'), false);
  assert.strictEqual(isReadOnly('git push origin main'), false);
  assert.strictEqual(isReadOnly('rm -rf dist'), false);
  assert.strictEqual(isReadOnly('del /f /q test.txt'), false);
  assert.strictEqual(isReadOnly('mkdir new_folder'), false);
});

test('CommandClassifier Redirection Safety: commands that write to files via > or >> are NEVER read-only', () => {
  assert.strictEqual(isReadOnly('echo "secret" > .env'), false);
  assert.strictEqual(isReadOnly('echo "more" >> log.txt'), false);
  assert.strictEqual(isReadOnly('type file1.txt > file2.txt'), false);
  assert.strictEqual(isReadOnly('dir /s > listing.txt'), false);
  assert.strictEqual(isReadOnly('cat file.txt > copy.txt'), false);
  assert.strictEqual(isReadOnly('Get-Content a.txt | Out-File b.txt'), false);
  assert.strictEqual(isReadOnly('Get-ChildItem | Set-Content list.txt'), false);
});

test('CommandClassifier Chaining Safety: chained commands with any mutating part are NOT read-only', () => {
  assert.strictEqual(isReadOnly('cat file.txt && rm file.txt'), false);
  assert.strictEqual(isReadOnly('dir ; npm run build'), false);
  assert.strictEqual(isReadOnly('type index.ts && echo "done" > ok.txt'), false);
  assert.strictEqual(isReadOnly('cat package.json | sh'), false);

  // Purely read-only chains are read-only
  assert.strictEqual(isReadOnly('cat package.json | grep name'), true);
  assert.strictEqual(isReadOnly('dir | findstr ts'), true);
});

test('CommandRunner exposes isReadOnly and getInspectionDescription', () => {
  assert.strictEqual(CommandRunner.isReadOnly('type src/main.ts'), true);
  assert.strictEqual(CommandRunner.isReadOnly('npm install'), false);
  assert.strictEqual(CommandRunner.getInspectionDescription('type "src/main.ts"'), 'Reading file: main.ts');
  assert.strictEqual(CommandRunner.getInspectionDescription('dir'), 'Inspecting directory');
  assert.strictEqual(CommandRunner.getInspectionDescription('grep -rn "foo"'), 'Searching workspace');
});
