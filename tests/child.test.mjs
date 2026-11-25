// Tests for tests/child.mjs, the spawnSync and spawn that the other tests
// start their child processes with.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from './child.mjs';

// The child says whether its stdin is a file, and what it read there.
const REPORT = `const fs = require('node:fs');
const file = fs.fstatSync(0).isFile();
const b = fs.readFileSync(0);
process.stdout.write(JSON.stringify({file, n: b.length, sha: require('node:crypto').createHash('sha256').update(b).digest('hex')}));`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
// Past 1 MiB, the size of the lint hook test's payload that hung, with a
// character of two UTF-8 bytes and one of four at the end.
const BIG = `${'x'.repeat(1024 * 1024)}é\u{1f600}`;

// On macOS, seven hook children were killed at 60 s in CI, each sent a large
// input through spawnSync's pipe (RS-T-lint-macos-hang in dev/release-state.md).
// From a file, the input always ends.
test('spawnSync gives a child all of its input from a file when stdinFile is set, and the input ends', () => {
  const r = spawnSync(process.execPath, ['-e', REPORT], {input: BIG, encoding: 'utf8', stdinFile: true});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {file: true, n: Buffer.byteLength(BIG), sha: sha(BIG)});
});

test('spawnSync gives a child its input from a file on macOS, and through a pipe on other systems', () => {
  const r = spawnSync(process.execPath, ['-e', REPORT], {input: BIG, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {file: process.platform === 'darwin', n: Buffer.byteLength(BIG), sha: sha(BIG)});
});

test('a child killed at its time limit is named by its file, with how its input came and what it printed', () => {
  const hang = 'process.stdout.write("hi"); setInterval(() => {}, 1000);';
  // An argument past 80 characters: its end, which names the file, is kept.
  const long = join(tmpdir(), 'a'.repeat(100), 'the-hook.mjs');
  for (const [stdinFile, how] of [[true, 'from a file'], [false, 'through a pipe']]) {
    assert.throws(
      () => spawnSync(process.execPath, ['-e', hang, long], {input: 'abcde', encoding: 'utf8', timeout: 2000, stdinFile}),
      (e) => {
        assert.match(e.message, /did not finish in 2 s and was killed: /);
        assert.match(e.message, /\.\.\.[^ ]*the-hook\.mjs\./, e.message);
        assert.match(e.message, new RegExp(`Its input: 5 bytes ${how}\\. It printed 2 characters to stdout and 0 to stderr\\.`), e.message);
        return true;
      },
    );
  }
});
