// Tests for --stale in templates/lessons.mjs: which lessons it lists, which
// names in Evidence it treats as files, and how it reads repo files the log
// names, which are as untrusted as the log. LESSONS_SCRIPT=<path> runs them
// against another copy of the script.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins/lessons-learned/templates');
const SCRIPT = process.env.LESSONS_SCRIPT ? resolve(process.env.LESSONS_SCRIPT) : join(TEMPLATES, 'lessons.mjs');
const LESSONS = readFileSync(join(TEMPLATES, 'LESSONS.md'), 'utf8');
const PLAYBOOK = readFileSync(join(TEMPLATES, 'PLAYBOOK.md'), 'utf8');
const MAX_SEARCH = 1024 * 1024;

const folders = [];
after(() => folders.forEach((f) => rmSync(f, {recursive: true, force: true})));
function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-stale-'));
  folders.push(dir);
  return dir;
}
// A repo folder with the two files, the given log entries and other files.
function repo(entries, files = {}, playbook = PLAYBOOK) {
  const dir = folder();
  writeFileSync(join(dir, 'LESSONS.md'), LESSONS + entries.join(''));
  writeFileSync(join(dir, 'PLAYBOOK.md'), playbook);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), {recursive: true});
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
function stale(dir) {
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--stale'], {encoding: 'utf8'});
  return {code: r.status, out: r.stdout + r.stderr};
}
function entry(title, evidence, status = 'open', date = '2026-01-01') {
  return `\n## ${date}: ${title}\n- What went wrong: it broke\n- Why: a cause\n- Rule going forward: a rule\n- Evidence: ${evidence}\n- Status: ${status}\n`;
}
// Makes a link, or returns false where the system doesn't allow it.
function link(target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return false;
    throw e;
  }
}

test('--stale lists a file that is gone and text a file no longer holds, and passes what still holds', () => {
  const dir = repo(
    [
      entry('Gone file', '`src/old.ts`, search "saveEvery"'),
      entry('Text gone', '`src/app.ts`, search "saveEvery"'),
      entry('Still holds', 'commit abc1234; `src/app.ts`, search "pollSave"'),
      entry('Folder named', 'the helpers in `src/lib`'),
    ],
    {'src/app.ts': 'export function pollSave() {}\n', 'src/lib/a.ts': ''},
  );
  const r = stale(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2026-01-01 "Gone file"\n {4}`src\/old\.ts`: no such file/);
  assert.match(r.out, /2026-01-01 "Text gone"\n {4}`src\/app\.ts`: no longer holds "saveEvery"/);
  assert.doesNotMatch(r.out, /Still holds|Folder named/);
  assert.match(r.out, /-- 2 of 4 open or promoted lessons have evidence to review; 4 file names checked; 0 name no file/);
  assert.match(r.out, /a lead, not a verdict/);
});

test('--stale names the section of a promoted lesson, and skips a closed one', () => {
  const playbook = PLAYBOOK + '\n## Saving\n\nFrom: 2026-01-01 "Promoted"\n\n1. Poll the save.\n';
  const dir = repo(
    [
      entry('Promoted', '`gone.md`', 'promoted to PLAYBOOK "Saving"'),
      entry('Closed', '`gone.md`', 'closed: the save was removed'),
    ],
    {},
    playbook,
  );
  const r = stale(dir);
  assert.match(r.out, /2026-01-01 "Promoted", promoted to PLAYBOOK "Saving"\n {4}`gone\.md`: no such file/);
  assert.doesNotMatch(r.out, /"Closed"/);
  assert.match(r.out, /1 of 1 open or promoted lessons/);
});

test('--stale treats only plain relative paths as file names, so nothing outside the repo is looked up', () => {
  const outside = folder();
  writeFileSync(join(outside, 'secret.md'), 'AKIA-SECRET\n');
  const dir = repo([
    entry('Not files', '`node --test`, `0.2.0`, `byKey`, `-m`, `dev/`, `./a.md`, `a//b.md`'),
    entry('Outside', `\`../secret.md\`, search "AKIA-SECRET"; \`${outside.replace(/\\/g, '/')}/secret.md\`; \`C:\\secret.md\``),
  ]);
  const r = stale(dir);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /secret/i, r.out);
  assert.match(r.out, /0 of 2 open or promoted lessons have evidence to review; 0 file names checked; 2 name no file/);
});

test('--stale pairs backticks left to right, as Markdown does, so a span with a space does not hide the next name', () => {
  const r = stale(repo([entry('Pairs', '`git log`/`gone.md`; `a b`c`d`; `also-gone.md`, search "x `y` z"')]));
  assert.match(r.out, /`gone\.md`: no such file/, r.out);
  assert.match(r.out, /`also-gone\.md`: no such file/, r.out);
  assert.match(r.out, /2 file names checked; 0 name no file/, r.out);
});

test('--stale does not follow a link on the way to a file, and does not read through it', (t) => {
  const outside = folder();
  writeFileSync(join(outside, 'a.md'), 'held text\n');
  const dir = repo([entry('Through a link', '`docs/a.md`, search "other text"')]);
  // A junction on Windows needs no extra rights; elsewhere the type is ignored.
  if (!link(outside, join(dir, 'docs'), 'junction')) return t.skip('links are not allowed here');
  const r = stale(dir);
  assert.match(r.out, /`docs\/a\.md`: not checked: a symbolic link on the way/);
  assert.doesNotMatch(r.out, /: no longer holds "/);
});

test('--stale searches only a regular file of at most 1 MB with one hard link', () => {
  const big = 'x'.repeat(MAX_SEARCH - 4) + 'end\n';
  const dir = repo(
    [
      entry('At the limit', '`exact.txt`, search "end"'),
      entry('Over the limit', '`over.txt`, search "end"'),
      entry('A folder', '`src/lib`, search "end"'),
      entry('Hard link', '`linked.txt`, search "end"'),
    ],
    {'exact.txt': big, 'over.txt': big + 'y', 'src/lib/a.ts': '', 'linked.txt': 'no match here\n'},
  );
  linkSync(join(dir, 'linked.txt'), join(dir, 'second-name.txt'));
  const r = stale(dir);
  assert.doesNotMatch(r.out, /"At the limit"/, r.out);
  assert.match(r.out, /`over\.txt`: not searched: over 1048576 bytes/);
  assert.match(r.out, /`src\/lib`: not searched: not a regular file/);
  assert.match(r.out, /`linked\.txt`: not searched: a file with a second hard link/);
});

test('--stale checks 100 file names, and counts the ones past that', () => {
  const names = Array.from({length: 101}, (_, i) => `\`f${i}.md\``).join(', ');
  const r = stale(repo([entry('Many', names)]));
  assert.match(r.out, /100 file names checked, and 1 more not checked \(the limit is 100\)/);
  assert.equal((r.out.match(/: no such file/g) || []).length, 100);
});

test('--stale spells out hidden characters in the text it quotes, and cuts it short', () => {
  const rlo = String.fromCodePoint(0x202e);
  const dir = repo([entry('Hidden', `\`a.md\`, search "abc${rlo}def${'z'.repeat(500)}"`)], {'a.md': 'nothing\n'});
  const r = stale(dir);
  assert.ok(!r.out.includes(rlo), 'U+202E reached the output');
  assert.match(r.out, /no longer holds "abc<U\+202E>def/);
  assert.match(r.out, /\[cut: \d+ more characters\]/);
});

// A property: in a repo where only an outside file exists, --stale reports
// exactly the file names a plain reference parser finds, in order, each as
// missing, and prints no hidden character. The reference walks the text by hand
// instead of with the script's regex. A seeded generator makes it rerunnable.
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ch = (code) => String.fromCodePoint(code);
const PIECES = ['`', '`', '`', '"', ', search "', ' search "', '/', '..', '.', 'a', 'b.md', 'out.md', '.git', 'x', '\\', ':', 'C:', ' ', '-', '_', '9', ch(0xe9), ch(0x2028), ch(0x202e), ch(0x200b)];
// Pieces that make file names more often, with a few that spoil one, so the
// property covers names that pass as well as ones that are refused.
const NAMEY = ['`', '`', '`b.md`', '`d/x.md`', '`../out.md`', ', search "', '"', 'a', 'x.md', '/', 'd', '-', '_', '9', '.', ' ', '..', ch(0x2028)];
function referenceNames(text) {
  const names = [];
  let i = 0;
  for (;;) {
    const open = text.indexOf('`', i);
    if (open < 0) break;
    const close = text.indexOf('`', open + 1);
    if (close < 0) break;
    names.push(text.slice(open + 1, close));
    i = close + 1;
    // A `, search "text"` (or ` search "text"`) right after is skipped whole.
    for (const lead of [', search "', ' search "']) {
      if (text.startsWith(lead, i)) {
        const end = text.indexOf('"', i + lead.length);
        if (end > i + lead.length) i = end + 1;
        break;
      }
    }
  }
  return names.filter((name) => {
    if (name === '') return false;
    for (const c of name) if (!'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._/-'.includes(c)) return false;
    const parts = name.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
    if (parts.length > 1) return true;
    const dot = name.lastIndexOf('.');
    return dot >= 0 && /^[A-Za-z]/.test(name.slice(dot + 1)) && /^[A-Za-z0-9]+$/.test(name.slice(dot + 1));
  });
}

test('property: --stale reports the file names a plain parser finds, each as missing, and nothing hidden', () => {
  let cases = 0;
  let named = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const next = generator(seed);
    for (let k = 0; k < 40; k++) {
      let evidence = 'e';
      const n = 1 + Math.floor(next() * 30);
      const pieces = k % 2 ? NAMEY : PIECES;
      for (let j = 0; j < n; j++) evidence += pieces[Math.floor(next() * pieces.length)];
      evidence += 'e';
      const outer = folder();
      writeFileSync(join(outer, 'out.md'), 'outside\n');
      const dir = join(outer, 'repo');
      mkdirSync(dir);
      writeFileSync(join(dir, 'LESSONS.md'), LESSONS + entry('P', evidence));
      writeFileSync(join(dir, 'PLAYBOOK.md'), PLAYBOOK);
      const r = stale(dir);
      const why = `seed ${seed} case ${k}: ${JSON.stringify(evidence)}\n${r.out}`;
      const expected = referenceNames(evidence);
      const reported = [...r.out.matchAll(/^ {4}`(.*)`: (.*)$/gm)];
      assert.equal(r.code, 0, why);
      assert.deepEqual(reported.map((m) => m[1]), expected, why);
      assert.ok(reported.every((m) => m[2] === 'no such file'), why);
      assert.match(r.out, new RegExp(`; ${expected.length} file names checked; ${expected.length ? 0 : 1} name no file`), why);
      for (const code of [0x2028, 0x202e, 0x200b]) assert.ok(!r.out.includes(ch(code)), `U+${code.toString(16)} reached the output: ${why}`);
      cases++;
      if (expected.length) named++;
    }
  }
  assert.equal(cases, 200);
  // Enough cases hold a file name that the property is about names, not empty text.
  assert.ok(named >= 50, `only ${named} of 200 cases held a file name`);
});

test('--stale takes no other mode or words', () => {
  const dir = repo([]);
  for (const args of [['--stale', '--check'], ['--check', '--stale'], ['--stale', 'word'], ['word', '--stale']]) {
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir, ...args], {encoding: 'utf8'});
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
  }
});
