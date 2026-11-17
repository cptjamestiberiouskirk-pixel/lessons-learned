#!/usr/bin/env node
// Runs every check a release needs and prints what each one found.
// Read-only: it runs the tests, the validators and this repo's own --check,
// and compares files; it changes nothing.
//
//   node dev/release-check.mjs
//
// Exit 0 when every check passed, 1 when any failed. A check that can't run
// here (no claude on PATH) is reported as SKIPPED, and fails the run unless
// --allow-skip is given.

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
run('claude plugin validate (marketplace)', 'claude', ['plugin', 'validate', '.'], win);
run('claude plugin validate (plugin folder)', 'claude', ['plugin', 'validate', 'plugins/lessons-learned', '--profile', 'directory'], win);

for (const r of results) console.log(`${r.status.padEnd(7)} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIPPED').length;
console.log(`-- ${results.length} checks: ${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
if (skipped && !allowSkip) console.log('-- a skipped check fails the run; pass --allow-skip to accept it');
process.exit(failed || (skipped && !allowSkip) ? 1 : 0);
