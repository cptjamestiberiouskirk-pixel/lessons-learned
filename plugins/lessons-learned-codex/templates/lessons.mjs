#!/usr/bin/env node
// lessons.mjs from the lessons-learned plugin, version 0.2.0.
// Prints the rules in LESSONS.md for the lessons check in PLAYBOOK.md, and checks
// the log's format. Reads LESSONS.md and PLAYBOOK.md and writes nothing.
//
// Both files are repo content, so the script treats them as untrusted. It reads
// only regular files of at most 10 MB that sit in the folder itself (a symbolic
// link is refused), prints control and invisible characters as <U+XXXX> instead
// of passing them to the terminal or the agent, cuts long lines short, and
// --check reports those characters as bad. It imports only Node's built-in
// modules.
//
//   node dev/lessons.mjs <word>...   open lessons with a word in their title or
//                                    fields (not Status) that starts with one of
//                                    the words, case ignored ("save" finds "saved"),
//                                    with their rules; promoted ones as a pointer
//                                    to their section; closed ones not at all
//   node dev/lessons.mjs             counts and this usage only
//   node dev/lessons.mjs --all       every lesson with its status and rule
//   node dev/lessons.mjs --check     checks the format; exit 1 if anything is wrong
//
// --dir <folder> reads LESSONS.md and PLAYBOOK.md from that folder instead of the
// repo root (for trying the script on a sample log).

import {lstatSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const USAGE = 'usage: node dev/lessons.mjs [--dir <folder>] [--check | --all | <word>...]';
const FIELDS = ['What went wrong', 'Why', 'Rule going forward', 'Evidence', 'Status'];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_LINE = 2000; // characters of one printed line
const MAX_BAD = 50; // BAD lines printed by --check
const MAX_SHOWN = 50; // lessons printed by a lookup or --all
const MAX_NAME = 200; // characters of a title or section name in a problem message

// Characters that can hide or disguise text: controls (Cc), format characters
// (Cf: bidi marks and overrides, zero-width characters, the BOM, Unicode tag
// characters), every other default-ignorable code point (Hangul fillers,
// variation selectors, unassigned ignorables) and the line and paragraph
// separators. Written with property classes and code numbers, not escapes, so
// a tool that writes this file out can't turn an escape into the character
// itself.
const HIDDEN_CANDIDATE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu;
const ONE_CANDIDATE = /^[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]$/u;
// The emoji and text presentation selectors, U+FE0E and U+FE0F.
const isSelector = (code) => code === 0xfe0e || code === 0xfe0f;
const candidate = (c) => c !== '' && ONE_CANDIDATE.test(c);
// A character you can see: not a candidate above and not white space.
const visible = (c) => c !== '' && !candidate(c) && !/^\s$/u.test(c);
const wide = (c) => visible(c) && c.codePointAt(0) > 0x7f;
const emoji = (c) => visible(c) && /^\p{Emoji}$/u.test(c);
const letterOrMark = (c) => /^[\p{L}\p{M}]$/u.test(c);
// The whole character that ends at index i of text, or after it starts at i.
function before(text, i) {
  if (i <= 0) return '';
  const low = text.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(i - 2, i);
  }
  return text[i - 1];
}
const after = (text, i) => (i < text.length ? String.fromCodePoint(text.codePointAt(i)) : '');

// Whether the candidate c at index i of text must be spelled out. Tab is left
// alone. Two others are left alone only where text uses them, since anywhere
// else they could carry hidden data:
// - U+FE0E or U+FE0F right after an emoji (a keycap digit, a heart).
// - A zero-width joiner (U+200D) after a non-ASCII character, looking past
//   such a selector, with no other candidate after it: an emoji sequence, an
//   Indic conjunct, an Arabic joining form. Before a space or the end of the
//   line only after a letter or mark (a word-final form), not an emoji.
function spelled(text, i, c) {
  const code = c.codePointAt(0);
  if (code === 0x09) return false;
  if (isSelector(code)) return !emoji(before(text, i));
  if (code === 0x200d) {
    let prev = before(text, i);
    if (prev && isSelector(prev.codePointAt(0)) && emoji(before(text, i - prev.length))) prev = before(text, i - prev.length);
    const next = after(text, i + 1);
    if (!wide(prev) || candidate(next)) return true;
    return !(visible(next) || letterOrMark(prev));
  }
  return true;
}
// These have ordinary uses (the zero-width non-joiner in Persian and Indic
// scripts, the left-to-right, right-to-left and Arabic letter marks, the soft
// hyphen in pasted text): they are spelled out when printed, but --check
// doesn't count one as bad unless it sits next to another candidate, since a
// run of them could carry hidden data.
const ordinary = (code) => code === 0x200c || code === 0x200e || code === 0x200f || code === 0x061c || code === 0x00ad;
function hasHidden(text) {
  const s = String(text);
  for (const m of s.matchAll(HIDDEN_CANDIDATE)) {
    if (!spelled(s, m.index, m[0])) continue;
    if (!ordinary(m[0].codePointAt(0))) return true;
    // A run: the character after it is spelled out too. (Checking the one
    // before adds nothing: in a run, the first one already sees the second.)
    const j = m.index + m[0].length;
    const next = after(s, j);
    if (candidate(next) && spelled(s, j, next)) return true;
  }
  return false;
}

// Text as it is safe to print: hidden characters spelled out, long text cut
// by whole code points (a surrogate pair is never split). A joiner left at the
// end of the cut is spelled out, since nothing follows it there.
// The count of what was cut is of the text's own characters.
function show(text, max = MAX_LINE) {
  const s = String(text);
  let out = '';
  let n = 0; // characters printed
  let i = 0;
  while (i < s.length) {
    const c = String.fromCodePoint(s.codePointAt(i));
    const piece = candidate(c) && spelled(s, i, c) ? `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>` : c;
    const width = piece === c ? 1 : piece.length;
    if (n + width > max) break;
    out += piece;
    n += width;
    i += c.length;
  }
  if (i >= s.length) return out;
  let rest = 0;
  for (let j = i; j < s.length; rest++) j += s.codePointAt(j) > 0xffff ? 2 : 1;
  if (out.charCodeAt(out.length - 1) === 0x200d) out = `${out.slice(0, -1)}<U+200D>`;
  return `${out} [cut: ${rest} more characters]`;
}

// A title, section name or From: name as problem messages give it, cut to
// MAX_NAME so the problem itself stays in view after it. Counting what was cut
// walks the whole text, so a title or section name is cut once, when it is
// read: a 10 MB title named in fifty messages costs one walk, not fifty. A
// From: name is in at most one message, so it is cut when that one is made.
const label = (text) => show(text, MAX_NAME);

function say(text) {
  for (const line of String(text).split('\n')) console.log(show(line));
}

const args = process.argv.slice(2);
// The repo root is the parent of the folder the script was started from, as
// given on the command line. Node resolves links in import.meta.url, so a `dev`
// that is a link to another project's folder would move the root there.
let dir = resolve(dirname(process.argv[1] || fileURLToPath(import.meta.url)), '..');
let mode = 'counts';
const words = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dir') {
    if (!args[i + 1] || args[i + 1].startsWith('-')) fail(USAGE);
    dir = resolve(args[++i]);
  } else if (a === '--check' || a === '--all') {
    if (mode !== 'counts' || words.length) fail(USAGE);
    mode = a.slice(2);
  } else if (a.startsWith('-')) {
    fail(USAGE);
  } else {
    if (mode !== 'counts' && mode !== 'words') fail(USAGE);
    mode = 'words';
    words.push(a.toLowerCase());
  }
}

function fail(message) {
  say(message);
  process.exit(2);
}

// One of the two files, as lines. Refuses a symbolic link, anything that isn't a
// regular file, a file with a second hard link and a file over MAX_BYTES, so a
// repo can't make the script read a file from somewhere else or a huge one.
function read(name) {
  const path = join(dir, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`lessons: cannot read ${path}`);
  }
  if (stat.isSymbolicLink()) fail(`lessons: ${path} is a symbolic link; the script reads only a regular file there`);
  if (!stat.isFile()) fail(`lessons: ${path} is not a regular file`);
  if (stat.nlink > 1) fail(`lessons: ${path} has ${stat.nlink} hard links; the script reads only a file with one`);
  if (stat.size > MAX_BYTES) fail(`lessons: ${path} is over ${MAX_BYTES} bytes`);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail(`lessons: cannot read ${path}`);
  }
  // A BOM at the very start is dropped. It is matched by its code, not written
  // as an escape: a tool that writes this file out can turn an escape into the
  // invisible character itself.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r/g, '').split('\n');
}

const bad = [];
const problem = (line, text) => bad.push(`BAD   ${line ? `line ${line}: ` : ''}${text}`);

// PLAYBOOK.md: its "## " sections and the lessons each one's "From:" line names.
const sections = new Map();
{
  let current = null;
  let fence = false;
  read('PLAYBOOK.md').forEach((line, i) => {
    if (hasHidden(line)) problem(0, `PLAYBOOK.md line ${i + 1}: holds a control or invisible character: ${line}`);
    if (line.startsWith('```')) fence = !fence;
    if (fence) return;
    // The s flag lets . match U+2028 and U+2029 too, which JavaScript otherwise
    // treats as line ends: such a line is reported as hidden, not misread.
    const heading = line.match(/^## (.+)$/s);
    if (heading) {
      const name = heading[1].trim();
      current = {name, label: label(name), from: new Set(), line: i + 1};
      if (sections.has(current.name)) problem(0, `PLAYBOOK.md line ${i + 1}: a second section named "${current.label}"`);
      else sections.set(current.name, current);
    } else if (current && line.startsWith('From: ')) {
      for (const m of line.matchAll(/(\d{4}-\d{2}-\d{2}) "([^"]+)"/g)) current.from.add(`${m[1]} "${m[2]}"`);
    }
  });
}

// LESSONS.md: one entry per "## YYYY-MM-DD: title" heading.
const entries = [];
const byKey = new Map(); // an entry's date and title -> the first entry with them
{
  let entry = null;
  let field = null;
  let fence = false;
  let fenceLine = 0;
  const finish = () => {
    if (!entry) return;
    // A field's lines are joined once, here, so a long field costs linear time.
    for (const [f, parts] of Object.entries(entry.parts)) entry.fields[f] = parts.join(' ').trim();
    const missing = FIELDS.filter((f) => !entry.fields[f]);
    if (missing.length) problem(entry.line, `${entry.label}: missing or empty: ${missing.join(', ')}`);
    const status = entry.fields.Status || '';
    let m;
    if (status === 'open') entry.status = 'open';
    else if ((m = status.match(/^promoted to PLAYBOOK "([^"]+)"$/))) {
      entry.status = 'promoted';
      entry.section = m[1];
      const section = sections.get(m[1]);
      if (!section) problem(entry.line, `${entry.label}: PLAYBOOK.md has no section "## ${label(m[1])}"`);
      else if (!section.from.has(entry.key)) problem(entry.line, `${entry.label}: the "From:" line of "${label(m[1])}" does not name it`);
    } else if ((m = status.match(/^closed: (.+)$/s))) {
      entry.status = 'closed';
    } else if (status) {
      problem(entry.line, `${entry.label}: Status must be open, promoted to PLAYBOOK "<section>" or closed: <reason>`);
    }
    entries.push(entry);
    if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
  };
  read('LESSONS.md').forEach((line, i) => {
    const n = i + 1;
    if (hasHidden(line)) problem(n, `holds a control or invisible character: ${line}`);
    if (line.startsWith('```')) {
      fence = !fence;
      fenceLine = n;
      return;
    }
    if (fence) {
      // An entry written inside a code block (the format example's, say) is
      // never read, so the log would look clean while it holds lessons.
      if (/^## \d{4}-\d{2}-\d{2}: /.test(line)) problem(n, `an entry inside a code block (opened on line ${fenceLine}) is not read: move it below the block`);
      return;
    }
    const heading = line.match(/^## (\d{4})-(\d{2})-(\d{2}): (.+)$/s); // s: as in PLAYBOOK.md above
    if (heading) {
      finish();
      const [, y, mo, d, title] = heading;
      const shown = label(title.trim());
      const date = `${y}-${mo}-${d}`;
      const real = new Date(`${date}T00:00:00Z`);
      if (Number.isNaN(real.getTime()) || real.toISOString().slice(0, 10) !== date) problem(n, `not a real date: ${date}`);
      const previous = entries.length ? entries[entries.length - 1].date : null;
      if (previous && date > previous) problem(n, `${shown}: newer than the entry above it (the log is newest first)`);
      const key = `${date} "${title.trim()}"`;
      if (title.includes('"')) problem(n, `${shown}: a title may not hold a double quote (PLAYBOOK "From:" lines quote titles)`);
      if (byKey.has(key) || (entry && entry.key === key)) problem(n, `${shown}: a second entry with this date and title`);
      entry = {date, title: title.trim(), label: shown, key, line: n, fields: {}, parts: {}};
      field = null;
      return;
    }
    if (line.startsWith('#')) {
      if (entry || line.startsWith('## ')) {
        finish();
        entry = null;
        field = null;
        problem(n, `heading is not in the form "## YYYY-MM-DD: title": ${line}`);
      }
      return;
    }
    if (!entry) return; // the header above the first entry
    const f = line.match(/^- ([^:]+):(.*)$/s);
    if (f && FIELDS.includes(f[1])) {
      field = f[1];
      if (field in entry.parts) problem(n, `${entry.label}: "${field}" appears twice`);
      else if (Object.keys(entry.parts).some((k) => FIELDS.indexOf(k) > FIELDS.indexOf(field)))
        problem(n, `${entry.label}: "${field}" is out of order (${FIELDS.join(', ')})`);
      entry.parts[field] = [f[2].trim()];
    } else if (/^\s+\S/.test(line) && field) {
      entry.parts[field].push(line.trim());
    } else if (line.trim() !== '') {
      problem(n, `${entry.label}: not a field (- ${FIELDS.join(': / - ')}:) or an indented continuation: ${line}`);
    }
  });
  finish();
  if (fence) problem(fenceLine, 'code fence is never closed');
}

// Every "From:" name in PLAYBOOK.md must be a lesson promoted to that section.
for (const section of sections.values()) {
  for (const key of section.from) {
    const e = byKey.get(key);
    if (!e || e.status !== 'promoted' || e.section !== section.name)
      problem(0, `PLAYBOOK.md line ${section.line}, "${section.label}": From: names ${label(key)}, which is not a lesson promoted to this section`);
  }
}

const count = (s) => entries.filter((e) => e.status === s).length;
const totals = `${entries.length} lessons: ${count('open')} open, ${count('promoted')} promoted, ${count('closed')} closed`;

if (mode === 'check') {
  bad.slice(0, MAX_BAD).forEach((b) => say(b));
  if (bad.length > MAX_BAD) say(`BAD   ... and ${bad.length - MAX_BAD} more, not printed`);
  say(`${totals}; ${bad.length} bad`);
  process.exit(bad.length ? 1 : 0);
}

if (mode === 'counts') {
  say(totals);
  say(USAGE);
} else if (mode === 'all') {
  entries.slice(0, MAX_SHOWN).forEach((e) => say(`[${e.fields.Status || '?'}] ${e.key}\n    ${e.fields['Rule going forward'] || ''}`));
  if (entries.length > MAX_SHOWN) say(`... and ${entries.length - MAX_SHOWN} more lessons, not printed`);
  say(`-- ${totals}`);
} else {
  let shown = 0;
  const open = []; // matching open lessons with their rules
  const promoted = new Map(); // section -> how many matching lessons it holds
  const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const starts = words.map((w) => new RegExp(`(^|[^a-z0-9])${escape(w)}`));
  for (const e of entries) {
    // Search the title and the field values, not the field labels or Status.
    const text = [e.title, ...FIELDS.filter((f) => f !== 'Status').map((f) => e.fields[f] || '')].join(' ').toLowerCase();
    if (e.status === 'closed' || !starts.some((re) => re.test(text))) continue;
    shown++;
    if (e.status === 'promoted') promoted.set(e.section, (promoted.get(e.section) || 0) + 1);
    else open.push(`${e.key}\n    ${e.fields['Rule going forward'] || ''}`);
  }
  // The playbook sections first, so open lessons never push them past the cap
  // below: each one stands for the lessons promoted into it.
  const pointers = [...promoted].map(([section, n]) => `PLAYBOOK "${section}": follow its steps (${n} matching lesson${n > 1 ? 's' : ''})`);
  const items = [...pointers, ...open];
  items.slice(0, MAX_SHOWN).forEach((item) => say(item));
  if (items.length > MAX_SHOWN) say(`... and ${items.length - MAX_SHOWN} more, not printed: use more specific words`);
  say(`-- ${shown} shown; ${totals}`);
}
if (bad.length) say(`lessons: the log has ${bad.length} format problem(s): run node dev/lessons.mjs --check`);
