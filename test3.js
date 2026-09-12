const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
async function run() {
  try {
    await execFileAsync('git', ['checkout', 'HEAD', '--', 'dir\\\\file.txt'], { cwd: 'C:\\\\Users\\\\HP\\\\Videos\\\\Qubators\\\\MVP\\\\Openrouter code\\\\temp_dummy' });
    console.log('Success!');
  } catch(e) {
    console.log('Failed:', e.message);
  }
}
run();
