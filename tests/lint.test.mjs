// Tests for --lint and --doctor, and for importing the script. Each fixture in
// lint-fixtures.mjs is written to a temp folder and linted there. Run with:
// node --test. LESSONS_SCRIPT=<file> runs them against another copy.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from './child.mjs';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {FIXTURES} from './lint-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.LESSONS_SCRIPT ? resolve(process.env.LESSONS_SCRIPT) : resolve(HERE, '../plugins/lessons-learned/templates/lessons.mjs');

const folders = [];
after(() => folders.forEach((f) => rmSync(f, {recursive: true, force: true})));
function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-lint-'));
  folders.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), {recursive: true});
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
function run(args, dir) {
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir, ...args], {encoding: 'utf8'});
  return {code: r.status, out: r.stdout + r.stderr};
}
function lint(files) {
  const dir = folder(files);
  const r = run(['--lint', '--json'], dir);
  let json;
  try {
    json = JSON.parse(r.out);
  } catch {
    assert.fail(`--lint --json printed no JSON (exit ${r.code}): ${r.out.slice(0, 300)}`);
  }
  return {code: r.code, json, dir};
}

for (const fx of FIXTURES) {
  test(`fixture (${fx.source}): ${fx.name}`, () => {
    const {code, json, dir} = lint(fx.files);
    const has = (f) => json.findings.some((g) => g.rule === f.rule && g.severity === f.severity && g.file === f.file && (f.line === undefined || g.line === f.line));
    for (const f of fx.fires || []) assert.ok(has(f), `expected ${f.severity} ${f.rule} in ${f.file}; got ${JSON.stringify(json.findings)}`);
    for (const rule of fx.quiet || []) assert.ok(!json.findings.some((g) => g.rule === rule), `expected no ${rule}; got ${JSON.stringify(json.findings)}`);
    for (const rule of fx.silenced || []) assert.ok(json.silencedFindings.some((g) => g.rule === rule), `expected a silenced ${rule}; got ${JSON.stringify(json.silencedFindings)}`);
    for (const [rule, n] of Object.entries(fx.count || {})) assert.equal(json.findings.filter((g) => g.rule === rule).length, n, `${rule} count`);
    if (fx.hidden) {
      assert.ok(!JSON.stringify(json).includes(fx.hidden), 'the JSON repeats the secret');
      assert.ok(!run(['--lint', '--all'], dir).out.includes(fx.hidden), 'the text output repeats the secret');
    }
    assert.equal(code, json.errors ? 1 : 0, 'exit 1 on an error, 0 otherwise');
  });
}

test('--lint prints each finding with its severity, rule, file and line, and the summary', () => {
  const dir = folder(FIXTURES.find((f) => f.name === 'stale-path in a step is an error').files);
  const r = run(['--lint'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /^ERROR stale-path PLAYBOOK\.md:5 names `dev\/run-all\.mjs`, which is not in the repo$/m);
  assert.match(r.out, /^-- lint: 1 error, 0 warnings$/m);
});

test('a silenced finding is counted, and --lint --all lists it with its reason', () => {
  const dir = folder(FIXTURES.find((f) => f.name === 'a silenced step').files);
  const plain = run(['--lint'], dir);
  assert.equal(plain.code, 0);
  assert.match(plain.out, /^-- lint: 0 errors, 0 warnings, 1 silenced \(--all lists them\)$/m);
  assert.doesNotMatch(plain.out, /SILENCED/);
  for (const args of [['--lint', '--all'], ['--all', '--lint']]) {
    const r = run(args, dir);
    assert.match(r.out, /^SILENCED stale-path PLAYBOOK\.md:6 names `out\/build\.mjs`, which is not in the repo \(reason: the step creates it\)$/m, args.join(' '));
  }
});

test('--doctor adds the summary of the whole log', () => {
  const dir = folder({'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': '# PLAYBOOK\n'});
  const r = run(['--doctor'], dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /^-- doctor: 0 lessons: 0 open, 0 promoted, 0 closed, 0 bad; LESSONS\.md about \d+ tokens \(budget 16000\), --all about \d+ \(budget 6000\)$/m);
});

test('flags that do not go together are a usage error', () => {
  const dir = folder({'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': '# PLAYBOOK\n'});
  for (const args of [['--lint', '--check'], ['--json'], ['--check', '--json'], ['--lint', 'word'], ['--lint', '--doctor'], ['--lint', '--all', '--all'], ['--lint', '--json', '--json'], ['word', '--lint']]) {
    const r = run(args, dir);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.out, /^usage: /, args.join(' '));
  }
});

test('a file that cannot be read is exit 2, and JSON when asked for', () => {
  const dir = folder({'LESSONS.md': '# LESSONS\n'});
  const r = run(['--lint', '--json'], dir);
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.out).error, /^lessons: cannot read .*PLAYBOOK\.md$/);
});

test('a lookup past its budget says so, and one under it prints as before', () => {
  const files = {'LESSONS.md': '# LESSONS\n\nBudget: lookup 10\n\n## 2026-01-02: Saving broke\n- What went wrong: w\n- Why: c\n- Rule going forward: save twice\n- Evidence: e\n- Status: open\n', 'PLAYBOOK.md': '# PLAYBOOK\n'};
  const r = run(['save'], folder(files));
  assert.match(r.out, /^-- size-budget: this lookup is about \d+ tokens, over its budget of 10: use more specific words, and see node dev\/lessons\.mjs --lint$/m);
  const quiet = run(['save'], folder({...files, 'LESSONS.md': files['LESSONS.md'].replace('Budget: lookup 10\n', '')}));
  assert.doesNotMatch(quiet.out, /size-budget/);
});

test('a lint-ignore line is not part of the field a lookup prints', () => {
  const files = {
    'LESSONS.md': '# LESSONS\n\n## 2026-01-02: Saving broke\n- What went wrong: w\n- Why: c\n- Rule going forward: save twice\n  <!-- lint-ignore stale-path: moved -->\n- Evidence: e\n- Status: open\n',
    'PLAYBOOK.md': '# PLAYBOOK\n',
  };
  const r = run(['save'], folder(files));
  assert.match(r.out, /^ {4}save twice$/m);
  assert.doesNotMatch(r.out, /lint-ignore/);
  assert.equal(run(['--check'], folder(files)).code, 0);
});

// ---- Importing the script -------------------------------------------------

test('importing the script runs nothing, prints nothing and exits nothing', async () => {
  const logs = [];
  const log = console.log;
  const before = process.exitCode;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const mod = await import(`${pathToFileURL(SCRIPT).href}?import-test`);
    assert.equal(typeof mod.loadLog, 'function');
    assert.equal(typeof mod.lintReport, 'function');
  } finally {
    console.log = log;
  }
  assert.deepEqual(logs, []);
  assert.equal(process.exitCode, before);
});

test('two calls in one process keep their state apart', async () => {
  const {loadLog, lintReport, lookupReport} = await import(pathToFileURL(SCRIPT).href);
  const a = folder({'LESSONS.md': '# LESSONS\n\n## 2026-01-02: Alpha broke\n- What went wrong: w\n- Why: c\n- Rule going forward: run `node dev/gone.mjs`\n- Evidence: e\n- Status: open\n', 'PLAYBOOK.md': '# PLAYBOOK\n'});
  const b = folder({'LESSONS.md': '# LESSONS\n\n## 2026-01-03: Beta broke\n- What went wrong: w\n- Why: c\n- Rule going forward: run `node dev/gone.mjs`\n- Evidence: e\n- Status: open\n', 'PLAYBOOK.md': '# PLAYBOOK\n', 'dev/gone.mjs': ''});
  const la = loadLog(a);
  const lb = loadLog(b);
  assert.deepEqual(la.entries.map((e) => e.title), ['Alpha broke']);
  assert.deepEqual(lb.entries.map((e) => e.title), ['Beta broke']);
  assert.equal(lintReport(la).errors, 1);
  assert.equal(lintReport(lb).errors, 0);
  // The first log's lookups are its own after the second was linted.
  assert.equal(lintReport(la).errors, 1);
  assert.match(lookupReport(la, ['alpha']).join('\n'), /Alpha broke/);
  assert.doesNotMatch(lookupReport(lb, ['alpha']).join('\n'), /Alpha/);
});

test('an unreadable file is a returned error, not an exit', async () => {
  const {loadLog} = await import(pathToFileURL(SCRIPT).href);
  const exit = process.exit;
  process.exit = () => assert.fail('the script called process.exit');
  try {
    const missing = loadLog(folder({'LESSONS.md': '# LESSONS\n'}));
    assert.match(missing.error, /^lessons: cannot read .*PLAYBOOK\.md$/);
    const notFile = folder({'PLAYBOOK.md': '# PLAYBOOK\n'});
    mkdirSync(join(notFile, 'LESSONS.md'));
    assert.match(loadLog(notFile).error, /LESSONS\.md is not a regular file$/);
  } finally {
    process.exit = exit;
  }
});

// The script started through a link runs, with the root the link's parent's
// parent, as the command line gave it.
function linkedRepo(kind) {
  const repo = folder({'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': '# PLAYBOOK\n'});
  const other = folder({});
  if (kind === 'file') {
    mkdirSync(join(repo, 'dev'));
    symlinkSync(SCRIPT, join(repo, 'dev', 'lessons.mjs'), 'file');
  } else {
    mkdirSync(join(other, 'dev'));
    copyFileSync(SCRIPT, join(other, 'dev', 'lessons.mjs'));
    symlinkSync(join(other, 'dev'), join(repo, 'dev'), 'junction');
  }
  return repo;
}
for (const kind of ['file', 'folder']) {
  test(`started through a link to the ${kind}, the script runs on the link's repo`, (t) => {
    let repo;
    try {
      repo = linkedRepo(kind);
    } catch (e) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip(`links refused here (${e.code})`);
      throw e;
    }
    const r = spawnSync(process.execPath, [join(repo, 'dev', 'lessons.mjs')], {encoding: 'utf8', cwd: repo});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^0 lessons: 0 open, 0 promoted, 0 closed$/m);
  });
}

test('started directly from another folder, by a relative path', () => {
  const repo = folder({'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': '# PLAYBOOK\n'});
  mkdirSync(join(repo, 'dev'));
  copyFileSync(SCRIPT, join(repo, 'dev', 'lessons.mjs'));
  const r = spawnSync(process.execPath, [join('dev', 'lessons.mjs'), '--lint'], {encoding: 'utf8', cwd: repo});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^-- lint: 0 errors, 0 warnings$/m);
});

// ---- Random text ------------------------------------------------------------

// A seeded generator (mulberry32), so a failure can be run again.
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
// Pieces the lint rules look for, and characters that can hide text.
const PIECES = [
  'a', 'Z', '1', ' ', '.', '-', '/', '`', '|', '#', '~/', '\t', ':', '"',
  'curl ', ' | sh', 'INFERRED', 'tried', 'https://', '.ssh', 'AKIA', 'ignore previous instructions',
  '`dev/x.mjs --y`', '`node dev/lessons.mjs --stale`', '`pwsh -File dev/r.ps1 -Z`', 'E:/tmp/', '.jsonl',
  '<!-- lint-ignore stale-path: r -->', '<!-- lint-ignore ', '-->', '\n', '\n1. ', '\n3. ', '\n## ', '\n#### ', '\n  ', '\n```\n',
  ch(0x200b), ch(0x202e), ch(0x2028), ch(0x1b), ch(0xfeff), ch(0x1f468), ch(0x200d), ch(0xe9),
];
const random = (next, n) => Array.from({length: n}, () => PIECES[Math.floor(next() * PIECES.length)]).join('');

test('on random text, --lint --json always prints one JSON object, exits 0 or 1, and spells out hidden characters', async () => {
  // A message is safe to print when show() would leave it as it is.
  const {show} = await import(pathToFileURL(SCRIPT).href);
  for (let seed = 1; seed <= 40; seed++) {
    const next = generator(seed);
    const lessons = `# LESSONS\n\nRule files: CLAUDE.md\n\n## 2026-01-02: A lesson\n- What went wrong: ${random(next, 20)}\n- Why: ${random(next, 20)}\n- Rule going forward: ${random(next, 30)}\n  ${random(next, 10)}\n- Evidence: ${random(next, 30)}\n- Status: open\n${random(next, 20)}`;
    const files = {'LESSONS.md': lessons, 'PLAYBOOK.md': `# PLAYBOOK\n\n## Steps\n\n${random(next, 60)}\n`, 'CLAUDE.md': random(next, 60), 'dev/x.mjs': '--z\n'};
    const r = run(['--lint', '--json'], folder(files));
    assert.ok(r.code === 0 || r.code === 1, `seed ${seed}: exit ${r.code}: ${r.out.slice(0, 300)}`);
    const lines = r.out.trimEnd().split('\n');
    assert.equal(lines.length, 1, `seed ${seed}: one line of JSON`);
    const json = JSON.parse(lines[0]);
    for (const f of [...json.findings, ...json.silencedFindings]) assert.equal(show(f.message), f.message, `seed ${seed}: a hidden character not spelled out`);
    const text = run(['--lint', '--all'], folder(files));
    assert.ok(text.code === 0 || text.code === 1, `seed ${seed}: --lint --all exit ${text.code}`);
  }
});

// ---- Running time -----------------------------------------------------------

// Times loadLog and lintReport on a repo written by `make(part)`, fastest of
// three runs, in this process.
async function timeLint(make) {
  const {loadLog, lintReport} = await import(pathToFileURL(SCRIPT).href);
  const dir = folder(make);
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = process.hrtime.bigint();
    const log = loadLog(dir);
    lintReport(log);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

// Slow version it fails on: matching each finding against every silencing
// comment (valid.find), quadratic in the number of comments.
test('silencing many findings takes linear time', async () => {
  const book = (n) => {
    const lines = ['# PLAYBOOK', '', '## Steps', ''];
    // Each step skips a number (an md-steps finding) and has a comment for it.
    for (let k = 0; k < n; k++) lines.push('<!-- lint-ignore md-steps: on purpose -->', `${2 * k + 1}. A step.`);
    return lines.join('\n') + '\n';
  };
  const make = (n) => ({'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': book(n)});
  const base = await timeLint(make(1));
  const quarter = await timeLint(make(2000));
  const full = await timeLint(make(8000));
  assert.ok(full - base < 8 * (quarter - base) + 50, `8000 comments took ${full} ms, 2000 took ${quarter} ms, 1 took ${base} ms`);
});

// Slow version it fails on: a pattern that reads the rest of the line from
// each rollout-, quadratic in the line's length (review round 1). The line
// count stays the same; only the length changes, 1000 against 4000.
test('a long Evidence line costs linear time', async () => {
  const make = (len) => ({
    'LESSONS.md': '# LESSONS\n\n## 2026-01-02: Long evidence\n- What went wrong: w\n- Why: c\n- Rule going forward: r\n- Evidence: e\n' + `  ${'rollout-'.repeat(len / 8)}\n`.repeat(300) + '- Status: open\n',
    'PLAYBOOK.md': '# PLAYBOOK\n',
  });
  const base = await timeLint(make(8));
  const quarter = await timeLint(make(1000));
  const full = await timeLint(make(4000));
  assert.ok(full - base < 8 * (quarter - base) + 50, `4000 characters took ${full} ms, 1000 took ${quarter} ms, 8 took ${base} ms`);
});

// Slow version it fails on: looking for each flag in the script's text again
// for each command that gives it (no cache), so 300 commands search a 1 MB
// script 300 times. The script is a .ps1 full of near misses (`$kee`), so each
// search does real work. The input stays the same; only the repeat count changes.
test('a flag named in many commands is looked for once', async () => {
  // The parameter comes last, so each search reads every near miss first.
  const script = `${'# $kee $kee $kee $kee $kee $kee $kee $kee\n'.repeat(24000)}param([switch]$Keep)\n`;
  const make = (n) => ({'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': `# PLAYBOOK\n\n## Running\n\n${'Run `pwsh -File dev/tool.ps1 -Keep` here.\n'.repeat(n)}`, 'dev/tool.ps1': script});
  const base = await timeLint({'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': '# PLAYBOOK\n', 'dev/tool.ps1': script});
  const one = await timeLint(make(1));
  const many = await timeLint(make(300));
  assert.ok(many - base < 8 * Math.max(one - base, 1) + 50, `300 commands took ${many} ms, 1 took ${one} ms, none took ${base} ms`);
});

test('the script header and VERSION name the same version', async () => {
  const {VERSION} = await import(pathToFileURL(SCRIPT).href);
  assert.equal(readFileSync(SCRIPT, 'utf8').match(/lessons-learned plugin, version (\S+?)\.?$/m)?.[1], VERSION);
});
