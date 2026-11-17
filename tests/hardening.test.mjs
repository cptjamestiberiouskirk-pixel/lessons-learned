// Tests for how templates/lessons.mjs treats LESSONS.md and PLAYBOOK.md as
// untrusted repo content: links, sizes, hidden characters and output length.
// LESSONS_SCRIPT=<path> runs them against another copy of the script, to show
// that they fail on the version before the hardening.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins/lessons-learned/templates');
const SCRIPT = process.env.LESSONS_SCRIPT ? resolve(process.env.LESSONS_SCRIPT) : join(TEMPLATES, 'lessons.mjs');
const LESSONS = readFileSync(join(TEMPLATES, 'LESSONS.md'), 'utf8');
const PLAYBOOK = readFileSync(join(TEMPLATES, 'PLAYBOOK.md'), 'utf8');
const ch = (code) => String.fromCodePoint(code);

const folders = [];
after(() => folders.forEach((f) => rmSync(f, {recursive: true, force: true})));
function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-hardening-'));
  folders.push(dir);
  return dir;
}
function run(dir, args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir, ...args], {encoding: 'utf8'});
  return {code: r.status, out: r.stdout + r.stderr};
}
function withFiles({lessons = LESSONS, playbook = PLAYBOOK} = {}) {
  const dir = folder();
  writeFileSync(join(dir, 'LESSONS.md'), lessons);
  writeFileSync(join(dir, 'PLAYBOOK.md'), playbook);
  return dir;
}
function entry(title, rule = 'a rule', date = '2026-01-01') {
  return `\n## ${date}: ${title}\n- What went wrong: it broke\n- Why: a cause\n- Rule going forward: ${rule}\n- Evidence: a test\n- Status: open\n`;
}
// Text the script printed must never carry the hidden characters themselves.
function assertNoHidden(out) {
  assert.doesNotMatch(out, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/, 'a control character reached the output');
  for (const code of [0x202e, 0x2066, 0x200b, 0xfeff, 0xe0041]) assert.ok(!out.includes(ch(code)), `U+${code.toString(16)} reached the output`);
}

// Makes a symbolic link, or returns false where the system doesn't allow it
// (Windows without Developer Mode or admin rights).
function link(target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return false;
    throw e;
  }
}

test('a LESSONS.md that is a symbolic link to a file elsewhere is refused, and its text is not printed', (t) => {
  const secret = join(folder(), 'secret.txt');
  writeFileSync(secret, '## 2026-01-01: AKIA-SECRET-KEY-LINE\nnot a field AKIA-SECRET-KEY-LINE\n');
  const dir = folder();
  writeFileSync(join(dir, 'PLAYBOOK.md'), PLAYBOOK);
  if (!link(secret, join(dir, 'LESSONS.md'), 'file')) return t.skip('this system does not allow symbolic links here');
  for (const args of [['--check'], ['--all'], ['akia']]) {
    const r = run(dir, args);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /is a symbolic link/);
    assert.doesNotMatch(r.out, /AKIA-SECRET-KEY-LINE/);
  }
});

test('a PLAYBOOK.md that is a symbolic link is refused', (t) => {
  const elsewhere = join(folder(), 'PLAYBOOK.md');
  writeFileSync(elsewhere, PLAYBOOK);
  const dir = folder();
  writeFileSync(join(dir, 'LESSONS.md'), LESSONS);
  if (!link(elsewhere, join(dir, 'PLAYBOOK.md'), 'file')) return t.skip('this system does not allow symbolic links here');
  const r = run(dir, ['--check']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /PLAYBOOK\.md is a symbolic link/);
});

test('a folder named LESSONS.md is refused as not a regular file', () => {
  const dir = folder();
  mkdirSync(join(dir, 'LESSONS.md'));
  writeFileSync(join(dir, 'PLAYBOOK.md'), PLAYBOOK);
  const r = run(dir, ['--check']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /not a regular file/);
});

test('a file of exactly 10 MB is read, and one byte more is refused', () => {
  const max = 10 * 1024 * 1024;
  const pad = (size) => LESSONS + ' '.repeat(size - Buffer.byteLength(LESSONS));
  const ok = run(withFiles({lessons: pad(max)}), ['--check']);
  assert.equal(ok.code, 0, ok.out.slice(0, 500));
  const over = run(withFiles({lessons: pad(max + 1)}), ['--check']);
  assert.equal(over.code, 2, over.out.slice(0, 500));
  assert.match(over.out, /is over 10485760 bytes/);
});

test('--check reports each hidden or control character, and prints it as <U+XXXX>', () => {
  const cases = [
    [0x1b, '<U+001B>'], // escape, as in a terminal color code
    [0x07, '<U+0007>'],
    [0x7f, '<U+007F>'],
    [0x9b, '<U+009B>'], // C1 control sequence introducer
    [0x202e, '<U+202E>'], // right-to-left override
    [0x2066, '<U+2066>'], // left-to-right isolate
    [0x200b, '<U+200B>'], // zero-width space
    [0x2028, '<U+2028>'], // line separator
    [0xfeff, '<U+FEFF>'], // a BOM inside a line
    [0xe0041, '<U+E0041>'], // tag character, used to hide text from people but not models
    [0xe0100, '<U+E0100>'], // variation selector supplement
  ];
  for (const [code, shown] of cases) {
    const r = run(withFiles({lessons: LESSONS + entry(`Title ${ch(code)} here`, `rule ${ch(code)} text`)}), ['--check']);
    assert.equal(r.code, 1, `U+${code.toString(16)}: ${r.out}`);
    assert.match(r.out, /holds a control or invisible character/);
    assert.ok(r.out.includes(shown), `U+${code.toString(16)} not shown as ${shown}: ${r.out}`);
    assertNoHidden(r.out);
  }
});

test('hidden characters in PLAYBOOK.md are reported too', () => {
  const r = run(withFiles({playbook: PLAYBOOK + `\n## Section ${ch(0x202e)}x\n`}), ['--check']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PLAYBOOK\.md line \d+: holds a control or invisible character/);
  assertNoHidden(r.out);
});

test('near misses pass: tab, emoji with a zero-width joiner, a variation selector, accented and wide letters, and a BOM at the very start', () => {
  const text = ch(0xfeff) + LESSONS +
    entry(`Tabs\tand emoji ${ch(0x1f468)}${ch(0x200d)}${ch(0x1f4bb)} ${ch(0x2764)}${ch(0xfe0f)} caf${ch(0xe9)} ${ch(0xff21)}`);
  const r = run(withFiles({lessons: text}), ['--check']);
  assert.equal(r.code, 0, r.out);
});

test('a lookup and --all print the rule with hidden characters spelled out', () => {
  const dir = withFiles({lessons: LESSONS + entry('Colors', `use ${ch(0x1b)}[31mred${ch(0x1b)}[0m text`)});
  for (const args of [['colors'], ['--all']]) {
    const r = run(dir, args);
    assert.match(r.out, /use <U\+001B>\[31mred<U\+001B>\[0m text/, r.out);
    assertNoHidden(r.out);
  }
});

test('a printed line of exactly 2000 characters is whole, and one of 2001 is cut', () => {
  // A lookup prints the rule on a line of its own, indented by four spaces.
  const at = (n) => run(withFiles({lessons: LESSONS + entry('Long', 'x'.repeat(n - 4))}), ['long']).out;
  assert.doesNotMatch(at(2000), /\[cut:/);
  assert.match(at(2001), /\[cut: 1 more characters\]/);
});

test('--check prints 50 BAD lines in full, and names how many more there are past that', () => {
  const broken = (n) => LESSONS + Array.from({length: n}, (_, i) => `\n## 2026-01-01: Broken ${i}\n- Status: open\n`).join('');
  const fifty = run(withFiles({lessons: broken(50)}), ['--check']);
  assert.equal(fifty.out.split('\n').filter((l) => l.startsWith('BAD')).length, 50, fifty.out);
  assert.doesNotMatch(fifty.out, /more, not printed/);
  const more = run(withFiles({lessons: broken(51)}), ['--check']);
  assert.equal(more.out.split('\n').filter((l) => /^BAD\s+line/.test(l)).length, 50, more.out);
  assert.match(more.out, /BAD   \.\.\. and 1 more, not printed/);
  assert.match(more.out, /51 bad/);
});

test('the script imports only node: built-in modules', () => {
  const source = readFileSync(SCRIPT, 'utf8').replace(/\r/g, '');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.match(name, /^node:/, `imports ${name}`);
  assert.doesNotMatch(source, /\brequire\(|\bimport\(/);
});

// A tool that writes a file out (an agent's Write tool, a JSON tool call) can
// turn a single-backslash unicode escape into the character itself, as a setup
// run did with the script's BOM check. The shipped text holds none.
test('the templates and skills hold no single-backslash unicode escape', () => {
  const BS = String.fromCharCode(92);
  const escape = new RegExp('(?<!' + BS + BS + ')' + BS + BS + 'u[0-9A-Fa-f{]');
  assert.match('x' + BS + 'uFEFF', escape);
  assert.doesNotMatch('x' + BS + BS + 'u0000', escape);
  const plugins = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugins');
  const files = ['lessons-learned/templates/lessons.mjs', 'lessons-learned/templates/LESSONS.md', 'lessons-learned/templates/PLAYBOOK.md',
    'lessons-learned/skills/setup/SKILL.md', 'lessons-learned-codex/skills/lessons-setup/SKILL.md'];
  for (const f of files) {
    const lines = readFileSync(join(plugins, f), 'utf8').split('\n');
    lines.forEach((line, i) => assert.doesNotMatch(line, escape, `${f}:${i + 1}`));
  }
});
// Times a run on the full input and on a quarter of it (part 1 and 0.25).
// Linear work grows about 4 times, quadratic work about 16. A busy machine or a
// slow CI runner slows both runs alike, so the ratio holds where a fixed limit
// in seconds would fail for no reason. Each size runs twice, in turn, and the
// faster run counts, so a burst of load during one run doesn't decide it.
function timed(dir, args) {
  const started = Date.now();
  const r = run(dir, args);
  return {took: Date.now() - started, r};
}
function fastest(a, b) {
  return a.took <= b.took ? a : b;
}
function growth(make, args) {
  const small = withFiles(make(0.25));
  const big = withFiles(make(1));
  const quarter1 = timed(small, args);
  const full1 = timed(big, args);
  const quarter = fastest(quarter1, timed(small, args));
  const full = fastest(full1, timed(big, args));
  assert.ok(full.took < 8 * quarter.took + 1000, `the full input took ${full.took} ms, a quarter of it ${quarter.took} ms`);
  return full.r;
}

test('a log of 80,000 entries is checked in linear time (the duplicate check is linear)', () => {
  // Keys of one length, so each comparison in a scan runs the whole key.
  const r = growth((part) => ({lessons: LESSONS + '\n' +
    Array.from({length: 80000 * part}, (_, i) => `## 2026-01-01: E${String(i).padStart(5, '0')}`).join('\n') + '\n'}), ['--check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /80000 lessons/);
});

test('a lookup and --all print 50 lessons, and name how many more there are past that', () => {
  const log = (n) => LESSONS + Array.from({length: n}, (_, i) => entry(`Flood ${i}`, 'a rule')).join('');
  const printed = (out) => out.split('\n').filter((l) => /^2026-01-01 "Flood/.test(l) || /^\[open\] 2026-01-01 "Flood/.test(l)).length;
  for (const args of [['flood'], ['--all']]) {
    const fifty = run(withFiles({lessons: log(50)}), args).out;
    assert.equal(printed(fifty), 50, fifty);
    assert.doesNotMatch(fifty, /more.*not printed/);
    const more = run(withFiles({lessons: log(51)}), args).out;
    assert.equal(printed(more), 50, more);
    assert.match(more, /\.\.\. and 1 more.*not printed/);
  }
});

test('other default-ignorable characters are reported too', () => {
  for (const code of [0x034f, 0x17b4, 0x180b, 0x180f, 0x2065, 0xfff0, 0x1d173, 0xe0080, 0xe01f0]) {
    const r = run(withFiles({lessons: LESSONS + entry(`Title ${ch(code)} here`)}), ['--check']);
    assert.equal(r.code, 1, `U+${code.toString(16)}: ${r.out}`);
    assert.ok(r.out.includes(`<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`), r.out);
  }
});

test('a LESSONS.md with a second hard link is refused', () => {
  const secret = join(folder(), 'secret.txt');
  writeFileSync(secret, '## 2026-01-01: leak\n- What went wrong: x\n- Why: x\n- Rule going forward: SECRET-RULE\n- Evidence: x\n- Status: open\n');
  const dir = folder();
  writeFileSync(join(dir, 'PLAYBOOK.md'), PLAYBOOK);
  linkSync(secret, join(dir, 'LESSONS.md'));
  const r = run(dir, ['leak']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /has 2 hard links/);
  assert.doesNotMatch(r.out, /SECRET-RULE/);
});

test('a dev folder that is a link to another project still reads this repo\'s files', () => {
  const other = folder();
  mkdirSync(join(other, 'dev'));
  copyFileSync(SCRIPT, join(other, 'dev', 'lessons.mjs'));
  writeFileSync(join(other, 'LESSONS.md'), LESSONS + entry('Other project'));
  writeFileSync(join(other, 'PLAYBOOK.md'), PLAYBOOK);
  const repo = withFiles({lessons: LESSONS + entry('This repo') + entry('This repo too', 'a rule', '2025-12-31')});
  // A junction needs no special rights on Windows; elsewhere this is a plain link.
  symlinkSync(join(other, 'dev'), join(repo, 'dev'), 'junction');
  const r = spawnSync(process.execPath, [join('dev', 'lessons.mjs')], {cwd: repo, encoding: 'utf8'});
  assert.match(r.stdout, /^2 lessons/, r.stdout + r.stderr);
});

test('a line cut at 2000 characters never splits an emoji', () => {
  const emoji = ch(0x1f600);
  const out = run(withFiles({lessons: LESSONS + entry('Smile', 'x'.repeat(1995) + emoji + 'yy')}), ['smile']).out;
  assert.ok(out.includes('x'.repeat(1995) + emoji + ' [cut: 2 more characters]'), out);
});
test('characters with ordinary uses (ZWNJ, direction marks, soft hyphen) pass --check, and are spelled out when printed', () => {
  for (const code of [0x200c, 0x200e, 0x200f, 0x061c, 0x00ad]) {
    const dir = withFiles({lessons: LESSONS + entry(`Mixed text`, `word${ch(code)}word`)});
    const check = run(dir, ['--check']);
    assert.equal(check.code, 0, `U+${code.toString(16)}: ${check.out}`);
    const lookup = run(dir, ['mixed']).out;
    assert.ok(lookup.includes(`word<U+${code.toString(16).toUpperCase().padStart(4, '0')}>word`), lookup);
    assert.ok(!lookup.includes(ch(code)), `U+${code.toString(16)} printed raw`);
  }
});

test('an error message spells out hidden characters in the path it names', () => {
  const r = run(join(folder(), `no${ch(0x202e)}such`), ['--check']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /cannot read .*no<U\+202E>such/);
  assertNoHidden(r.out);
});
test('a field of 300,000 continuation lines is checked in linear time (continuations are joined once)', () => {
  const r = growth((part) => {
    const rule = '- Rule going forward: start\n' + '  ab\n'.repeat(300000 * part);
    return {lessons: LESSONS + `\n## 2026-01-01: Long field\n- What went wrong: x\n- Why: x\n${rule}- Evidence: x\n- Status: open\n`};
  }, ['--check']);
  assert.equal(r.code, 0, r.out);
});

test('a lookup prints the playbook pointers first, so 51 open lessons never push them past the cap', () => {
  const promoted = `\n## 2026-01-02: Flood promoted\n- What went wrong: x\n- Why: x\n- Rule going forward: a rule\n- Evidence: x\n- Status: promoted to PLAYBOOK "Flood steps"\n`;
  const lessons = LESSONS + promoted + Array.from({length: 51}, (_, i) => entry(`Flood ${i}`)).join('');
  const playbook = PLAYBOOK + '\n## Flood steps\n\nFrom: 2026-01-02 "Flood promoted"\n\n1. A step.\n';
  const dir = withFiles({lessons, playbook});
  assert.equal(run(dir, ['--check']).code, 0, run(dir, ['--check']).out);
  const out = run(dir, ['flood']).out;
  assert.match(out, /PLAYBOOK "Flood steps": follow its steps \(1 matching lesson\)/, out);
  assert.match(out, /\.\.\. and 2 more, not printed/, out);
});

test('runs of variation selectors or zero-width joiners, and ones out of place, are reported', () => {
  const vs = ch(0xfe0f);
  const zwj = ch(0x200d);
  const cases = {
    'two selectors after a letter': `a${vs}${vs}b`,
    'a selector after a space': `a ${vs}b`,
    'a selector at the start': `${vs}word`,
    'a joiner between ASCII letters': `a${zwj}b`,
    'two joiners between emoji': `${ch(0x1f468)}${zwj}${zwj}${ch(0x1f4bb)}`,
    'a joiner at the end': `${ch(0x1f468)}${zwj}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const r = run(withFiles({lessons: LESSONS + entry('Smuggled', `x ${text} y`)}), ['--check']);
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.match(r.out, /<U\+(FE0F|200D)>/, `${name}: ${r.out}`);
  }
});

test('emoji and script sequences pass: a flag with its selector and joiner, a keycap, a Devanagari conjunct', () => {
  const flag = [0x1f3f3, 0xfe0f, 0x200d, 0x1f308].map(ch).join('');
  const keycap = '1' + ch(0xfe0f) + ch(0x20e3);
  const conjunct = [0x0915, 0x094d, 0x200d, 0x0937].map(ch).join('');
  const dir = withFiles({lessons: LESSONS + entry(`Sequences ${flag} ${keycap} ${conjunct}`)});
  const r = run(dir, ['--check']);
  assert.equal(r.code, 0, r.out);
  const lookup = run(dir, ['sequences']).out;
  assert.ok(lookup.includes(flag) && lookup.includes(keycap) && lookup.includes(conjunct), lookup);
});

test('a second entry with the same date and title, and a second playbook section with the same name, are reported', () => {
  const twice = run(withFiles({lessons: LESSONS + entry('Same') + entry('Same')}), ['--check']);
  assert.equal(twice.code, 1, twice.out);
  assert.match(twice.out, /Same: a second entry with this date and title/);
  const apart = run(withFiles({lessons: LESSONS + entry('Same') + entry('Other') + entry('Same')}), ['--check']);
  assert.match(apart.out, /Same: a second entry with this date and title/, apart.out);
  const sections = run(withFiles({playbook: PLAYBOOK + '\n## Twice\n\n1. A step.\n\n## Twice\n\n1. A step.\n'}), ['--check']);
  assert.equal(sections.code, 1, sections.out);
  assert.match(sections.out, /a second section named "Twice"/);
});

test('a From: line naming 100,000 lessons, with 10,000 promoted ones, is checked in linear time (From: names are a set)', () => {
  // Every key has the same length and differs from the lessons' keys only at
  // the end, so each comparison in a scan runs the whole key.
  const r = growth((part) => ({
    lessons: LESSONS + Array.from({length: 10000 * part}, (_, i) =>
      `\n## 2020-01-01: P${String(i).padStart(5, '0')}\n- What went wrong: x\n- Why: x\n- Rule going forward: x\n- Evidence: x\n- Status: promoted to PLAYBOOK "S"\n`).join(''),
    playbook: PLAYBOOK + '\n## S\n\nFrom: ' + '2020-01-01 "P0000x" '.repeat(100000 * part) + '\n',
  }), ['--check']);
  assert.match(r.out, /10000 lessons/, r.out);
});

test('a variation selector after an ASCII letter, or one other than U+FE0E and U+FE0F, is reported', () => {
  // "hi" as nibbles after the letters of an ordinary word.
  const nibbles = [6, 8, 6, 9].map((n) => ch(0xfe00 + n));
  const smuggled = 'rule'.split('').map((c, i) => c + nibbles[i]).join('');
  // After a digit or an emoji too: only U+FE0E and U+FE0F pass there.
  for (const text of [smuggled, `${ch(0x4e2d)}${ch(0xfe00)}`, `a${ch(0xfe0f)}`, `1${ch(0xfe00)}`, `${ch(0x2764)}${ch(0xfe01)}`]) {
    const r = run(withFiles({lessons: LESSONS + entry('Selectors', `x ${text} y`)}), ['--check']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /<U\+FE0[0-9A-F]>/, r.out);
  }
  const ok = run(withFiles({lessons: LESSONS + entry('Selectors', `dial 1${ch(0xfe0e)} or # ${ch(0x2764)}${ch(0xfe0f)}`)}), ['--check']);
  assert.equal(ok.code, 0, ok.out);
});

test('a run of characters with ordinary uses is reported, though one alone passes', () => {
  for (const text of [ch(0x200c).repeat(2), ch(0xad).repeat(800), `${ch(0x200e)}${ch(0x200f)}`]) {
    const r = run(withFiles({lessons: LESSONS + entry('Runs', `word${text}word`)}), ['--check']);
    assert.equal(r.code, 1, r.out);
  }
  // Next to a tab or an emoji's own selector it is not a run: Hebrew after an
  // emoji takes a right-to-left mark there.
  for (const text of [`\t${ch(0x200c)}`, `${ch(0x2764)}${ch(0xfe0f)}${ch(0x200f)}`]) {
    const r = run(withFiles({lessons: LESSONS + entry('Not runs', `word${text}word`)}), ['--check']);
    assert.equal(r.code, 0, r.out);
  }
});

test('a joiner before a tab is reported', () => {
  const r = run(withFiles({lessons: LESSONS + entry('Joiner', `caf${ch(0xe9)}${ch(0x200d)}\tx`)}), ['--check']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /<U\+200D>/);
});

test('a 4 MB title named in 50 problem messages is checked in linear time (printing stops at the cut)', () => {
  // Spelling out the whole title for each message would grow with the title
  // times the messages: the quarter has a quarter of the title and 12 of the 50
  // messages, so that work grows about 16 times, and the bounded print about 4.
  const r = growth((part) => ({lessons: LESSONS + `\n## 2026-01-01: ${ch(1).repeat(4 * 1024 * 1024 * part)}\n` + 'x\n'.repeat(part === 1 ? 50 : 12)}), ['--check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /more characters\]/);
});

test('a 9 MB title named in 50 problem messages costs about what one message costs (the title is cut once)', () => {
  // --check prints at most 50 problems, so a title cut again for each message
  // costs 50 walks of it: linear in the title, and missed by a growth test.
  // Here the title stays the same and only the messages naming it change.
  const title = 'a'.repeat(9 * 1024 * 1024);
  const log = (messages) => withFiles({lessons: LESSONS + `\n## 2026-01-01: ${title}\n` + 'x\n'.repeat(messages)});
  const few = log(1);
  const many = log(50);
  const few1 = timed(few, ['--check']);
  const many1 = timed(many, ['--check']);
  const one = fastest(few1, timed(few, ['--check']));
  const fifty = fastest(many1, timed(many, ['--check']));
  assert.ok(fifty.took < 3 * one.took + 100, `50 messages took ${fifty.took} ms, 1 message ${one.took} ms`);
  assert.match(fifty.r.out, /a \[cut: \d+ more characters\]: not a field/);
});

test('a lesson named on a From: line is cut short in its problem message, so the problem stays in view', () => {
  const playbook = PLAYBOOK + `\n## S\n\nFrom: 2026-01-01 "${'T'.repeat(5000)}"\n`;
  const r = run(withFiles({playbook}), ['--check']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[cut: \d+ more characters\], which is not a lesson promoted to this section/, r.out);
});

test('a cut inside an emoji sequence spells out the joiner it leaves at the end', () => {
  const family = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map(ch).join('');
  const out = run(withFiles({lessons: LESSONS + entry('Family', 'x'.repeat(1994) + family)}), ['family']).out;
  assert.ok(out.includes('x'.repeat(1994) + ch(0x1f468) + '<U+200D> [cut: 3 more characters]'), out);
  assertNoHidden(out);
  assert.ok(!out.includes(ch(0x200d) + ' '), 'a joiner was printed raw before a space');
});

test('word-final joiners in scripts pass: a Malayalam chillu, a Devanagari half form, an Arabic form before a full stop', () => {
  const chillu = [0x0d28, 0x0d4d, 0x200d].map(ch).join('');
  const half = [0x0915, 0x094d, 0x200d].map(ch).join('');
  const arabic = [0x0628, 0x200d].map(ch).join('') + '.';
  const r = run(withFiles({lessons: LESSONS + entry('Scripts', `${chillu} ${arabic} ${half}`)}), ['--check']);
  assert.equal(r.code, 0, r.out);
});

test('a line separator (U+2028) in a rule is reported as hidden, and the rule is still read', () => {
  const dir = withFiles({lessons: LESSONS + entry('Separator', `one${ch(0x2028)}two`)});
  const check = run(dir, ['--check']);
  assert.equal(check.code, 1, check.out);
  assert.match(check.out, /; 1 bad/, check.out);
  assert.doesNotMatch(check.out, /missing or empty|not a field/, check.out);
  assert.match(run(dir, ['separator']).out, /one<U\+2028>two/);
});

test('an entry written inside a code block is reported, not silently skipped', () => {
  const inside = LESSONS.replace('- Status: open | promoted', '## 2026-01-01: Hidden in the example\n- Status: open | promoted');
  assert.notEqual(inside, LESSONS);
  const r = run(withFiles({lessons: inside}), ['--check']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /an entry inside a code block \(opened on line \d+\) is not read/);
});

test('a section name holding a line separator (U+2028) is still a section', () => {
  const name = `Sep${ch(0x2028)}arated`;
  const playbook = PLAYBOOK + `\n## ${name}\n\nFrom: 2026-01-01 "Promoted one"\n\n1. A step.\n`;
  const lessons = LESSONS + entry('Promoted one').replace('- Status: open', `- Status: promoted to PLAYBOOK "${name}"`);
  const r = run(withFiles({lessons, playbook}), ['--check']);
  assert.equal(r.code, 1, r.out); // the hidden character itself is reported
  assert.match(r.out, /1 promoted/, r.out);
  assert.doesNotMatch(r.out, /has no section|does not name it|not a lesson promoted/, r.out);
});

test('a title holding a line separator (U+2028) is still a lesson', () => {
  const r = run(withFiles({lessons: LESSONS + entry(`Sep${ch(0x2028)}arated`)}), ['--check']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /1 lessons: 1 open/, r.out);
  assert.doesNotMatch(r.out, /heading is not in the form/, r.out);
});

test('a closed status holding a line separator (U+2028) is still closed', () => {
  const lessons = LESSONS + entry('Retired', 'an old rule').replace('- Status: open', `- Status: closed: obsolete${ch(0x2028)}see notes`);
  const dir = withFiles({lessons});
  const check = run(dir, ['--check']);
  assert.match(check.out, /1 lessons: 0 open, 0 promoted, 1 closed/, check.out);
  assert.doesNotMatch(check.out, /Status must be/, check.out);
  assert.doesNotMatch(run(dir, ['retired']).out, /an old rule/);
});

test('an ordinary character before a tab is not hidden (the tab is not spelled out)', () => {
  const r = run(withFiles({lessons: LESSONS + entry('Tabbed', `word${ch(0x200c)}\tword`)}), ['--check']);
  assert.equal(r.code, 0, r.out);
});

test('a spelled-out character that does not fit at the cut is left out whole, and the cut counts characters', () => {
  // The rule's line is printed after four spaces: 1998 characters, then a
  // zero-width space spelled out as <U+200B> would take it to 2006.
  const r = run(withFiles({lessons: LESSONS + entry('Cutword', 'a'.repeat(1994) + ch(0x200b) + ch(0x200b) + 'b')}), ['cutword']);
  const line = r.out.split('\n').find((l) => l.startsWith('    a'));
  assert.equal(line, `    ${'a'.repeat(1994)} [cut: 3 more characters]`);
});

test('a long title is cut short in problem messages, so the problem stays in view', () => {
  const lessons = LESSONS + entry('T'.repeat(5000)).replace('- Evidence: a test\n', '');
  const r = run(withFiles({lessons}), ['--check']);
  assert.match(r.out, new RegExp(String.raw`line \d+: ${'T'.repeat(200)} \[cut: 4800 more characters\]: missing or empty: Evidence`), r.out);
});
