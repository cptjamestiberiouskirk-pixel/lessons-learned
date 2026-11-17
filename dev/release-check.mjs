#!/usr/bin/env node
// Runs every check a release needs and prints what each one found.
// Read-only: it runs the tests, the validators and this repo's own --check,
// and compares files; it changes nothing in the repo. On Windows the Linux
// test run copies the repo's files into a temporary folder in WSL, and
// removes it afterwards.
//
//   node dev/release-check.mjs
//
// Exit 0 when every check passed, 1 when any failed. A check that can't run
// here (no claude on PATH, no WSL on Windows) is reported as SKIPPED, and
// fails the run unless --allow-skip is given.

import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const record = (name, status, detail = '') => results.push({name, status, detail});
const text = (p) => readFileSync(join(REPO, p), 'utf8');
const bytes = (p) => readFileSync(join(REPO, p));

const allowSkip = process.argv.includes('--allow-skip');

// shell: true runs the command through cmd on Windows, which finds an npm
// install's claude.cmd. Every command and argument here is fixed text.
function run(name, cmd, args, shell = false) {
  const r = spawnSync(cmd, args, {cwd: REPO, encoding: 'utf8', shell});
  const missing = (r.error && r.error.code === 'ENOENT') || (shell && /not recognized|not found/.test(r.stderr || '') && r.status !== 0);
  if (missing) return record(name, 'SKIPPED', `${cmd} not found`);
  const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/\r/g, '').trim().split('\n');
  record(name, r.status === 0 ? 'PASS' : 'FAIL', out.slice(-3).join(' | '));
}

// Versions: every place that names the release.
const claude = JSON.parse(text('plugins/lessons-learned/.claude-plugin/plugin.json'));
const codex = JSON.parse(text('plugins/lessons-learned-codex/.codex-plugin/plugin.json'));
const header = text('plugins/lessons-learned/templates/lessons.mjs').match(/lessons-learned plugin, version (\S+?)\.?$/m)?.[1];
const changelog = text('CHANGELOG.md').match(/^## (\S+)/m)?.[1];
const versions = {claude: claude.version, codex: codex.version, 'script header': header, 'CHANGELOG top': changelog};
const distinct = new Set(Object.values(versions));
record('versions agree', distinct.size === 1 ? 'PASS' : 'FAIL', Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(', '));

// Files the two copies and this repo's own script share.
const shared = ['LICENSE', 'templates/LESSONS.md', 'templates/PLAYBOOK.md', 'templates/lessons.mjs'];
const differ = shared.filter((f) => !bytes(`plugins/lessons-learned/${f}`).equals(bytes(`plugins/lessons-learned-codex/${f}`)));
if (!bytes('plugins/lessons-learned/templates/lessons.mjs').equals(bytes('dev/lessons.mjs'))) differ.push('dev/lessons.mjs');
if (!bytes('plugins/lessons-learned-codex/plugin.json').equals(bytes('plugins/lessons-learned-codex/.codex-plugin/plugin.json'))) differ.push('Codex plugin.json pair');
record('shared files identical', differ.length ? 'FAIL' : 'PASS', differ.length ? `differ: ${differ.join(', ')}` : `${shared.length + 2} pairs`);

run('node --test', process.execPath, ['--test']);
run('own LESSONS.md and PLAYBOOK.md', process.execPath, ['dev/lessons.mjs', '--check']);
const win = process.platform === 'win32';

// node --test on Linux. Inode reuse, case and heap use differ there, and in
// 0.2.1 two tests that passed on Windows failed on Linux (LESSONS.md,
// 2026-11-17). On Linux the run above covers it. On Windows it runs under WSL,
// from a copy of the working tree's files (tracked and untracked, not ignored)
// on WSL's own file system, which is removed afterwards.
function linuxTests() {
  const name = 'node --test on Linux';
  if (process.platform === 'linux') return record(name, 'PASS', 'this is Linux: the node --test run above covers it');
  if (!win) return record(name, 'SKIPPED', `no Linux to run it on here (${process.platform})`);
  const clean = (s) => (s || '').replace(/\0/g, '').replace(/\r/g, '');
  const where = spawnSync('wsl', ['-e', 'wslpath', '-a', '-u', REPO], {encoding: 'utf8'});
  if (where.error || where.status !== 0) return record(name, 'SKIPPED', `WSL not available: ${clean(where.stderr || where.error?.message).trim().split('\n')[0]}`);
  const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: REPO, encoding: 'utf8'});
  if (files.status !== 0) return record(name, 'FAIL', `git ls-files: ${clean(files.stderr).trim()}`);
  // The file list comes on stdin, one name per NUL. Nothing from the repo is
  // put into the script's text: the folder is its first argument.
  const script = [
    'set -e',
    'D=$(mktemp -d)',
    'trap \'rm -rf "$D"\' EXIT',
    'cd "$1"',
    'tar -cf - --null -T - | tar -xf - -C "$D"',
    'cd "$D"',
    'command -v node >/dev/null || { echo "no node in WSL"; exit 127; }',
    'echo "node $(node --version)"',
    'node --test',
  ].join('\n');
  const r = spawnSync('wsl', ['-e', 'sh', '-c', script, 'sh', clean(where.stdout).trim()], {input: files.stdout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  const out = clean(`${r.stdout}${r.stderr}`);
  if (r.status === 127) return record(name, 'SKIPPED', 'no node in WSL');
  const version = out.match(/^node (v\S+)/m)?.[1] ?? 'node ?';
  const count = (k) => out.match(new RegExp(`^(?:# |ℹ )${k} (\\d+)`, 'm'))?.[1] ?? '?';
  const failing = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]).slice(0, 3);
  record(name, r.status === 0 ? 'PASS' : 'FAIL',
    `WSL, ${version}: ${count('pass')} pass, ${count('fail')} fail, ${count('skipped')} skipped${failing.length ? `; failing: ${failing.join('; ')}` : ''}`);
}
linuxTests();
run('claude plugin validate (marketplace)', 'claude', ['plugin', 'validate', '.'], win);
run('claude plugin validate (plugin folder)', 'claude', ['plugin', 'validate', 'plugins/lessons-learned', '--profile', 'directory'], win);

for (const r of results) console.log(`${r.status.padEnd(7)} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIPPED').length;
console.log(`-- ${results.length} checks: ${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
if (skipped && !allowSkip) console.log('-- a skipped check fails the run; pass --allow-skip to accept it');
process.exit(failed || (skipped && !allowSkip) ? 1 : 0);
