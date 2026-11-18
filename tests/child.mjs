// spawnSync for the tests, with a time limit. A child process that never exits
// would otherwise hold its test file until CI cancels the whole job, and the
// log would name no test: node --test prints a file's results only when the
// file ends. In PR 2's CI this cost one job its full 10 minutes.
//
// After 60 seconds the child is killed and the test fails with an error that
// names the command. The slowest child in these tests takes about a second.
import {spawnSync as nodeSpawnSync} from 'node:child_process';

const LIMIT_MS = 60_000;

export function spawnSync(cmd, args = [], options = {}) {
  const r = nodeSpawnSync(cmd, args, {timeout: LIMIT_MS, killSignal: 'SIGKILL', ...options});
  if (r.error?.code === 'ETIMEDOUT') {
    const shown = [cmd, ...args].map((a) => (String(a).length > 80 ? `${String(a).slice(0, 80)}...` : a)).join(' ');
    throw new Error(`a child process did not finish in ${(options.timeout ?? LIMIT_MS) / 1000} s and was killed: ${shown}`);
  }
  return r;
}
