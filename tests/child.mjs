// spawnSync for the tests, with a time limit. A child process that never exits
// would otherwise hold its test file until CI cancels the whole job, and the
// log would name no test: node --test prints a file's results only when the
// file ends. In PR 2's CI this cost one job its full 10 minutes.
//
// After 60 seconds the child is killed and the test fails with an error that
// names the command, how its input came, and what it printed by then. The
// slowest child in these tests takes about a second.
import {spawn as nodeSpawn, spawnSync as nodeSpawnSync} from 'node:child_process';
import {closeSync, mkdtempSync, openSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';

const LIMIT_MS = 60_000;
// An argument past 80 characters is cut: a path keeps its end, which names the
// file, and anything else keeps its start.
const cut = (a) => {
  const s = String(a);
  if (s.length <= 80) return s;
  return isAbsolute(s) ? `...${s.slice(-77)}` : `${s.slice(0, 80)}...`;
};
const named = (cmd, args) => [cmd, ...args].map(cut).join(' ');

// On macOS, spawnSync can write all of a large input to the child's pipe and
// never close it. The child then waits for the end of its input until it is
// killed. In CI this killed seven hook children in four runs, on Node 22 and
// 24, each sent from about 80 KB to 1.5 MB; Linux and Windows never did
// (RS-T-lint-macos-hang in dev/release-state.md). So on macOS the input goes
// to a file, and the child reads that file as its stdin: a file always ends.
// Elsewhere it still goes through a pipe, as Claude Code and Codex send a hook
// its payload. `stdinFile` sets it either way, for the tests of this.
const FILE_INPUT = process.platform === 'darwin';
let dir = null;
let files = 0;
process.on('exit', () => {
  if (dir) rmSync(dir, {recursive: true, force: true});
});

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

export function spawnSync(cmd, args = [], {stdinFile = FILE_INPUT, ...options} = {}) {
  const {input} = options;
  const bytes = input == null ? 0 : typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength;
  let file = null;
  let fd = null;
  let run = options;
  if (stdinFile && input != null && options.stdio === undefined) {
    dir ??= mkdtempSync(join(tmpdir(), 'child-input-'));
    file = join(dir, `${++files}`);
    writeFileSync(file, input);
    fd = openSync(file, 'r');
    run = {...options, input: undefined, stdio: [fd, 'pipe', 'pipe']};
  }
  let r;
  try {
    r = nodeSpawnSync(cmd, args, {timeout: LIMIT_MS, killSignal: 'SIGKILL', ...run});
  } finally {
    if (fd !== null) closeSync(fd);
    if (file !== null) rmSync(file, {force: true});
  }
  if (r.error?.code === 'ETIMEDOUT') {
    const how = input == null ? 'none' : `${bytes} bytes ${fd === null ? 'through a pipe' : 'from a file'}`;
    const printed = (s) => String(s ?? '').length;
    throw new Error(
      `a child process did not finish in ${(options.timeout ?? LIMIT_MS) / 1000} s and was killed: ${named(cmd, args)}. ` +
        `Its input: ${how}. It printed ${printed(r.stdout)} characters to stdout and ${printed(r.stderr)} to stderr.`,
    );
  }
  return r;
}
