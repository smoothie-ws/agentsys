'use strict';
const {spawn} = require('node:child_process');
const path = require('node:path');

// The real static launcher, with its own ephemeral port and no backend in the client process.
async function withClient(work, serverURL = 'http://127.0.0.1:1') {
  const child = spawn(process.execPath, ['bin/agentsys-client.js', '--port', '0', '--server', serverURL], {
    cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Client startup timed out: ' + output)), 10000);
      const read = chunk => {
        output += chunk;
        const match = /Listening on (http:\/\/\S+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Client exited (${code}): ${output}`)); });
    });
    await work({base});
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await stopped;
    }
  }
}
module.exports = {withClient};
