// spawnSync for the tests, with a time limit. A child process that never exits
// would otherwise hold its test file until CI cancels the whole job, and the
// log would name no test: node --test prints a file's results only when the
// file ends. In PR 2's CI this cost one job its full 10 minutes.
//
// After 60 seconds the child is killed and the test fails with an error that
// names the command. The slowest child in these tests takes about a second.
import {spawn as nodeSpawn, spawnSync as nodeSpawnSync} from 'node:child_process';

const LIMIT_MS = 60_000;
const named = (cmd, args) => [cmd, ...args].map((a) => (String(a).length > 80 ? `${String(a).slice(0, 80)}...` : a)).join(' ');

// spawn, for a test that must act while the child runs. `done` resolves with
// {status, stdout} when it exits; after 60 seconds the child is killed and
// `done` rejects with an error that names the command. The close listener is
// attached at once, so a child that exits early is never missed.
export function spawn(cmd, args = [], options = {}) {
  const child = nodeSpawn(cmd, args, {stdio: ['pipe', 'pipe', 'pipe'], ...options});
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  const done = new Promise((resolve, reject) => {
    const limit = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`a child process did not finish in ${LIMIT_MS / 1000} s and was killed: ${named(cmd, args)}`));
    }, LIMIT_MS);
    child.on('close', (status) => {
      clearTimeout(limit);
      resolve({status, stdout});
    });
  });
  return {child, done};
}

export function spawnSync(cmd, args = [], options = {}) {
  const r = nodeSpawnSync(cmd, args, {timeout: LIMIT_MS, killSignal: 'SIGKILL', ...options});
  if (r.error?.code === 'ETIMEDOUT') {
    throw new Error(`a child process did not finish in ${(options.timeout ?? LIMIT_MS) / 1000} s and was killed: ${named(cmd, args)}`);
  }
  return r;
}
