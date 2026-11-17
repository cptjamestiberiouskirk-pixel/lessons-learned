// Property tests for templates/lessons.mjs: statements that must hold for any
// text in LESSONS.md, tried on random text built from the characters the
// hidden-character rules care about. A seeded generator makes every run the
// same; a failure prints the seed and the text's code points to rerun it.
// LESSONS_SCRIPT=<path> runs them against another copy of the script.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
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
function run(lessons, args) {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-property-'));
  folders.push(dir);
  writeFileSync(join(dir, 'LESSONS.md'), lessons);
  writeFileSync(join(dir, 'PLAYBOOK.md'), PLAYBOOK);
  const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir, ...args], {encoding: 'utf8'});
  return {code: r.status, out: r.stdout + r.stderr};
}

// A small seeded generator (mulberry32), so a failure can be run again.
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

// Pieces of text: plain letters and digits, emoji and their parts, letters and
// marks from other scripts, and characters that can hide or disguise text.
const PIECES = [
  'a', 'Z', '1', '#', ' ', '.', '\t',
  ch(0xe9), ch(0x4e2d), ch(0x0628), ch(0x0915), ch(0x094d), ch(0x0d28), ch(0x0d4d),
  ch(0x1f468), ch(0x1f469), ch(0x2764), ch(0x1f3fb), ch(0x20e3),
  ch(0x200d), ch(0x200c), ch(0xfe0f), ch(0xfe0e), ch(0xfe00), ch(0xe0100),
  ch(0x200e), ch(0x200f), ch(0x061c), ch(0xad),
  ch(0x200b), ch(0xfeff), ch(0x202e), ch(0x2066), ch(0xe0041), ch(0x1b), ch(0x07), ch(0x2028), ch(0x180b), ch(0x034f),
];
// Pieces with no character that is bad wherever it stands: only the ordinary
// ones can make a rule bad, and only side by side. Without these cases nearly
// every rule holds some always-bad character, which hides how ordinary ones are judged.
const MILD = [
  'a', 'Z', '1', ' ', '\t', ch(0xe9), ch(0x4e2d), ch(0x0915), ch(0x094d), ch(0x1f468), ch(0x2764),
  ch(0x200c), ch(0x200e), ch(0x200f), ch(0x061c), ch(0xad),
];
// A rule starts and ends with a letter, so trimming the field changes nothing.
function randomRule(next, pieces = PIECES) {
  const n = 1 + Math.floor(next() * 40);
  let text = 'r';
  for (let i = 0; i < n; i++) text += pieces[Math.floor(next() * pieces.length)];
  return `${text}z`;
}
const codes = (text) => [...text].map((c) => c.codePointAt(0).toString(16)).join(' ');

const CANDIDATE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu;
// The only such characters that may reach the output as themselves.
const PASSED = new Set([0x09, 0x200d, 0xfe0e, 0xfe0f]);
// Spelled out when printed, but not counted as bad by --check on their own.
const ORDINARY = new Set(['200C', '200E', '200F', '061C', '00AD']);

const CASES = 40; // one log's worth: under the lookup's cap of 50
const SEEDS = [1, 2, 3, 4, 5];

function log(rules) {
  return LESSONS + rules.map((rule, i) =>
    `\n## 2026-01-01: Case ${i}\n- What went wrong: x\n- Why: x\n- Rule going forward: ${rule}\n- Evidence: x\n- Status: open\n`).join('');
}
// The printed rule of each case, by its number, from a lookup's output.
function printedRules(out) {
  const lines = out.split(/\r?\n/);
  const rules = new Map();
  lines.forEach((line, i) => {
    const m = line.match(/^2026-01-01 "Case (\d+)"$/);
    if (m) rules.set(Number(m[1]), (lines[i + 1] || '').replace(/^ {4}/, ''));
  });
  return rules;
}
// The line number in LESSONS.md of each case's rule.
function ruleLines(text) {
  const lines = new Map();
  let current = -1;
  text.split('\n').forEach((line, i) => {
    const m = line.match(/^## 2026-01-01: Case (\d+)$/);
    if (m) current = Number(m[1]);
    else if (line.startsWith('- Rule going forward: ')) lines.set(i + 1, current);
  });
  return lines;
}

for (const seed of SEEDS) {
  const next = generator(seed);
  const rules = Array.from({length: CASES}, (_, i) => randomRule(next, i % 2 ? MILD : PIECES));
  const text = log(rules);
  const where = (i) => `seed ${seed}, case ${i}: ${codes(rules[i])}`;

  test(`seed ${seed}: printed text holds no hidden character but tab, a joiner or an emoji selector`, () => {
    const printed = printedRules(run(text, ['case']).out);
    assert.equal(printed.size, CASES);
    for (const [i, line] of printed) {
      for (const m of line.matchAll(CANDIDATE)) {
        assert.ok(PASSED.has(m[0].codePointAt(0)), `U+${m[0].codePointAt(0).toString(16)} printed raw; ${where(i)}`);
      }
    }
  });

  test(`seed ${seed}: printing is idempotent (printed text, printed again, is unchanged)`, () => {
    const once = printedRules(run(text, ['case']).out);
    assert.equal(once.size, CASES);
    const again = printedRules(run(log(rules.map((_, i) => once.get(i))), ['case']).out);
    assert.equal(again.size, CASES);
    for (const [i, line] of once) assert.equal(again.get(i), line, where(i));
  });

  test(`seed ${seed}: --check and the lookup agree on which rules hide something`, () => {
    const printed = printedRules(run(text, ['case']).out);
    assert.equal(printed.size, CASES);
    const lineOf = ruleLines(text);
    const reported = new Set();
    const check = run(text, ['--check']).out;
    // Every problem is printed (under the cap of 50), so none is missed below.
    assert.doesNotMatch(check, /more, not printed/, check);
    // Whatever a rule holds, its line still reads as the rule: a hidden
    // character is reported as hidden, not as a missing or broken field.
    assert.doesNotMatch(check, /missing or empty|not a field/, check);
    for (const m of check.matchAll(/^BAD\s+line (\d+): holds a control or invisible character/gm)) {
      reported.add(lineOf.get(Number(m[1])));
    }
    for (const [i, line] of printed) {
      // Each spelled-out form stands for one character of the rule, so two
      // forms side by side were two characters side by side. A rule is bad
      // exactly when it holds a spelled-out character with no ordinary use, or
      // an ordinary one right before another spelled-out character.
      const forms = [...line.matchAll(/<U\+([0-9A-F]{4,6})>/g)];
      const bad = forms.some((m) => !ORDINARY.has(m[1])) ||
        forms.some((m) => ORDINARY.has(m[1]) && line.startsWith('<U+', m.index + m[0].length));
      assert.equal(reported.has(i), bad, `${bad ? 'not reported' : 'reported'}, printed as ${JSON.stringify(line)}; ${where(i)}`);
    }
  });

  test(`seed ${seed}: a long rule is cut within the line's limit, and the cut counts what was left out`, () => {
    // Rules long enough to be cut, most of them; the line is the rule after four spaces.
    const long = Array.from({length: 5}, () => {
      let text = 'r';
      for (let n = 1950 + Math.floor(next() * 200); n > 0; n--) text += PIECES[Math.floor(next() * PIECES.length)];
      return `${text}z`;
    });
    const printed = printedRules(run(log(long), ['case']).out);
    assert.equal(printed.size, long.length);
    for (const [i, line] of printed) {
      const m = line.match(/^(.*?)(?: \[cut: (\d+) more characters\])?$/s);
      const body = m[1];
      // Printed width: 2000 with the four spaces, or 7 more where a joiner
      // left at the cut is spelled out after it.
      const limit = m[2] && body.endsWith('<U+200D>') ? 2007 : 2000;
      assert.ok([...body].length + 4 <= limit, `${[...body].length + 4} characters; seed ${seed}, long case ${i}`);
      // Read back, the body is the start of the rule, and the cut counts the rest.
      const shown = body.replace(/<U\+([0-9A-F]{4,6})>/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
      const all = [...long[i]];
      assert.ok(long[i].startsWith(shown), `printed text is not the start of the rule; seed ${seed}, long case ${i}`);
      assert.equal(Number(m[2] || 0), all.length - [...shown].length, `seed ${seed}, long case ${i}`);
    }
  });
}
