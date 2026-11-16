// Tests for templates/lessons.mjs, run against the plugin's own templates and
// against logs built in a temp folder. Run with: node --test
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins/lessons-learned/templates');
const SCRIPT = join(TEMPLATES, 'lessons.mjs');
const LESSONS = readFileSync(join(TEMPLATES, 'LESSONS.md'), 'utf8');
const PLAYBOOK = readFileSync(join(TEMPLATES, 'PLAYBOOK.md'), 'utf8');

const folders = [];
after(() => folders.forEach((f) => rmSync(f, {recursive: true, force: true})));

function run(args, {lessons = LESSONS, playbook = PLAYBOOK} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-test-'));
  folders.push(dir);
  writeFileSync(join(dir, 'LESSONS.md'), lessons);
  writeFileSync(join(dir, 'PLAYBOOK.md'), playbook);
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir, ...args], {encoding: 'utf8'});
  return {code: r.status, out: r.stdout + r.stderr};
}

function entry(date, title, {why = 'a cause', rule = 'a rule', status = 'open'} = {}) {
  const fields = [`- What went wrong: ${title} broke`];
  if (why !== null) fields.push(`- Why: ${why}`);
  fields.push(`- Rule going forward: ${rule}`, '- Evidence: a test', `- Status: ${status}`);
  return `\n## ${date}: ${title}\n${fields.join('\n')}\n`;
}

const SECTION = '\n## Changing saved state\n\nFrom: 2026-01-01 "Saved state was lost"\n\n1. Edit every writer and reader.\n';

test('the fingerprint in the setup skill matches the shipped script', () => {
  const skill = readFileSync(join(TEMPLATES, '../skills/setup/SKILL.md'), 'utf8');
  const named = skill.match(/This plugin's version prints `([0-9a-f]{64})`/);
  assert.ok(named, 'SKILL.md names no fingerprint in the form the test expects');
  const actual = createHash('sha256').update(readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(named[1], actual, 'templates/lessons.mjs changed: update its fingerprint in SKILL.md, "The script\'s fingerprint"');
});

test("this repo's own dev/lessons.mjs is the same text as the template", () => {
  const own = readFileSync(resolve(TEMPLATES, '../../../dev/lessons.mjs'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(own, readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n'), 'copy templates/lessons.mjs to dev/lessons.mjs');
});

test("this repo's own LESSONS.md and PLAYBOOK.md pass the format check", () => {
  const root = resolve(TEMPLATES, '../../..');
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', root, '--check'], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the templates as shipped pass the format check', () => {
  const r = run(['--check']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 lessons: 0 open, 0 promoted, 0 closed; 0 bad/);
});

test('a valid log passes, and a lookup prints open rules and points to promoted ones', () => {
  const lessons =
    LESSONS +
    entry('2026-03-01', 'A deploy skipped the migration', {rule: 'run migrations before deploying'}) +
    entry('2026-02-01', 'An old cache rule', {rule: 'clear the cache', status: 'closed: the cache was removed'}) +
    entry('2026-01-01', 'Saved state was lost', {status: 'promoted to PLAYBOOK "Changing saved state"'});
  const playbook = PLAYBOOK + SECTION;

  const check = run(['--check'], {lessons, playbook});
  assert.equal(check.code, 0, check.out);
  assert.match(check.out, /3 lessons: 1 open, 1 promoted, 1 closed; 0 bad/);

  const deploy = run(['deploy'], {lessons, playbook});
  assert.match(deploy.out, /run migrations before deploying/);

  const saved = run(['save'], {lessons, playbook});
  assert.match(saved.out, /PLAYBOOK "Changing saved state": follow its steps/);

  const cache = run(['cache'], {lessons, playbook});
  assert.doesNotMatch(cache.out, /clear the cache/, 'a closed lesson is never printed');
});

test('--check reports a missing field, dates out of order and a promotion to a missing section', () => {
  const lessons =
    LESSONS +
    entry('2026-01-01', 'Older entry on top') +
    entry('2026-02-01', 'Newer entry below') +
    entry('2025-12-01', 'No why given', {why: null}) +
    entry('2025-11-01', 'Promoted nowhere', {status: 'promoted to PLAYBOOK "No such section"'});
  const r = run(['--check'], {lessons});
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Newer entry below: newer than the entry above it/);
  assert.match(r.out, /No why given: missing or empty: Why/);
  assert.match(r.out, /Promoted nowhere: PLAYBOOK\.md has no section "## No such section"/);
});

test('--check reports a From: line that names a lesson not promoted to that section', () => {
  const lessons = LESSONS + entry('2026-01-01', 'Saved state was lost');
  const r = run(['--check'], {lessons, playbook: PLAYBOOK + SECTION});
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /From: names 2026-01-01 "Saved state was lost", which is not a lesson promoted to this section/);
});
