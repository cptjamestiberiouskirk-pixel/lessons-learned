// Tests for --lint and --doctor, and for importing the script. Each fixture in
// lint-fixtures.mjs is written to a temp folder and linted there. Run with:
// node --test. LESSONS_SCRIPT=<file> runs them against another copy.
import {test, after} from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from './child.mjs';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {FIXTURES, LEAD_FIXTURES, LEAD_RULES, PAIR_FIXTURES} from './lint-fixtures.mjs';

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
function lint(files, leads = false) {
  const dir = folder(files);
  const r = run(leads ? ['--lint', '--leads', '--json'] : ['--lint', '--json'], dir);
  let json;
  try {
    json = JSON.parse(r.out);
  } catch {
    assert.fail(`--lint --json printed no JSON (exit ${r.code}): ${r.out.slice(0, 300)}`);
  }
  return {code: r.code, json, dir};
}

for (const fx of [...FIXTURES, ...LEAD_FIXTURES]) {
  test(`fixture (${fx.source}${fx.leads ? ', --leads' : ''}): ${fx.name}`, () => {
    const {code, json, dir} = lint(fx.files, fx.leads);
    const has = (f) =>
      json.findings.some((g) => g.rule === f.rule && g.severity === f.severity && g.file === f.file && (f.line === undefined || g.line === f.line) && (f.has === undefined || g.message.includes(f.has)));
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

// ---- --pairs ----------------------------------------------------------------

// The line of `file` in `files` that holds `has` (the first one), from 1.
const lineOf = (files, {file, has}) => {
  const n = files[file].split('\n').findIndex((l) => l.includes(has)) + 1;
  assert.ok(n > 0, `the fixture's ${file} holds no line with "${has}"`);
  return n;
};
function pairs(files) {
  const dir = folder(files);
  const r = run(['--pairs', '--json'], dir);
  assert.equal(r.code, 0, r.out.slice(0, 300));
  return {json: JSON.parse(r.out), dir};
}
for (const fx of PAIR_FIXTURES) {
  test(`--pairs (${fx.source}): ${fx.name}`, () => {
    const {json, dir} = pairs(fx.files);
    const same = (p, q) => p.file === q.file && p.line === q.line;
    const find = ([x, y]) => {
      const a = {file: x.file, line: lineOf(fx.files, x)};
      const b = {file: y.file, line: lineOf(fx.files, y)};
      return {a, b, pair: json.pairs.find((p) => (same(p.a, a) && same(p.b, b)) || (same(p.a, b) && same(p.b, a)))};
    };
    for (const want of fx.lists) {
      const {a, b, pair} = find(want);
      assert.ok(pair, `expected a pair ${a.file}:${a.line} ${b.file}:${b.line}; got ${JSON.stringify(json.pairs)}`);
      if (fx.cue) assert.ok(pair.cue.includes(fx.cue), `expected the cue ${fx.cue}; got ${pair.cue}`);
      for (const w of fx.notShared || []) assert.ok(!pair.shared.includes(w), `"${w}" should not be a shared word; got ${pair.shared}`);
    }
    // `lacks`: pairs that must not be listed.
    for (const not of fx.lacks || []) {
      const {a, b, pair} = find(not);
      assert.ok(!pair, `expected no pair ${a.file}:${a.line} ${b.file}:${b.line}; got ${JSON.stringify(pair)}`);
    }
    if (fx.none) assert.deepEqual(json.pairs, []);
    const text = run(['--pairs'], dir).out.trimEnd().split('\n');
    assert.ok(text.every((l) => /^PAIR \d+ \S+:\d+ \S+:\d+ /.test(l) || l.startsWith('-- pairs: ')), text.join('\n'));
    assert.match(text[text.length - 1], /^-- pairs: \d+ candidate pairs? among \d+ rules and steps, \d+ printed \(at most 40\); a lead for review, not a verdict$/);
  });
}

// From review round 1 of phase 3. A step over MAX_LINT_LINE whose earlier keys
// shrink it once removed, so a key the 4000-character cut left short came into
// the text read; and a private key, whose body is not key-shaped, on its own
// lines and in backticks on one line.
test('no part of a key cut by the line limit, or of a private key, reaches --pairs', () => {
  const filler = `ghp_${'A'.repeat(36)}`;
  const secret = `ghp_${'SECRETpayload0123456789abcdefghijk'.padEnd(36, 'Z')}`;
  let long = 'Xever deploy service ';
  while (long.length + filler.length + 1 <= 4970) long += `${filler} `;
  long = `${long.padEnd(4970, ' ')}${secret} tail`;
  // The secret itself across the 4000-character cut.
  let straddle = 'Xever deploy service ';
  while (straddle.length + filler.length + 1 <= 3980) straddle += `${filler} `;
  straddle = `${straddle.padEnd(3980, ' ')}${secret} tail`;
  const body = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj', 'MZ2ldSecretPayloadWordsHereAbCdEfGh0123456789AbCdEfGhIjKlMnOpQr'];
  const pem = ['   -----BEGIN PRIVATE KEY-----', ...body.map((b) => `   ${b}`), '   -----END PRIVATE KEY-----'].join('\n');
  const oneLine = `\`-----BEGIN PRIVATE KEY----- ${body.join(' ')} -----END PRIVATE KEY-----\``;
  const books = [
    `# PLAYBOOK\n\n## Deploying\n\n1. Never  ${long}\n2. Always ${long}\n`,
    `# PLAYBOOK\n\n## Deploying\n\n1. Never deploy the service with this:\n${pem}\n2. Always deploy the service with this:\n${pem}\n`,
    `# PLAYBOOK\n\n## Deploying\n\n1. Never deploy the service with ${oneLine} by hand.\n2. Always deploy the service with ${oneLine} by hand.\n`,
    `# PLAYBOOK\n\n## Deploying\n\n1. Never  ${straddle}\n2. Always ${straddle}\n`,
  ];
  for (const [k, book] of books.entries()) {
    const dir = folder({'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': book});
    for (const args of [['--pairs'], ['--pairs', '--json']]) {
      const out = run(args, dir).out;
      for (const piece of ['secr', 'SECR', 'aaaaaaaa', 'AAAAAAAA', 'MIIEvQIBADAN', 'miievqibadan', 'SecretPayloadWords', 'secretpayloadwords'])
        assert.ok(!out.includes(piece), `case ${k + 1}: ${args.join(' ')} printed "${piece}": ${out.slice(0, 400)}`);
    }
  }
});

// From review round 1 of phase 3: one second-sighting per pair of 300 similar
// lessons made 44,850 findings, past MAX_KEEP, and they were kept before a
// bad lint-ignore was found, so that error was only counted.
test('many similar lessons give one second-sighting each, and an error is still listed', () => {
  const entries = Array.from({length: 300}, (_, i) => `## 2026-01-02: Lesson ${i}\n- What went wrong: w\n- Why: c\n- Rule going forward: run the whole test suite before each release build and read its summary line\n- Evidence: e\n- Status: open\n`);
  const dir = folder({'LESSONS.md': `# LESSONS\n\n${entries.join('\n')}`, 'PLAYBOOK.md': '# PLAYBOOK\n\n## Steps\n\n<!-- lint-ignore nothing-here: no such rule -->\n1. A step.\n'});
  const json = JSON.parse(run(['--lint', '--leads', '--json'], dir).out);
  const sightings = json.findings.filter((f) => f.rule === 'second-sighting');
  // Each lesson but the oldest gets one; the newest counts the other 298.
  assert.equal(sightings.length, 299, `${sightings.length} second-sighting findings for 300 lessons`);
  assert.ok(sightings.some((f) => f.message.includes(', and 298 more open lessons:')), 'the newest lesson should count the rest');
  assert.ok(json.findings.some((f) => f.rule === 'bad-ignore'), 'the bad lint-ignore should be listed');
  // The text output prints 100 findings: the error must be one of them.
  const text = run(['--lint', '--leads'], dir).out;
  assert.match(text, /^ERROR bad-ignore PLAYBOOK\.md/m, 'the printed list should hold the error, not only leads');
  const printed = text.split('\n').filter((l) => /^(?:ERROR|WARN ) /.test(l));
  assert.equal(printed.length, 100, 'the print cap is 100 findings');
  assert.match(text, new RegExp(`^\\.\\.\\. and ${json.findings.length - 100} more, not printed$`, 'm'));
  // Printed in file and line order: the leads in LESSONS.md, then the error.
  const at = printed.map((l) => l.match(/ (\S+?):(\d+) /)).map((m) => [m[1], Number(m[2])]);
  assert.ok(at.every((p, k) => k === 0 || at[k - 1][0] < p[0] || (at[k - 1][0] === p[0] && at[k - 1][1] < p[1])), `not in file and line order: ${JSON.stringify(at)}`);
});

// A key outside backticks: the tokens split `ghp_` from its payload, so the
// payload alone would be a shared topic word that a pair and a lead print.
test('no part of a key in two rules reaches --pairs or --leads', () => {
  const payload = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const entry = (date, title, rule) =>
    `## ${date}: ${title}\n- What went wrong: it broke\n- Why: a cause\n- Rule going forward: ${rule}\n- Evidence: a test run\n- Status: open\n\n`;
  const dir = folder({
    'LESSONS.md': `# LESSONS\n\nLessons for this repo.\n\n${entry('2026-01-03', 'Tag pushed', `Always push the release tag with the token ghp_${payload} from the vault.`)}${entry('2026-01-02', 'Tag held', `Never push the release tag with the token ghp_${payload} from the vault.`)}`,
    'PLAYBOOK.md': '# PLAYBOOK\n\n## Steps\n\n1. Run the tests.\n',
  });
  const pairsJson = JSON.parse(run(['--pairs', '--json'], dir).out);
  assert.ok(pairsJson.pairs.length >= 1, 'the two rules should still be a pair');
  const leads = run(['--lint', '--leads'], dir).out;
  assert.match(leads, /second-sighting/, 'the two rules should still be a second sighting');
  for (const args of [['--pairs'], ['--pairs', '--json'], ['--lint', '--leads'], ['--lint', '--leads', '--json']]) {
    const out = run(args, dir).out;
    assert.ok(!out.includes(payload.slice(0, 12)), `${args.join(' ')} printed part of the key: ${out.slice(0, 400)}`);
  }
});

// The keys are found here with node:crypto, not with the script's stepKey, so a
// change to either side shows. On a mismatch the message gives the list to paste.
test('SHIPPED_STEPS holds the key of each step of the playbook template, and no other', async () => {
  const {SHIPPED_STEPS} = await import(pathToFileURL(SCRIPT).href);
  const book = readFileSync(resolve(HERE, '../plugins/lessons-learned/templates/PLAYBOOK.md'), 'utf8').split(/\r?\n/);
  assert.ok(!book.some((l) => /^\s+\S/.test(l)), 'a template step goes on over an indented line: key the joined text');
  const want = book
    .map((l) => l.match(/^\d{1,9}\. (.*)$/)?.[1])
    .filter((t) => t !== undefined)
    .map((t) => createHash('sha256').update(t.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16));
  assert.ok(want.length >= 10, `only ${want.length} steps found in the template`);
  assert.deepEqual([...(SHIPPED_STEPS || [])].sort(), [...want].sort(), `SHIPPED_STEPS should be: ${want.map((k) => `'${k}'`).join(', ')}`);
});

test('--pairs prints at most 40 pairs, strongest first, and says how many it found', () => {
  const steps = [];
  for (let k = 0; k < 60; k++) steps.push(`${2 * k + 1}. Never push the release branch number${k} from a script.`, `${2 * k + 2}. Always push the release branch from the release script.`);
  // The strongest pair comes last, when 40 are already kept: it must displace
  // a weaker one and be printed first. Steps start at line 5.
  const more = 'harbor lantern meadow quartz saddle timber velvet walnut';
  steps.push(`121. Never push the release branch with ${more}.`, `122. Always push the release branch with ${more}.`);
  const r = run(['--pairs'], folder({'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': `# PLAYBOOK\n\n## Pushing\n\n${steps.join('\n')}\n`}));
  const lines = r.out.trimEnd().split('\n');
  const found = lines.filter((l) => l.startsWith('PAIR '));
  assert.equal(found.length, 40);
  const scores = found.map((l) => Number(l.split(' ')[1]));
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.match(found[0], /^PAIR \d+ PLAYBOOK\.md:125 PLAYBOOK\.md:126 /);
  const total = Number(lines[lines.length - 1].match(/^-- pairs: (\d+) candidate pairs/)?.[1]);
  assert.ok(total > 40, lines[lines.length - 1]);
});

test('--pairs compares at most 600 rules and steps, and says so', () => {
  const steps = Array.from({length: 650}, (_, k) => `${k + 1}. Step ${k}.`);
  const r = run(['--pairs'], folder({'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': `# PLAYBOOK\n\n## Steps\n\n${steps.join('\n')}\n`}));
  assert.match(r.out, /^-- pairs: past the limit of 600 rules and steps, 50 not compared$/m);
  assert.match(r.out, /among 600 rules and steps/);
});

test('--pairs reads rule files, and prints text from them made safe', () => {
  const hidden = String.fromCharCode(0x202e);
  const files = {
    'LESSONS.md': '# LESSONS\n',
    'PLAYBOOK.md': `# PLAYBOOK\n\n## Pushing\n\n1. Never push the release branch from \`push${hidden}\` in a script.\n`,
    'CLAUDE.md': `# Rules\n\n- Always push the release branch from \`push${hidden}\` in the release script.\n`,
  };
  const r = run(['--pairs'], folder(files));
  assert.match(r.out, /^PAIR \d+ PLAYBOOK\.md:5 CLAUDE\.md:3 /m);
  assert.ok(!r.out.includes(hidden), 'a hidden character printed as it is');
  assert.match(r.out, /`push<U\+202E>`/);
});

test('--leads alone is --lint --leads; with --doctor it adds the summary', () => {
  const fx = LEAD_FIXTURES.find((f) => f.name === 'unlabeled-claim: a Why that names a cause with no label');
  const dir = folder(fx.files);
  const plain = run(['--lint'], dir);
  assert.doesNotMatch(plain.out, /unlabeled-claim/);
  for (const args of [['--leads'], ['--lint', '--leads'], ['--leads', '--lint']]) {
    const r = run(args, dir);
    assert.equal(r.code, 0, args.join(' '));
    assert.match(r.out, /^WARN {2}unlabeled-claim LESSONS\.md:7 its Why states a cause \("because"\) with no label/m, args.join(' '));
  }
  const doctor = run(['--doctor', '--leads'], dir);
  assert.match(doctor.out, /^WARN {2}unlabeled-claim /m);
  assert.match(doctor.out, /^-- doctor: /m);
  // Every lead finding is a warning, never an error.
  const json = JSON.parse(run(['--lint', '--leads', '--json'], dir).out);
  assert.ok(json.findings.every((f) => !LEAD_RULES.includes(f.rule) || f.severity === 'warning'));
});

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
  for (const args of [
    ['--lint', '--check'], ['--json'], ['--check', '--json'], ['--lint', 'word'], ['--lint', '--doctor'], ['--lint', '--all', '--all'], ['--lint', '--json', '--json'], ['word', '--lint'],
    ['--leads', '--check'], ['--leads', '--leads'], ['--leads', 'word'], ['--stale', '--leads'], ['--pairs', '--leads'], ['--pairs', '--lint'], ['--lint', '--pairs'], ['--pairs', '--all'], ['word', '--pairs'],
  ]) {
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

// Keys of each shape the script knows, with random payloads, at random points
// in two rules that share their other words, so they pair and are a second
// sighting. A space on each side: a key run into a letter is not key-shaped.
test('on random text, no part of a key reaches --pairs or --leads', () => {
  const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let seed = 1; seed <= 30; seed++) {
    const next = generator(seed);
    const pick = (chars, n) => Array.from({length: n}, () => chars[Math.floor(next() * chars.length)]).join('');
    const keys = [
      ['ghp_', pick(ALNUM, 36)],
      ['github_pat_', pick(ALNUM + '_', 40)],
      ['sk-ant-', pick(ALNUM + '_-', 30)],
      ['AKIA', pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16)],
      ['xoxb-', pick(ALNUM + '-', 20)],
    ];
    const words = 'push the release tag with the token from the vault'.split(' ');
    const rule = (lead) => {
      const parts = [lead, ...words];
      for (const [prefix, payload] of keys) parts.splice(1 + Math.floor(next() * parts.length), 0, `${prefix}${payload}`);
      return `${parts.join(' ')} ${random(next, 6).replace(/[`\n]/g, ' ')}`;
    };
    const entry = (date, title, lead) => `## ${date}: ${title}\n- What went wrong: it broke\n- Why: a cause\n- Rule going forward: ${rule(lead)}\n- Evidence: a test run\n- Status: open\n\n`;
    const dir = folder({
      'LESSONS.md': `# LESSONS\n\nLessons for this repo.\n\n${entry('2026-01-03', 'Tag pushed', 'Always')}${entry('2026-01-02', 'Tag held', 'Never')}`,
      'PLAYBOOK.md': '# PLAYBOOK\n\n## Steps\n\n1. Run the tests.\n',
    });
    for (const args of [['--pairs', '--json'], ['--lint', '--leads', '--json']]) {
      const out = run(args, dir).out;
      for (const [, payload] of keys)
        for (let at = 0; at + 8 <= payload.length; at += 4) assert.ok(!out.includes(payload.slice(at, at + 8)), `seed ${seed}: ${args.join(' ')} printed part of ${payload}`);
    }
  }
});

// ---- Running time -----------------------------------------------------------

// Times loadLog and lintReport on a repo written by `make(part)`, fastest of
// three runs, in this process.
async function timeLint(make, leads = false) {
  const {loadLog, lintReport} = await import(pathToFileURL(SCRIPT).href);
  const dir = folder(make);
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = process.hrtime.bigint();
    const log = loadLog(dir);
    lintReport(log, {leads});
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

// Slow version it fails on: promoted-drift comparing each promoted lesson with
// each step of its section (review round 1 of phase 3), so the cost is lessons
// times steps. Both grow 4 times here, 100 lessons and 150 steps against 400
// and 600, and no lesson shares a word with a step, so every pair is compared.
test('promoted-drift costs linear time in lessons and steps together', async () => {
  const make = (k) => {
    const steps = Array.from({length: 150 * k}, (_, i) => `${i + 1}. ${Array.from({length: 128}, (_, w) => `s${i}w${w}q`).join(' ')}`);
    const rule = Array.from({length: 128}, (_, w) => `l${w}m`).join(' ');
    const entries = Array.from({length: 100 * k}, (_, i) => `## 2026-01-02: Lesson ${i}\n- What went wrong: w\n- Why: c\n- Rule going forward: ${rule}\n- Evidence: e\n- Status: promoted to PLAYBOOK "Steps"\n`);
    return {'LESSONS.md': `# LESSONS\n\n${entries.join('\n')}`, 'PLAYBOOK.md': `# PLAYBOOK\n\n## Steps\n\n${steps.join('\n')}\n`};
  };
  const base = await timeLint({'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': '# PLAYBOOK\n'}, true);
  const quarter = await timeLint(make(1), true);
  const full = await timeLint(make(4), true);
  assert.ok(full - base < 8 * (quarter - base) + 50, `400 lessons and 600 steps took ${full} ms, 100 and 150 took ${quarter} ms, none took ${base} ms`);
});

// Slow version it fails on: a curly-quote pattern whose run can hold an opening
// quote, so on a line of them each try reads to the line's end (review round 1
// of phase 3). Only the line length changes, 1000 against 4000.
test('--leads on a long line of opening curly quotes costs linear time', async () => {
  const make = (len) => ({
    'LESSONS.md': '# LESSONS\n\n## 2026-01-02: Quotes\n- What went wrong: w\n- Why: c\n- Rule going forward: r\n- Evidence: e\n' + `  ${String.fromCharCode(0x201c).repeat(len)}\n`.repeat(300) + '- Status: open\n',
    'PLAYBOOK.md': '# PLAYBOOK\n',
  });
  const base = await timeLint(make(8), true);
  const quarter = await timeLint(make(1000), true);
  const full = await timeLint(make(4000), true);
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

// Slow version it fails on: a topicOf that finds the word before each token
// with a regex on the line so far, which is quadratic in the line's length
// (ratio about 14 here; the real script about 2.4). A version that keeps every
// word and looks each up with Array.includes is quadratic too, but its ratio
// was about 8.6, so it failed only 3 of 5 runs, and this test is not trusted
// to catch it. 600 steps, the most --pairs compares, each of distinct words
// that no other step shares, so the comparing costs nothing and the reading
// of each line is what grows; only the line length changes, 1000 against 4000.
test('--pairs on long lines costs linear time', async () => {
  const {loadLog, pairsReport} = await import(pathToFileURL(SCRIPT).href);
  // Letters with no vowel, so no word loses an ending to the stemmer.
  const ABC = 'bcdfghjklmnpqrtvwxz';
  const word = (k) => {
    let s = '';
    for (let n = k + ABC.length ** 3; n > 0; n = Math.floor(n / ABC.length)) s = ABC[n % ABC.length] + s;
    return s;
  };
  let next = 0;
  const make = (len) => {
    const steps = [];
    for (let i = 0; i < 600; i++) {
      let line = '';
      while (line.length < len) line += `${word(next++)} `;
      steps.push(`${i + 1}. ${line.slice(0, len)}`);
    }
    return {'LESSONS.md': '# LESSONS\n', 'PLAYBOOK.md': `# PLAYBOOK\n\n## Steps\n\n${steps.join('\n')}\n`};
  };
  const time = (files) => {
    const dir = folder(files);
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = process.hrtime.bigint();
      const report = pairsReport(loadLog(dir));
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
      assert.equal(report.items, 600);
    }
    return best;
  };
  const base = time(make(8));
  const quarter = time(make(1000));
  const full = time(make(4000));
  assert.ok(full - base < 8 * (quarter - base) + 50, `4000 characters took ${full} ms, 1000 took ${quarter} ms, 8 took ${base} ms`);
});

test('the script header and VERSION name the same version', async () => {
  const {VERSION} = await import(pathToFileURL(SCRIPT).href);
  assert.equal(readFileSync(SCRIPT, 'utf8').match(/lessons-learned plugin, version (\S+?)\.?$/m)?.[1], VERSION);
});
