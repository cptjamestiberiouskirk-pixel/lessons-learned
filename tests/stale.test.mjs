// Tests for --stale in templates/lessons.mjs: which lessons it lists, which
// names in Evidence it treats as files, and how it reads repo files the log
// names, which are as untrusted as the log. LESSONS_SCRIPT=<path> runs them
// against another copy of the script.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from './child.mjs';
import {existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {can, REFUSED} from './links.mjs';

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
    if (REFUSED.includes(e.code)) return false;
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

// A junction to a volume path (\\?\Volume{GUID}\...), which lstat reports as a
// plain folder, not a link. Any user can make one. Returns false where none can be made.
function volumeJunction(at, target) {
  if (process.platform !== 'win32') return false;
  const root = target.slice(0, 3);
  const vol = spawnSync('mountvol', [root, '/L'], {encoding: 'utf8'}).stdout?.trim();
  if (!/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i.test(vol ?? '')) return false;
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', at, vol + target.slice(root.length)], {encoding: 'utf8'});
  if (r.status !== 0) return false;
  folders.unshift(at); // removed first, as the junction itself, before its folder
  return !lstatSync(at).isSymbolicLink();
}

test('--stale does not read through a junction to a volume path, which lstat calls a folder', (t) => {
  const outside = folder();
  writeFileSync(join(outside, 'a.md'), 'held text\n');
  const dir = repo([
    entry('Held outside', '`docs/a.md`, search "held text"'),
    entry('Not held outside', '`docs/a.md`, search "other text"'),
  ]);
  if (!volumeJunction(join(dir, 'docs'), outside)) return t.skip('no junction to a volume path can be made here');
  const r = stale(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal((r.out.match(/`docs\/a\.md`: not checked: a link on the way leads elsewhere/g) || []).length, 2, r.out);
  assert.doesNotMatch(r.out, /: no longer holds "/);
});

// The Kelvin sign (U+212A) lowercases to "k", but NTFS keeps "kit" and "Kit"
// (with the Kelvin sign) apart, so a check that folds the whole path with
// toLowerCase lets a junction into the second through.
test('--stale compares the repo\'s real path exactly, so a folder that differs from it only by Unicode case is outside', (t) => {
  const base = folder();
  const repoDir = join(base, 'kit', 'repo');
  const outside = join(base, `${String.fromCodePoint(0x212a)}it`, 'repo', 'docs');
  mkdirSync(repoDir, {recursive: true});
  mkdirSync(outside, {recursive: true});
  if (readdirSync(base).length !== 2) return t.skip('this file system folds the Kelvin sign to "k"');
  writeFileSync(join(repoDir, 'LESSONS.md'), LESSONS + entry('Held outside', '`docs/a.md`, search "held text"'));
  writeFileSync(join(repoDir, 'PLAYBOOK.md'), PLAYBOOK);
  writeFileSync(join(outside, 'a.md'), 'held text\n');
  if (!volumeJunction(join(repoDir, 'docs'), outside)) return t.skip('no junction to a volume path can be made here');
  const r = stale(repoDir);
  assert.match(r.out, /`docs\/a\.md`: not checked: a link on the way leads elsewhere/, r.out);
});

test('--stale finds a file named in another case where the file system ignores case', (t) => {
  const dir = repo([entry('Other case', '`Docs/A.md`, search "held text"')], {'docs/a.md': 'held text\n'});
  if (!existsSync(join(dir, 'DOCS', 'A.MD'))) return t.skip('this file system tells case apart');
  const r = stale(dir);
  assert.doesNotMatch(r.out, /"Other case"/, r.out);
  assert.match(r.out, /-- 0 of 1 open or promoted lessons have evidence to review; 1 file names checked/);
});

test('--stale gives the same leads for a repo opened through a link to it', (t) => {
  const dir = repo(
    [entry('Gone file', '`src/old.ts`'), entry('Still holds', '`src/app.ts`, search "pollSave"')],
    {'src/app.ts': 'export function pollSave() {}\n'},
  );
  const via = join(folder(), 'via');
  // A junction on Windows needs no extra rights; elsewhere the type is ignored.
  if (!link(dir, via, 'junction')) return t.skip('links are not allowed here');
  folders.unshift(via); // removed first, as the link itself, before its folder
  const direct = stale(dir);
  const linked = stale(via);
  assert.match(direct.out, /`src\/old\.ts`: no such file/);
  assert.equal(linked.out, direct.out);
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
  // Where the file system has no hard links (exFAT, FAT), that one case can't be staged.
  if (can.hardLink) linkSync(join(dir, 'linked.txt'), join(dir, 'second-name.txt'));
  const r = stale(dir);
  assert.doesNotMatch(r.out, /"At the limit"/, r.out);
  assert.match(r.out, /`over\.txt`: not searched: over 1048576 bytes/);
  assert.match(r.out, /`src\/lib`: not searched: not a regular file/);
  if (can.hardLink) assert.match(r.out, /`linked\.txt`: not searched: a file with a second hard link/);
});

test('--stale checks 100 file names, and counts the ones past that', () => {
  const names = Array.from({length: 101}, (_, i) => `\`f${i}.md\``).join(', ');
  const r = stale(repo([entry('Many', names)]));
  assert.match(r.out, /100 file names checked, and 1 more not checked \(the limit is 100\)/);
  assert.equal((r.out.match(/: no such file/g) || []).length, 100);
});

test('--stale spells out hidden characters in the text it quotes, and cuts a long name short', () => {
  const rlo = String.fromCodePoint(0x202e);
  const long = `docs/${'z'.repeat(500)}.md`;
  const dir = repo([entry('Hidden', `\`a.md\`, search "abc${rlo}def"; \`${long}\``)], {'a.md': 'nothing\n'});
  const r = stale(dir);
  assert.ok(!r.out.includes(rlo), 'U+202E reached the output');
  assert.match(r.out, /no longer holds "abc<U\+202E>def"/);
  assert.match(r.out, /`docs\/z+ \[cut: \d+ more characters\]`: no such file/);
});

test('--stale does not search for text over 200 UTF-16 units, and does not quote it', () => {
  const text = 'q'.repeat(201);
  const dir = repo([entry('At the limit', `\`a.md\`, search "${'q'.repeat(200)}"`), entry('Over the limit', `\`a.md\`, search "${text}"`)], {'a.md': 'q'.repeat(300)});
  const r = stale(dir);
  assert.doesNotMatch(r.out, /"At the limit"/, r.out);
  assert.match(r.out, /`a\.md`: not searched: search text over 200 UTF-16 units/);
  assert.ok(!r.out.includes(text), r.out);
});

test('--stale counts the limit in UTF-16 units, so 100 emoji are searched and 101 are not', () => {
  const face = String.fromCodePoint(0x1f600); // two UTF-16 units
  const dir = repo(
    [entry('One hundred', `\`a.md\`, search "${face.repeat(100)}"`), entry('One hundred and one', `\`a.md\`, search "${face.repeat(101)}"`)],
    {'a.md': face.repeat(100)},
  );
  const r = stale(dir);
  assert.doesNotMatch(r.out, /"One hundred"\n/, r.out);
  assert.match(r.out, /"One hundred and one"\n {4}`a\.md`: not searched: search text over 200 UTF-16 units/);
});

// Past about 250 UTF-16 units, V8's substring search turns about 100 times
// slower per search. 100 searches at the limit, over a 1 MB file, must cost
// about what the worst ASCII search at the limit costs. Each runs twice and
// the faster run counts; a ratio holds on a slow machine where seconds don't.
test('--stale costs no more for emoji search text than for ASCII at the limit', () => {
  const smile = String.fromCodePoint(0x1f600);
  const other = String.fromCodePoint(0x1f601);
  const many = (text) => Array.from({length: 100}, () => `\`a.md\`, search "${text}"`).join('; ');
  const ascii = repo([entry('Ascii', many('a'.repeat(199) + 'b'))], {'a.md': 'a'.repeat(MAX_SEARCH)});
  const atLimit = repo([entry('At the limit', many(other + smile.repeat(99)))], {'a.md': smile.repeat(MAX_SEARCH / 4)});
  const longer = repo([entry('Longer', many(other + smile.repeat(199)))], {'a.md': smile.repeat(MAX_SEARCH / 4)});
  const timed = (dir) => {
    const started = Date.now();
    const r = stale(dir);
    return {took: Date.now() - started, r};
  };
  const best = (dir) => [timed(dir), timed(dir)].reduce((a, b) => (a.took <= b.took ? a : b));
  const base = best(ascii);
  // At the limit the search runs, so it gets room on both sides. Past the limit
  // the text is refused before any read, so that run is only Node's start and
  // gets a tight bound: a script that searches it takes 6 times the ASCII case
  // or more, and the fixed one under a quarter of it.
  for (const [what, dir, limit] of [['at the limit', atLimit, 4 * base.took + 500], ['200 emoji', longer, 1.5 * base.took]]) {
    const run = best(dir);
    assert.equal(run.r.code, 0, run.r.out);
    assert.ok(run.took < limit, `${what} took ${run.took} ms, the ASCII worst case ${base.took} ms`);
  }
});

// A folder marked case-sensitive (no admin needed) can hold `repo` and `REPO`
// side by side, so the repo's part of the real path must keep its case.
test('--stale refuses a junction into a folder that differs from the repo only in case, in a case-sensitive folder', (t) => {
  const base = folder();
  if (process.platform !== 'win32') return t.skip('folders marked case-sensitive are a Windows feature');
  const mark = spawnSync('fsutil', ['file', 'setCaseSensitiveInfo', base, 'enable'], {encoding: 'utf8'});
  if (mark.status !== 0) return t.skip('this folder cannot be marked case-sensitive here');
  const repoDir = join(base, 'repo');
  const outside = join(base, 'REPO', 'docs');
  mkdirSync(repoDir);
  mkdirSync(outside, {recursive: true});
  writeFileSync(join(repoDir, 'LESSONS.md'), LESSONS + entry('Held outside', '`docs/a.md`, search "held text"'));
  writeFileSync(join(repoDir, 'PLAYBOOK.md'), PLAYBOOK);
  writeFileSync(join(outside, 'a.md'), 'held text\n');
  if (!volumeJunction(join(repoDir, 'docs'), outside)) return t.skip('no junction to a volume path can be made here');
  const r = stale(repoDir);
  assert.match(r.out, /`docs\/a\.md`: not checked: a link on the way leads elsewhere/, r.out);
});

// The repo's real path ends in a separator in the comparison, so a sibling
// folder whose name starts with the repo's is outside. Two names, since each
// gets past a different wrong comparison: `repoZdocs` past one that skips a
// character after the root, `repodocs` past one that strips a separator there.
for (const sibling of ['repoZdocs', 'repodocs']) {
  test(`--stale refuses a junction into a sibling folder whose name starts with the repo's (${sibling})`, (t) => {
    const base = folder();
    const repoDir = join(base, 'repo');
    const outside = join(base, sibling);
    mkdirSync(repoDir);
    mkdirSync(outside);
    writeFileSync(join(repoDir, 'LESSONS.md'), LESSONS + entry('Held outside', '`docs/a.md`, search "held text"'));
    writeFileSync(join(repoDir, 'PLAYBOOK.md'), PLAYBOOK);
    writeFileSync(join(outside, 'a.md'), 'held text\n');
    if (!volumeJunction(join(repoDir, 'docs'), outside)) return t.skip('no junction to a volume path can be made here');
    const r = stale(repoDir);
    assert.match(r.out, /`docs\/a\.md`: not checked: a link on the way leads elsewhere/, r.out);
  });
}

// A long search text made V8's substring search take time in the product of the
// file's length and the text's, so the run grew with the square of its input.
// Times the full input and a quarter of it: linear work grows about 4 times,
// quadratic about 16. Each size runs twice and the faster run counts.
test('--stale runs in linear time when the search text is long', () => {
  const sized = (part) => {
    const half = 'a'.repeat(40000 * part);
    return repo([entry('Long search', `\`big.txt\`, search "${half}b${half}"`)], {'big.txt': 'a'.repeat(800000 * part)});
  };
  const timed = (dir) => {
    const started = Date.now();
    const r = stale(dir);
    return {took: Date.now() - started, r};
  };
  const small = sized(0.25);
  const big = sized(1);
  const quarter = [timed(small), timed(small)].reduce((a, b) => (a.took <= b.took ? a : b));
  const full = [timed(big), timed(big)].reduce((a, b) => (a.took <= b.took ? a : b));
  assert.ok(full.took < 8 * quarter.took + 1000, `the full input took ${full.took} ms, a quarter of it ${quarter.took} ms`);
  assert.equal(full.r.code, 0, full.r.out);
});

test('--stale prints 50 lessons and counts the rest', () => {
  const r = stale(repo(Array.from({length: 51}, (_, i) => entry(`Gone ${i}`, `\`gone${i}.md\``))));
  assert.equal((r.out.match(/^2026-01-01 "Gone \d+"$/gm) || []).length, 50, r.out);
  assert.match(r.out, /\.\.\. and 1 more lessons, not printed/);
  assert.match(r.out, /-- 51 of 51 open or promoted lessons have evidence to review/);
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
