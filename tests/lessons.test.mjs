// Tests for templates/lessons.mjs, run against the plugin's own templates and
// against logs built in a temp folder. Run with: node --test.
// LESSONS_SCRIPT=<path> runs them against another copy of the script; the tests
// that compare the template file with its copies still read the template.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from './child.mjs';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins/lessons-learned/templates');
const TEMPLATE_SCRIPT = join(TEMPLATES, 'lessons.mjs');
const SCRIPT = process.env.LESSONS_SCRIPT ? resolve(process.env.LESSONS_SCRIPT) : TEMPLATE_SCRIPT;
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
  const actual = createHash('sha256').update(readFileSync(TEMPLATE_SCRIPT, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(named[1], actual, 'templates/lessons.mjs changed: update its fingerprint in SKILL.md, "The script\'s fingerprint"');
});

test("this repo's own dev/lessons.mjs is the same text as the template", () => {
  const own = readFileSync(resolve(TEMPLATES, '../../../dev/lessons.mjs'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(own, readFileSync(TEMPLATE_SCRIPT, 'utf8').replace(/\r\n/g, '\n'), 'copy templates/lessons.mjs to dev/lessons.mjs');
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

// Q40: a section's lessons are the ones whose Status names it. A From: line is
// optional; one that is there may name some of them, but only real ones.
test('--check passes a promoted lesson whose section has no From: line, or a From: line that names others', () => {
  const lessons =
    LESSONS +
    entry('2026-02-01', 'Saves were written twice', {status: 'promoted to PLAYBOOK "Changing saved state"'}) +
    entry('2026-01-01', 'Saved state was lost', {status: 'promoted to PLAYBOOK "Changing saved state"'});
  const bare = run(['--check'], {lessons, playbook: PLAYBOOK + '\n## Changing saved state\n\n1. Edit every writer and reader.\n'});
  assert.equal(bare.code, 0, bare.out);
  const partial = run(['--check'], {lessons, playbook: PLAYBOOK + SECTION});
  assert.equal(partial.code, 0, partial.out);
  assert.doesNotMatch(partial.out, /does not name it/);
});

// Q41: --section prints a section's steps, then the rules of the lessons whose
// Status names it, and nothing from other sections or open lessons.
const SECTION_LESSONS =
  LESSONS +
  entry('2026-03-01', 'A deploy skipped the migration', {rule: 'run migrations before deploying'}) +
  entry('2026-02-01', 'Saves were written twice', {rule: 'write a save once, from one place', status: 'promoted to PLAYBOOK "Changing saved state"'}) +
  entry('2026-01-15', 'A cache went stale', {rule: 'clear the cache after a deploy', status: 'promoted to PLAYBOOK "Deploying"'}) +
  entry('2026-01-01', 'Saved state was lost', {rule: 'read the save back after writing it', status: 'promoted to PLAYBOOK "Changing saved state"'});
const SECTION_BOOK = PLAYBOOK + SECTION + '2. Read the save back.\n\n## Deploying\n\n1. Clear the cache.\n';

test('--section prints the steps and the rules of the lessons promoted there, and no From: line', () => {
  const r = run(['--section', 'Changing saved state'], {lessons: SECTION_LESSONS, playbook: SECTION_BOOK});
  assert.equal(r.code, 0, r.out);
  const lines = r.out.trimEnd().split('\n');
  assert.match(lines[0], /^PLAYBOOK "Changing saved state" \(section 3, PLAYBOOK\.md line \d+\)$/);
  assert.deepEqual(lines.slice(1, 3), ['1. Edit every writer and reader.', '2. Read the save back.']);
  assert.match(lines[3], /^-- 2 lessons promoted to this section \(their Status names it\)/);
  assert.deepEqual(lines.slice(4), [
    '2026-02-01 "Saves were written twice"',
    '    write a save once, from one place',
    '2026-01-01 "Saved state was lost"',
    '    read the save back after writing it',
  ]);
  assert.doesNotMatch(r.out, /From:|clear the cache|run migrations/);
});

test('--section matches a name in another case, and an unknown name lists the sections with exit 1', () => {
  const lower = run(['--section', 'changing SAVED state'], {lessons: SECTION_LESSONS, playbook: SECTION_BOOK});
  assert.equal(lower.code, 0, lower.out);
  assert.match(lower.out, /^PLAYBOOK "Changing saved state"/);
  const none = run(['--section', 'Nowhere'], {lessons: SECTION_LESSONS, playbook: SECTION_BOOK});
  assert.equal(none.code, 1, none.out);
  assert.match(none.out, /^no section "Nowhere" in PLAYBOOK\.md; its sections: 1 "The lessons check", 2 "Checking your work", 3 "Changing saved state", 4 "Deploying"$/m);
  const empty = run(['--section', 'Checking your work'], {lessons: SECTION_LESSONS, playbook: SECTION_BOOK});
  assert.match(empty.out, /^-- no lesson is promoted to this section$/m);
});

test('--section takes one name and no other mode', () => {
  for (const args of [['--section'], ['--section', '--check'], ['--section', ' '], ['--section', 'a', 'word'], ['word', '--section', 'a'], ['--section', 'a', '--json'], ['--section', 'a', '--leads'], ['--check', '--section', 'a']]) {
    const r = run(args);
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.out}`);
    assert.match(r.out, /^usage: /, JSON.stringify(args));
  }
});

test('--section prints at most 300 lines of a section and 50 lessons, and says when it is past its budget', () => {
  const steps = Array.from({length: 400}, (_, i) => `${i + 1}. Step ${i + 1} of a long section.`).join('\n');
  const many = Array.from({length: 60}, (_, i) => entry(`2026-01-${String(28 - Math.floor(i / 3)).padStart(2, '0')}`, `Lesson ${i}`, {rule: `rule ${i}`, status: 'promoted to PLAYBOOK "Long"'})).join('');
  const r = run(['--section', 'Long'], {lessons: LESSONS + many, playbook: `${PLAYBOOK}\n## Long\n\n${steps}\n`});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^300\. Step 300 of a long section\.$/m);
  assert.doesNotMatch(r.out, /^301\. /m);
  assert.match(r.out, /^\.\.\. and 100 more lines, not printed: read the section in PLAYBOOK\.md$/m);
  assert.match(r.out, /^-- 60 lessons promoted to this section/m);
  assert.equal((r.out.match(/^ {4}rule \d+$/gm) || []).length, 50);
  assert.match(r.out, /^\.\.\. and 10 more lessons, not printed/m);
  assert.match(r.out, /^-- size-budget: this section and its lessons' rules are about \d+ tokens, over the section budget of 1500/m);
});

test('--section prints a From: line that names no lesson, both sections of a duplicate name, and says when a name matches two by case', () => {
  const book = `${PLAYBOOK}\n## Dup\n\nFrom: now on, run the check.\n1. First.\n\n## Dup\n\n1. Second.\n\n## Foo\n\n1. A.\n\n## FOO\n\n1. B.\n`;
  const mixed = run(['--section', 'Changing saved state'], {lessons: SECTION_LESSONS, playbook: SECTION_BOOK.replace('2. Read the save back.\n', '2. Read the save back.\nFrom: 2026-01-01 "Saved state was lost". Also: never push on Fridays.\nFrom: 2026-02-01 "Saves were written twice", and 2026-01-01 "Saved state was lost".\n')});
  assert.equal(mixed.code, 0, mixed.out);
  assert.match(mixed.out, /^From: 2026-01-01 "Saved state was lost"\. Also: never push on Fridays\.$/m, 'a From: line with other text keeps that text');
  assert.doesNotMatch(mixed.out, /^From: 2026-02-01/m, 'a From: line of names only is left out');
  const dup = run(['--section', 'Dup'], {playbook: book});
  assert.match(dup.out, /^From: now on, run the check\.$/m, 'a From: line that names no lesson is text a reader sees');
  assert.match(dup.out, /^1\. First\.$/m);
  assert.match(dup.out, /^1\. Second\.$/m, 'the second section of the same name is printed too');
  const foo = run(['--section', 'foo'], {playbook: book});
  assert.equal(foo.code, 1, foo.out);
  assert.match(foo.out, /^no section "foo" in PLAYBOOK\.md; it matches 2 sections that differ only in case: give its number; /m);
});

test('--section prints a From: line in a code block, trims the name, keeps a section Budget: and ends with the format-problem line', () => {
  const book = `${PLAYBOOK}\n## Fenced\n\n1. Write the line:\n\`\`\`\nFrom: 2026-01-01 "Saved state was lost"\n\`\`\`\n`;
  const fenced = run(['--section', '  Fenced  '], {lessons: SECTION_LESSONS, playbook: book});
  assert.equal(fenced.code, 0, fenced.out);
  assert.match(fenced.out, /^PLAYBOOK "Fenced"/);
  assert.match(fenced.out, /^From: 2026-01-01 "Saved state was lost"$/m, 'a From: line in a code block is an example, and is printed');
  const small = run(['--section', 'Deploying'], {lessons: SECTION_LESSONS.replace('# LESSONS\n', '# LESSONS\n\nBudget: section 5\n'), playbook: SECTION_BOOK});
  assert.match(small.out, /^-- size-budget: this section and its lessons' rules are about \d+ tokens, over the section budget of 5:/m);
  const bad = run(['--section', 'Deploying'], {lessons: SECTION_LESSONS + '\n## not a lesson heading\n', playbook: SECTION_BOOK});
  assert.equal(bad.code, 0, bad.out);
  assert.match(bad.out.trimEnd().split('\n').at(-1), /^lessons: the log has \d+ format problem\(s\): run node dev\/lessons\.mjs --check$/);
});

// From review round 1 of Q41. Slow version it fails on: trimming the leading
// blank lines with shift(), which copies the array each time (quadratic).
test('--section on a section that starts with many blank lines costs linear time', async () => {
  const {loadLog, sectionReport} = await import(pathToFileURL(SCRIPT).href);
  const time = (blanks) => {
    const dir = mkdtempSync(join(tmpdir(), 'lessons-test-'));
    folders.push(dir);
    writeFileSync(join(dir, 'LESSONS.md'), LESSONS);
    writeFileSync(join(dir, 'PLAYBOOK.md'), `${PLAYBOOK}\n## Blank\n${'\n'.repeat(blanks)}1. A step.\n`);
    const log = loadLog(dir);
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = process.hrtime.bigint();
      sectionReport(log, 'Blank');
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return best;
  };
  const base = time(1);
  const quarter = time(50000);
  const full = time(200000);
  assert.ok(full - base < 8 * (quarter - base) + 50, `200,000 blank lines took ${full} ms, 50,000 took ${quarter} ms, 1 took ${base} ms`);
});

test('a lookup that names a section points to --section, and one that names none does not', () => {
  const saved = run(['save'], {lessons: SECTION_LESSONS, playbook: SECTION_BOOK});
  assert.match(saved.out, /^-- node dev\/lessons\.mjs --section <number> prints a section's steps and its lessons' rules: give the section's number, never its name$/m);
  const deploy = run(['migration'], {lessons: SECTION_LESSONS, playbook: SECTION_BOOK});
  assert.doesNotMatch(deploy.out, /--section/);
});

// From Codex's security review of PR 16. A section's name is repo text: in a
// command, a shell runs a $(...) or backtick in it before node starts. So the
// lookup prints each section's number, and step 3 gives that, never the name.
test('a lookup prints each section\'s number, --section takes it, and step 3 never puts a name in a command', () => {
  const book = `${SECTION_BOOK}\n## Ship $(touch marker)\n\n1. Ship it.\n\n## 7\n\n1. A section named with digits.\n`;
  const lessons = SECTION_LESSONS + entry('2025-12-01', 'Shipping broke', {rule: 'ship with care', status: 'promoted to PLAYBOOK "Ship $(touch marker)"'});
  const look = run(['save', 'ship'], {lessons, playbook: book});
  assert.match(look.out, /^PLAYBOOK "Changing saved state": follow its steps \(2 matching lessons\), section 3$/m);
  assert.match(look.out, /^PLAYBOOK "Ship \$\(touch marker\)": follow its steps \(1 matching lesson\), section 5$/m);
  const byNumber = run(['--section', '5'], {lessons, playbook: book});
  assert.equal(byNumber.code, 0, byNumber.out);
  assert.match(byNumber.out, /^PLAYBOOK "Ship \$\(touch marker\)" \(section 5, PLAYBOOK\.md line \d+\)$/m);
  assert.match(byNumber.out, /^ {4}ship with care$/m);
  const digits = run(['--section', '7'], {lessons, playbook: book});
  assert.equal(digits.code, 1, 'a value of digits only is a number, and there is no section 7');
  assert.match(digits.out, /^no section 7 in PLAYBOOK\.md; its sections: 1 "The lessons check", .*, 6 "7"$/m);
  for (const n of ['0', '99']) assert.equal(run(['--section', n], {lessons, playbook: book}).code, 1, n);
  // No printed line asks for a name: not the usage, not a Status that names no
  // section (it gets no number), not the line past 50 lessons.
  const usage = run([], {lessons, playbook: book});
  assert.match(usage.out, /\| --section <number> \|/);
  assert.doesNotMatch(usage.out, /--section <name>/);
  const gone = run(['gone'], {lessons: lessons + entry('2025-11-01', 'Gone broke', {rule: 'r', status: 'promoted to PLAYBOOK "Gone"'}), playbook: book});
  assert.match(gone.out, /^PLAYBOOK "Gone": follow its steps \(1 matching lesson\), not a section of PLAYBOOK\.md: run node dev\/lessons\.mjs --check$/m);
  const many = Array.from({length: 51}, (_, i) => entry(`2025-10-${String(28 - Math.floor(i / 3)).padStart(2, '0')}`, `Many ${i}`, {rule: `rule ${i}`, status: 'promoted to PLAYBOOK "Deploying"'})).join('');
  const long = run(['--section', '4'], {lessons: lessons + many, playbook: book});
  assert.match(long.out, /^\.\.\. and 2 more lessons, not printed: close the lessons a test or tool now enforces in full \(The lessons check, step 6\)$/m);
  assert.doesNotMatch(long.out, /search LESSONS\.md/);
  for (const copy of [TEMPLATES, resolve(TEMPLATES, '../../lessons-learned-codex/templates'), resolve(TEMPLATES, '../../..')]) {
    const text = readFileSync(join(copy, 'PLAYBOOK.md'), 'utf8');
    const step3 = text.split('\n').find((l) => l.startsWith('3. Follow each rule named.'));
    assert.ok(step3, copy);
    assert.match(step3, /`node dev\/lessons\.mjs --section <number>` with the number the lookup printed/, copy);
    assert.doesNotMatch(step3, /--section "/, `${copy}: step 3 puts a section's name in a command`);
  }
});
