const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function run() {
  const workTree = 'C:\\\\Users\\\\HP\\\\Videos\\\\Qubators\\\\MVP\\\\optest';
  // Check if we can run a dummy git checkout here? No, optest might not have shadow.git.
  console.log('workTree:', workTree);
}
run();
