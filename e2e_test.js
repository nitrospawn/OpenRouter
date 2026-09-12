const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function run() {
  const workTree = 'C:\\\\Users\\\\HP\\\\Videos\\\\Qubators\\\\MVP\\\\optest';
  const gitDir = path.join(workTree, '.test-shadow.git');
  
  if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true });
  fs.mkdirSync(gitDir, { recursive: true });
  await execFileAsync('git', ['--git-dir', gitDir, '--work-tree', workTree, 'init']);
  await execFileAsync('git', ['--git-dir', gitDir, '--work-tree', workTree, 'config', 'user.name', 'test']);
  await execFileAsync('git', ['--git-dir', gitDir, '--work-tree', workTree, 'config', 'user.email', 't@t.com']);

  const targetFile = 'trust\\\\ty2.py'; // using backslash as it might be from workspace.asRelativePath
  const targetFileForward = 'trust/ty2.py'; // using forward slash as it might be from the LLM
  const absPath = path.join(workTree, targetFileForward);
  
  // 1. Write original
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, 'print("original")\\n');
  
  // 2. Checkpoint
  try {
    await execFileAsync('git', ['--git-dir', gitDir, '--work-tree', workTree, 'add', '--', targetFileForward]);
    await execFileAsync('git', ['--git-dir', gitDir, '--work-tree', workTree, 'commit', '-m', 'chkpt', '--allow-empty']);
  } catch (e) {
    console.error('Failed to add/commit:', e.message);
  }
  const revParse = await execFileAsync('git', ['--git-dir', gitDir, '--work-tree', workTree, 'rev-parse', 'HEAD']);
  const cpId = revParse.stdout.trim();
  
  // 3. Edit file (simulating user saved edit)
  fs.writeFileSync(absPath, 'print("edited")\\n');
  
  // 4. Restore
  try {
    await execFileAsync('git', ['--git-dir', gitDir, '--work-tree', workTree, 'checkout', cpId, '--', targetFileForward]);
  } catch (e) {
    console.error('Failed to checkout:', e.message);
  }
  
  const finalContent = fs.readFileSync(absPath, 'utf8');
  console.log('Final content after restore:', finalContent.trim());
}
run();
