#!/usr/bin/env node
// lessons.mjs from the lessons-learned plugin, version 0.4.0.
// Prints the rules in LESSONS.md for the lessons check in PLAYBOOK.md, and checks
// the log's format. Reads LESSONS.md and PLAYBOOK.md (and, for --stale, the repo
// files their evidence names) and writes nothing.
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
//   node dev/lessons.mjs --stale     open and promoted lessons whose Evidence names
//                                    a file in backticks that is gone, or a
//                                    search "text" after it that the file no
//                                    longer holds: leads to review, not verdicts
//   node dev/lessons.mjs --lint      what --check finds, and rules a session may
//                                    not be able to follow: files, commands and
//                                    flags that aren't there, evidence another
//                                    reader can't open, unsettled labels, text
//                                    that reads like an injected instruction,
//                                    Markdown structure and a size budget. Each
//                                    finding has a rule ID and is an error or a
//                                    warning; exit 1 on an error
//   node dev/lessons.mjs --doctor    --lint with a summary of the whole log
//   --lint --all, --doctor --all     also list the findings silenced in place
//   --lint --json, --doctor --json   the same as one JSON object, for CI
//   --lint --leads, --doctor --leads also the leads: warnings from comparing
//                                    words, so noisy by design. A rule a step
//                                    already covers, two open lessons with one
//                                    rule, a promoted lesson that looks filed in
//                                    the wrong section, pasted tool output in
//                                    Evidence, and a cause stated with no label.
//                                    --leads alone is --lint --leads
//   node dev/lessons.mjs --pairs     rule pairs from the lessons, PLAYBOOK and
//                                    rule files that share a topic and may pull
//                                    in opposite directions, at most 40,
//                                    strongest first, for a review to judge
//   --pairs --json                   the same as one JSON object
//
// A finding that is wrong can be silenced where it is, with its rule ID and a
// reason, on a line of its own: <!-- lint-ignore <rule>: <reason> -->. In
// LESSONS.md it is an indented line after one of the entry's fields, and covers
// that entry; in PLAYBOOK.md and a rule file it covers the next line that isn't
// blank. A finding about the header's settings is fixed in the setting.
//
// LESSONS.md's header (the text above the first entry) can hold two settings:
//   Rule files: CLAUDE.md, AGENTS.md, docs/RULES.md   more files --lint reads
//                (CLAUDE.md and AGENTS.md at the root are read when present)
//   Budget: lookup 2000, all 6000, lessons 16000, section 1500   in tokens
//
// --dir <folder> reads LESSONS.md and PLAYBOOK.md from that folder instead of the
// repo root (for trying the script on a sample log). --stale and --lint look for
// the files the text names in that folder too.
//
// Another script can import this file: the functions it exports take the repo
// root, keep their state per call, and return what they found. They never print
// or exit. The command line part runs only when this file is started directly.

import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const VERSION = '0.4.0';
export const USAGE =
  'usage: node dev/lessons.mjs [--dir <folder>] [--check | --all | --stale | --lint [--leads] [--all] [--json] | --doctor [--leads] [--all] [--json] | --leads | --pairs [--json] | <word>...]';
export const FIELDS = ['What went wrong', 'Why', 'Rule going forward', 'Evidence', 'Status'];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_LINE = 2000; // characters of one printed line
const MAX_BAD = 50; // BAD lines printed by --check
const MAX_SHOWN = 50; // lessons printed by a lookup or --all
const MAX_NAME = 200; // characters of a title or section name in a problem message
const MAX_REFS = 100; // file names --stale checks
const MAX_SEARCH = 1024 * 1024; // bytes of a file --stale searches
const MAX_QUOTE = 200; // UTF-16 units of search text --stale looks for
const MAX_FINDINGS = 100; // findings printed by --lint
const MAX_KEEP = 20000; // findings --lint keeps; past that it counts the errors
const MAX_LINT_REFS = 400; // file names --lint looks up in rules, steps and rule files
const MAX_LINT_LINE = 4000; // characters of a line the content rules read
const MAX_RULE_FILES = 20; // rule files --lint reads
const MAX_RULE_BYTES = 1024 * 1024; // bytes of one rule file
// Token budgets, estimated at 4 bytes a token.
const BUDGET = {lookup: 2000, all: 6000, lessons: 16000, section: 1500};
const tokens = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

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
export function show(text, max = MAX_LINE) {
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
// From: name is in at most one message, so it is cut when that one is made,
// and only if that message is one of those printed.
const label = (text) => show(text, MAX_NAME);

// Reads the file a look found at `path`, through one handle, so a file put in
// its place after the look is not read: the handle must be the file the look
// saw (the same device and file ID), still a regular file with one hard link,
// of at most `max` bytes, and give exactly as many bytes as it has. The open
// doesn't follow a link where the system can refuse one, and doesn't wait on a
// FIFO. Returns {text}, or {problem}: 'changed', 'too big' or 'cannot read'.
const OPEN = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
function readSame(path, seen, max) {
  let fd;
  try {
    fd = openSync(path, OPEN);
  } catch {
    return {problem: 'cannot read'};
  }
  try {
    const now = fstatSync(fd, {bigint: true});
    if (now.dev !== seen.dev || now.ino !== seen.ino || !now.isFile() || now.nlink !== 1n) return {problem: 'changed'};
    if (now.size > BigInt(max)) return {problem: 'too big'};
    // One byte more than the size, so a file that grew is caught too.
    const size = Number(now.size);
    const buf = Buffer.alloc(size + 1);
    let got = 0;
    for (let n; got < buf.length && (n = readSync(fd, buf, got, buf.length - got, null)) > 0; ) got += n;
    if (got !== size) return {problem: 'changed'};
    return {text: buf.toString('utf8', 0, got)};
  } catch {
    return {problem: 'cannot read'};
  } finally {
    closeSync(fd);
  }
}

// One of the two files, as {lines}, or {error} with the message to give.
// Refuses a symbolic link, anything that isn't a regular file, a file with a
// second hard link and a file over MAX_BYTES, so a repo can't make the script
// read a file from somewhere else or a huge one.
function readLog(root, name) {
  const path = join(root, name);
  let stat;
  try {
    stat = lstatSync(path, {bigint: true});
  } catch {
    return {error: `lessons: cannot read ${path}`};
  }
  if (stat.isSymbolicLink()) return {error: `lessons: ${path} is a symbolic link; the script reads only a regular file there`};
  if (!stat.isFile()) return {error: `lessons: ${path} is not a regular file`};
  if (stat.nlink > 1n) return {error: `lessons: ${path} has ${stat.nlink} hard links; the script reads only a file with one`};
  if (stat.size > BigInt(MAX_BYTES)) return {error: `lessons: ${path} is over ${MAX_BYTES} bytes`};
  const got = readSame(path, stat, MAX_BYTES);
  if (got.problem === 'changed') return {error: `lessons: ${path} changed while it was read`};
  if (got.problem === 'too big') return {error: `lessons: ${path} is over ${MAX_BYTES} bytes`};
  if (got.problem) return {error: `lessons: cannot read ${path}`};
  let text = got.text;
  // A BOM at the very start is dropped. It is matched by its code, not written
  // as an escape: a tool that writes this file out can turn an escape into the
  // invisible character itself.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return {lines: text.replace(/\r/g, '').split('\n')};
}

// Reads and parses both files of the repo at `root`. Returns {error} when a
// file can't be read, or the log: its playbook sections, its entries, the
// format problems --check reports (the first MAX_BAD messages, and their
// count) and the counts line.
export function loadLog(root) {
  // --check prints the first MAX_BAD problems and counts the rest, so only
  // those messages are kept. A message given as a function is built only when
  // it is kept; a From: message is, since a PLAYBOOK.md can hold hundreds of
  // thousands of bad From: names. Other messages are built as their problem is
  // found.
  // --lint reports the same problems with their file, line and rule ID, from
  // `items`, which keeps the same messages.
  let badCount = 0;
  const bad = [];
  const items = [];
  const problem = (line, text, where = {}) => {
    if (badCount++ >= MAX_BAD) return;
    const built = typeof text === 'function' ? text() : text;
    bad.push(`BAD   ${line ? `line ${line}: ` : ''}${built}`);
    items.push({file: where.file || 'LESSONS.md', line: where.line ?? line, rule: where.rule || 'format', text: built});
  };

  // PLAYBOOK.md: its "## " sections and the lessons each one's "From:" line names.
  // `rows` keeps each line with its section and whether it is in a code block.
  const sections = new Map();
  const rows = [];
  const playbook = readLog(root, 'PLAYBOOK.md');
  if (playbook.error) return {error: playbook.error};
  {
    let current = null;
    let fence = false;
    playbook.lines.forEach((line, i) => {
      if (hasHidden(line)) problem(0, `PLAYBOOK.md line ${i + 1}: holds a control or invisible character: ${line}`, {file: 'PLAYBOOK.md', line: i + 1});
      const marker = line.startsWith('```');
      if (marker) fence = !fence;
      rows.push({n: i + 1, text: line, fence: fence || marker, section: current});
      if (fence) return;
      // The s flag lets . match U+2028 and U+2029 too, which JavaScript otherwise
      // treats as line ends: such a line is reported as hidden, not misread.
      const heading = line.match(/^## (.+)$/s);
      if (heading) {
        const name = heading[1].trim();
        current = {name, label: label(name), from: new Set(), line: i + 1};
        if (sections.has(current.name)) problem(0, `PLAYBOOK.md line ${i + 1}: a second section named "${current.label}"`, {file: 'PLAYBOOK.md', line: i + 1});
        else sections.set(current.name, current);
        rows[rows.length - 1].section = current;
      } else if (current && line.startsWith('From: ')) {
        for (const m of line.matchAll(/(\d{4}-\d{2}-\d{2}) "([^"]+)"/g)) current.from.add(`${m[1]} "${m[2]}"`);
      }
    });
  }

  // LESSONS.md: one entry per "## YYYY-MM-DD: title" heading.
  // Each entry also keeps its field lines (`lines`) and its lint-ignore lines
  // (`ignores`); `header` keeps the lines above the first entry.
  const entries = [];
  const header = [];
  const byKey = new Map(); // an entry's date and title -> the first entry with them
  const lessons = readLog(root, 'LESSONS.md');
  if (lessons.error) return {error: lessons.error};
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
        if (!section) problem(entry.line, `${entry.label}: PLAYBOOK.md has no section "## ${label(m[1])}"`, {rule: 'from-mismatch'});
        else if (!section.from.has(entry.key)) problem(entry.line, `${entry.label}: the "From:" line of "${label(m[1])}" does not name it`, {rule: 'from-mismatch'});
      } else if (/^closed: .+$/s.test(status)) {
        entry.status = 'closed';
      } else if (status) {
        problem(entry.line, `${entry.label}: Status must be open, promoted to PLAYBOOK "<section>" or closed: <reason>`);
      }
      entries.push(entry);
      if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
    };
    lessons.lines.forEach((line, i) => {
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
        entry = {date, title: title.trim(), label: shown, key, line: n, fields: {}, parts: {}, lines: [], ignores: []};
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
      if (!entry) {
        header.push({n, text: line}); // the header above the first entry
        return;
      }
      const f = line.match(/^- ([^:]+):(.*)$/s);
      if (f && FIELDS.includes(f[1])) {
        field = f[1];
        if (field in entry.parts) problem(n, `${entry.label}: "${field}" appears twice`);
        else if (Object.keys(entry.parts).some((k) => FIELDS.indexOf(k) > FIELDS.indexOf(field)))
          problem(n, `${entry.label}: "${field}" is out of order (${FIELDS.join(', ')})`);
        entry.parts[field] = [f[2].trim()];
        entry.lines.push({n, field, text: f[2].trim()});
      } else if (/^\s+\S/.test(line) && field) {
        // A lint-ignore line is a setting for --lint, not part of the field's
        // text, so a lookup doesn't print it. An older copy of this script
        // reads it as an ordinary continuation.
        if (/^\s+<!--\s*lint-ignore\b/.test(line)) entry.ignores.push({n, text: line.trim()});
        else {
          entry.parts[field].push(line.trim());
          entry.lines.push({n, field, text: line.trim()});
        }
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
        problem(0, () => `PLAYBOOK.md line ${section.line}, "${section.label}": From: names ${label(key)}, which is not a lesson promoted to this section`, {
          file: 'PLAYBOOK.md',
          line: section.line,
          rule: 'from-mismatch',
        });
    }
  }

  const count = (s) => entries.filter((e) => e.status === s).length;
  const totals = `${entries.length} lessons: ${count('open')} open, ${count('promoted')} promoted, ${count('closed')} closed`;
  const lessonsText = lessons.lines.join('\n');
  return {root, sections, entries, byKey, bad, badCount, items, totals, rows, header, settings: settingsOf(header), lessonsTokens: tokens(lessonsText)};
}

// The settings in LESSONS.md's header: the rule files --lint reads and the
// token budgets, with what was wrong with them.
function settingsOf(header) {
  const budget = {...BUDGET};
  let ruleFiles = null; // null: none named, so the defaults
  const problems = [];
  for (const {n, text} of header) {
    let m;
    if ((m = text.match(/^Rule files:(.*)$/s))) {
      ruleFiles = ruleFiles || [];
      for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        if (ruleFiles.length >= MAX_RULE_FILES) {
          problems.push({line: n, text: `Rule files: past the limit of ${MAX_RULE_FILES} files, ${label(name)} is not read`});
          break;
        }
        if (!isFileName(name) && !/^[A-Za-z0-9._-]+$/.test(name)) problems.push({line: n, text: `Rule files: ${label(name)} is not a path in the repo (letters, digits, . _ - and /, no .. part)`});
        else ruleFiles.push(name);
      }
    } else if ((m = text.match(/^Budget:(.*)$/s))) {
      for (const part of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        const b = part.match(/^(lookup|all|lessons|section) (\d{1,9})$/);
        if (b) budget[b[1]] = Number(b[2]);
        else problems.push({line: n, text: `Budget: ${label(part)} is not one of lookup, all, lessons or section with a number of tokens`});
      }
    }
  }
  return {budget, ruleFiles, problems};
}

// --stale. A file name in an Evidence field is text in backticks with no space,
// made only of ASCII letters, digits, '.', '_', '-' and '/', that holds a '/' or
// ends in an extension that starts with a letter (`.gitattributes`,
// `src/app.ts`), with no empty, '.' or '..' part. `, search "text"` right after
// it names text the file should still hold. The name is looked up under the
// repo root one part at a time, and a link anywhere on the way is not followed.
// A junction to a volume path is a plain folder to lstat, so the file's real path
// must also start with the root's real path, exactly, and go on with the name,
// with only ASCII case ignored and only on Windows and macOS: full case folding
// would match the Kelvin sign to "k", where NTFS keeps two folders apart. Only a
// regular file of at most MAX_SEARCH bytes with one hard link is read, to search
// it for text of at most MAX_QUOTE UTF-16 units (a longer one would make the
// search slow), and its text is never printed. Backticks pair left to right, as
// in Markdown, so a span with a space in it (a command) doesn't shift the pairs.
// Git's own names hold a '/' but name no file: the line endings `git ls-files
// --eol` prints (`w/crlf`, `i/lf`), and a ref such as `origin/HEAD` or
// `refs/heads/main` with no extension that starts with a letter.
const EVIDENCE_REF = /`([^`]*)`(?:,? search "([^"]+)")?/g;
const GIT_NAME = /^(?:[iw]\/(?:lf|crlf|mixed|none|-text)|(?:origin|upstream|refs\/(?:heads|tags|remotes))\/[A-Za-z0-9._/-]+)$/;
function isFileName(name) {
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  const extension = /\.[A-Za-z][A-Za-z0-9]*$/.test(name);
  if (!extension && (!name.includes('/') || GIT_NAME.test(name))) return false;
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
const foldAscii = (p) => (/^(win32|darwin)$/.test(process.platform) ? p.replace(/[A-Z]/g, (c) => c.toLowerCase()) : p);
// A finder of file names under `root`, with its own cache: a file name ->
// {problem} or {stat, path}.
function finder(root) {
  const looked = new Map();
  let rootReal; // the root's real path with a separator at the end, found once
  return (name) => {
    if (looked.has(name)) return looked.get(name);
    const parts = name.split('/');
    let found = null;
    let at = root;
    for (let k = 0; k < parts.length && !found; k++) {
      at = join(at, parts[k]);
      let stat;
      try {
        stat = lstatSync(at, {bigint: true});
      } catch {
        found = {problem: 'no such file'};
        break;
      }
      if (stat.isSymbolicLink()) found = {problem: 'not checked: a symbolic link on the way'};
      else if (k < parts.length - 1 && !stat.isDirectory()) found = {problem: 'no such file'};
      else if (k === parts.length - 1) found = {stat, path: at};
    }
    if (found.path) {
      try {
        // With the separator at the end, so a sibling such as `repo2` doesn't
        // start with it; join adds none to a drive root's `C:\`, which has one.
        rootReal ??= join(realpathSync.native(root), 'x').slice(0, -1);
        const real = realpathSync.native(found.path);
        if (!real.startsWith(rootReal) || foldAscii(real.slice(rootReal.length)) !== foldAscii(join(...parts)))
          found = {problem: 'not checked: a link on the way leads elsewhere'};
      } catch (e) {
        // Only a file that is gone is missing; a real path the system won't give
        // (a folder that can't be listed) leaves the file unchecked.
        found = {problem: e.code === 'ENOENT' ? 'no such file' : 'not checked: its real path cannot be read'};
      }
    }
    looked.set(name, found);
    return found;
  };
}
// What is wrong with the file found for text the evidence says it holds, or ''.
function holds(found, text) {
  // Counted in UTF-16 units, as V8 counts a pattern: past about 250 its
  // substring search can turn about 100 times slower, so a limit in code points
  // (200 emoji are 400 units) would let that through.
  if (text.length > MAX_QUOTE) return `not searched: search text over ${MAX_QUOTE} UTF-16 units`;
  const {stat, path} = found;
  if (!stat.isFile()) return 'not searched: not a regular file';
  if (stat.nlink > 1n) return 'not searched: a file with a second hard link';
  if (stat.size > BigInt(MAX_SEARCH)) return `not searched: over ${MAX_SEARCH} bytes`;
  const got = readSame(path, stat, MAX_SEARCH);
  if (got.problem === 'changed') return 'not searched: it changed while it was read';
  if (got.problem === 'too big') return `not searched: over ${MAX_SEARCH} bytes`;
  if (got.problem) return 'not searched: cannot read it';
  return got.text.replace(/\r/g, '').includes(text) ? '' : `no longer holds "${label(text)}"`;
}

// The reports. Each takes a loaded log and returns the lines to print, not yet
// made safe to print: the command line passes each through show().

// --check: the problems and the counts, and whether any problem was found.
export function checkReport(log) {
  const lines = [...log.bad];
  if (log.badCount > MAX_BAD) lines.push(`BAD   ... and ${log.badCount - MAX_BAD} more, not printed`);
  lines.push(`${log.totals}; ${log.badCount} bad`);
  return {lines, ok: log.badCount === 0};
}

// No mode: the counts and the usage.
export function countsReport(log) {
  return [log.totals, USAGE];
}

// --all: every lesson with its status and rule.
export function allReport(log) {
  const lines = [];
  log.entries.slice(0, MAX_SHOWN).forEach((e) => lines.push(`[${e.fields.Status || '?'}] ${e.key}\n    ${e.fields['Rule going forward'] || ''}`));
  if (log.entries.length > MAX_SHOWN) lines.push(`... and ${log.entries.length - MAX_SHOWN} more lessons, not printed`);
  lines.push(`-- ${log.totals}`);
  return lines;
}

// --stale: leads, from the evidence of open and promoted lessons.
export function staleReport(log) {
  const look = finder(log.root);
  let reviewed = 0; // open and promoted lessons
  let refs = 0; // file names checked
  let over = 0; // file names past MAX_REFS, not checked
  let unnamed = 0; // lessons whose evidence names no file
  const leads = [];
  for (const e of log.entries) {
    if (e.status === 'closed') continue;
    reviewed++;
    let named = false;
    const notes = [];
    for (const m of (e.fields.Evidence || '').matchAll(EVIDENCE_REF)) {
      if (!isFileName(m[1])) continue;
      named = true;
      if (refs >= MAX_REFS) {
        over++;
        continue;
      }
      refs++;
      const found = look(m[1]);
      const wrong = found.problem || (m[2] === undefined ? '' : holds(found, m[2]));
      if (wrong) notes.push(`    \`${label(m[1])}\`: ${wrong}`);
    }
    if (!named) unnamed++;
    const where = e.status === 'promoted' ? `, promoted to PLAYBOOK "${label(e.section)}"` : '';
    if (notes.length) leads.push(`${e.date} "${e.label}"${where}\n${notes.join('\n')}`);
  }
  const lines = leads.slice(0, MAX_SHOWN);
  if (leads.length > MAX_SHOWN) lines.push(`... and ${leads.length - MAX_SHOWN} more lessons, not printed`);
  const past = over ? `, and ${over} more not checked (the limit is ${MAX_REFS})` : '';
  lines.push(`-- ${leads.length} of ${reviewed} open or promoted lessons have evidence to review; ${refs} file names checked${past}; ${unnamed} name no file`);
  lines.push('-- a lead, not a verdict: read the lesson, and close it only if its rule no longer holds');
  return lines;
}

// A lookup: the lessons with a word that starts with one of `words`, which are
// lower case.
export function lookupReport(log, words) {
  let shown = 0;
  const open = []; // matching open lessons with their rules
  const promoted = new Map(); // section -> how many matching lessons it holds
  const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const starts = words.map((w) => new RegExp(`(^|[^a-z0-9])${escape(w)}`));
  for (const e of log.entries) {
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
  const lines = items.slice(0, MAX_SHOWN);
  if (items.length > MAX_SHOWN) lines.push(`... and ${items.length - MAX_SHOWN} more, not printed: use more specific words`);
  lines.push(`-- ${shown} shown; ${log.totals}`);
  // Every session pays to read a lookup, so one past its budget says so.
  const size = tokens(lines.join('\n'));
  const budget = log.settings.budget.lookup;
  if (size > budget) lines.push(`-- size-budget: this lookup is about ${size} tokens, over its budget of ${budget}: use more specific words, and see node dev/lessons.mjs --lint`);
  return lines;
}

// The line every mode but --check ends with when the log has format problems.
export function problemsLine(log) {
  return log.badCount ? `lessons: the log has ${log.badCount} format problem(s): run node dev/lessons.mjs --check` : null;
}

// ---- --lint -----------------------------------------------------------------

// Each rule's severity. `format` and `from-mismatch` are --check's problems;
// they, `bad-ignore` and `unused-ignore` can't be silenced.
export const RULES = {
  'format': 'error',
  'from-mismatch': 'error',
  'stale-path': 'error', // a warning for evidence and rule files
  'stale-flag': 'error', // a warning for scripts other than dev/lessons.mjs
  'unopenable-evidence': 'error', // a warning for a path outside the repo
  'outside-rule': 'warning',
  'unsettled-label': 'warning',
  'suspicious-instruction': 'error', // a warning for the milder patterns
  'md-heading': 'warning',
  'md-steps': 'warning',
  'size-budget': 'warning',
  'bad-setting': 'warning',
  'bad-ignore': 'error',
  'unused-ignore': 'warning',
  // Leads, with --leads only.
  'dup-rule': 'warning',
  'second-sighting': 'warning',
  'promoted-drift': 'warning',
  'quoted-tool-output': 'warning',
  'unlabeled-claim': 'warning',
};
const FIXED = new Set(['format', 'from-mismatch', 'bad-ignore', 'unused-ignore']);

// Patterns. Each runs on one line of at most MAX_LINT_LINE characters, and none
// can backtrack past a line: the content rules cost linear time.
const SPAN = /`([^`\n]+)`/g; // backticks pair left to right, as in Markdown
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const TRANSCRIPT = /(?:\.claude[\\/]projects|\.codex[\\/]sessions|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl\b)/i;
// A Codex rollout file: a word with rollout- and, after it, .jsonl. Each word
// is tested on its own, so the cost stays linear in the line.
const isRollout = (line) =>
  line.split(/[\s`'"]+/).some((w) => {
    const at = w.search(/\brollout-/i);
    return at >= 0 && /\.jsonl\b/i.test(w.slice(at + 8));
  });
// A path only this machine has: a drive, a temp or mount folder, a home folder.
const LOCAL_PATH = /(?:^|[\s`'"(=])(?:[A-Za-z]:[\\/]|\/tmp\/|\/mnt\/|\/home\/|\/Users\/|~[\\/]|%(?:TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)%|\$env:(?:TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)\b|\$HOME\b)/i;
// A file in a user's own folders, such as a global CLAUDE.md or AGENTS.md.
const USER_FILE = /(?:^|[\s`'"(=])(?:~[\\/]|%(?:USERPROFILE|APPDATA|LOCALAPPDATA)%|\$env:(?:USERPROFILE|APPDATA|LOCALAPPDATA)\b|\$HOME[\\/]|[A-Za-z]:[\\/]Users[\\/]|\/home\/[^\s/]+\/|\/Users\/[^\s/]+\/)/i;
const LABEL = /\b(INFERRED|HYPOTHESIZED)\b/;
// Words that say an attempt to settle a label was made and what it showed.
// "not checked" or "never tested" is no attempt.
const ATTEMPT = /\b(?:did not reproduce|didn't reproduce|not reproduced|could not|couldn't)\b|(?<!\b(?:not|never|nor|no one|nobody|wasn't|weren't|isn't|hasn't|haven't|hadn't) )\b(?:tried|reproduced|checked|tested|measured|probed)\b|\btook \d/i;
const FETCH = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i;
const TO_SHELL = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|invoke-expression|python3?|node|pwsh|powershell)\b/gi;
const SUBSHELL_FETCH = /\b(?:bash|sh)\s+<\(\s*(?:curl|wget)\b|\b(?:iex|invoke-expression)\s*\(\s*(?:iwr|irm|invoke-webrequest|invoke-restmethod|\(?\s*new-object)\b/i;
const IGNORE_PREVIOUS = /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|other)\s+(?:instructions|rules|prompts|messages)\b/i;
const KEY_SHAPED = /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bxox[abprs]-[A-Za-z0-9-]{10,}/;
const AUTHORITY = /\b(?:user|operator|owner) (?:has )?(?:already )?(?:approved|authori[sz]ed|pre-?approved|pre-?authori[sz]ed)\b|\bpre-?authori[sz]ed\b|\b(?:system|admin(?:istrator)?|anthropic|openai)(?: team)? (?:says|said|requires|instructs|instructed)\b|\bdo not (?:tell|inform) the user\b|\bwithout telling the user\b/i;
const URL = /\bhttps?:\/\//i;
// The text of a finding with each key-shaped string replaced, so no message or
// reason prints one.
const unkeyed = (text) => text.replace(new RegExp(KEY_SHAPED.source, 'g'), '<not printed: shaped like a key>');
const CREDENTIAL = /(?:^|[\s`'"(=\\/])\.ssh\b|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws[\\/]credentials\b|(?:^|[\s`'"(=\\/])\.(?:netrc|npmrc|pypirc)\b|(?:^|[\s`'"(=\\/])\.env(?=$|[\s`'".,;:)])|\bcredentials\.json\b/i;
// The reason holds no "--", so text after the first --> makes the line bad.
const IGNORE = /^<!--\s*lint-ignore\s+([a-z-]+)\s*:\s*((?:(?!--).)*?)\s*-->$/;
const IGNORE_START = /^\s*<!--\s*lint-ignore\b/;

// The rule files --lint reads: those named in the header, or CLAUDE.md and
// AGENTS.md at the root when there are any. Each is looked up as --stale looks
// up a file and read through one handle. Returns {files, problems}.
function ruleFiles(log, look) {
  const {ruleFiles: named, problems} = log.settings;
  const files = [];
  const out = problems.map((p) => ({...p}));
  const names = named || ['CLAUDE.md', 'AGENTS.md'];
  for (const name of names) {
    if (name === 'LESSONS.md' || name === 'PLAYBOOK.md') continue;
    const found = look(name);
    if (found.problem) {
      if (named) out.push({line: 0, text: `Rule files: ${label(name)}: ${found.problem}`});
      continue;
    }
    const {stat, path} = found;
    let why = '';
    if (!stat.isFile()) why = 'not a regular file';
    else if (stat.nlink > 1n) why = 'a file with a second hard link';
    else if (stat.size > BigInt(MAX_RULE_BYTES)) why = `over ${MAX_RULE_BYTES} bytes`;
    let text = null;
    if (!why) {
      const got = readSame(path, stat, MAX_RULE_BYTES);
      if (got.problem) why = got.problem === 'too big' ? `over ${MAX_RULE_BYTES} bytes` : got.problem === 'changed' ? 'it changed while it was read' : 'cannot read it';
      else text = got.text;
    }
    if (why) out.push({line: 0, text: `Rule files: ${label(name)}: not read: ${why}`});
    else {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      files.push({name, lines: text.replace(/\r/g, '').split('\n')});
    }
  }
  return {files, problems: out};
}

// The flags a command in backticks gives a script in the repo, checked against
// the script's own text: for dev/lessons.mjs (any lessons.mjs), the flags in its
// USAGE line; for another .mjs, .js or .cjs, the flag as it is written; for a
// .ps1, its parameter as $Name. Each script is read once and each flag looked
// for once; a new script or flag counts against MAX_LINT_REFS. Returns
// [{flag, script, strict}] for each flag the script doesn't know.
function unknownFlags(span, ctx) {
  const words = span.split(/\s+/);
  const out = [];
  for (let k = 0; k < words.length; k++) {
    const script = words[k];
    const kind = script.match(/\.(mjs|js|cjs|ps1)$/)?.[1];
    if (!kind || !script.includes('/') || !isFileName(script)) continue;
    if (!ctx.texts.has(script)) {
      if (ctx.refs >= MAX_LINT_REFS) {
        ctx.unchecked++;
        break;
      }
      ctx.refs++;
      const found = ctx.look(script);
      let text = null;
      if (!found.problem && found.stat.isFile() && found.stat.nlink === 1n && found.stat.size <= BigInt(MAX_SEARCH)) {
        const got = readSame(found.path, found.stat, MAX_SEARCH);
        if (!got.problem) text = got.text;
      }
      const usage = text !== null && /(^|\/)lessons\.mjs$/.test(script) ? (text.match(/const USAGE =\s*'([^'\n]*)'/)?.[1] ?? null) : null;
      ctx.texts.set(script, {text, usage, flags: new Map()});
    }
    const {text, usage, flags} = ctx.texts.get(script);
    if (text === null) break;
    for (let j = k + 1; j < words.length; j++) {
      const w = words[j];
      if (/^(?:\||;|&&|\|\||>|2>|<)/.test(w)) break;
      if (!/^-{1,2}[A-Za-z][A-Za-z0-9-]*(?:=.*)?$/s.test(w)) continue;
      const flag = w.replace(/=.*$/s, '');
      if (!flags.has(flag)) {
        if (ctx.refs >= MAX_LINT_REFS) {
          ctx.unchecked++;
          continue;
        }
        ctx.refs++;
        let known;
        if (usage !== null) known = new RegExp(`(?:^|[^A-Za-z0-9-])${flag}(?![A-Za-z0-9-])`).test(usage);
        else if (kind === 'ps1') known = new RegExp(`\\$${flag.replace(/^-+/, '')}(?![A-Za-z0-9_])`, 'i').test(text);
        else known = text.includes(flag);
        flags.set(flag, known);
      }
      if (!flags.get(flag)) out.push({flag, script, strict: usage !== null});
    }
    break;
  }
  return out;
}

// The findings of the content rules on one line of text. `where` says which
// file and what kind of line it is: a lesson's field (with `field`), a
// playbook line or a rule file's line.
function contentFindings(text, where, ctx) {
  const out = [];
  const add = (rule, message, severity = RULES[rule]) => out.push({rule, severity, message});
  const line = text.length > MAX_LINT_LINE ? text.slice(0, MAX_LINT_LINE) : text;
  const evidence = where.field === 'Evidence';
  const why = where.field === 'Why' || where.field === 'What went wrong';
  const instruction = where.kind !== 'lesson' || where.field === 'Rule going forward';
  // Files and flags named in backticks; not in a lint-ignore line's reason.
  for (const m of where.comment ? [] : line.matchAll(SPAN)) {
    const span = m[1];
    if (instruction) {
      for (const bad of unknownFlags(span, ctx))
        add('stale-flag', `\`${label(bad.script)}\` has no flag ${label(bad.flag)}${bad.strict ? ' in its usage line' : ''}`, bad.strict ? 'error' : 'warning');
      for (const word of span.split(/\s+/)) {
        if (!word.includes('/') || !isFileName(word)) continue;
        if (ctx.refs >= MAX_LINT_REFS) {
          ctx.unchecked++;
          continue;
        }
        ctx.refs++;
        if (ctx.look(word).problem === 'no such file')
          add('stale-path', `names \`${label(word)}\`, which is not in the repo`, where.kind === 'rule-file' ? 'warning' : 'error');
      }
    }
  }
  if (evidence) {
    if (TRANSCRIPT.test(line) || UUID.test(line) || isRollout(line)) add('unopenable-evidence', 'names a session transcript or session id, which another reader can\'t open: name a file in the repo, a commit or a log line instead');
    else if (LOCAL_PATH.test(line)) add('unopenable-evidence', 'names a path outside the repo, which only this machine can open', 'warning');
  }
  if (KEY_SHAPED.test(line)) add('suspicious-instruction', 'holds text shaped like a secret key or token (not printed here)');
  if (instruction && USER_FILE.test(line)) add('outside-rule', 'names a file in a user\'s own folders, which a session in this repo may never load: say the rule here');
  // A label the field also says was tried ("took 0.11 s, so the hang did not
  // reproduce") is reported as it should be.
  if (where.kind === 'lesson' && (why || where.field === 'Rule going forward') && LABEL.test(line) && !where.attempted)
    add('unsettled-label', `holds ${line.match(LABEL)[1]}: settle it (CONFIRMED or RULED OUT), or say what was tried and why it stopped`);
  if (instruction) {
    let piped = false;
    const fetchAt = line.search(FETCH);
    if (fetchAt >= 0) for (const m of line.matchAll(TO_SHELL)) if (m.index > fetchAt) piped = true;
    if (piped || SUBSHELL_FETCH.test(line)) add('suspicious-instruction', 'runs what it downloads (a fetch piped to a shell): a rule may not install or run code from the network');
    if (IGNORE_PREVIOUS.test(line)) add('suspicious-instruction', 'tells a session to ignore earlier instructions');
    if (AUTHORITY.test(line)) add('suspicious-instruction', 'claims approval or authority: approval comes from the user in the session, not from a rule', 'warning');
    if (CREDENTIAL.test(line)) add('suspicious-instruction', 'names a credential file: a rule may not read credentials', 'warning');
    if (where.kind !== 'rule-file' && URL.test(line)) add('suspicious-instruction', 'names a web address: a rule that fetches from the network is reported to the user, not followed', 'warning');
  }
  return out;
}

// Markdown structure: headings that skip a level, and numbered steps that skip
// or repeat a number. `rows` are {n, text, fence}.
function structureFindings(rows) {
  const out = [];
  let level = 0;
  let step = 0; // the last number in the list going on, or 0
  for (const {n, text, fence} of rows) {
    if (fence) {
      step = 0;
      continue;
    }
    // A lint-ignore line belongs to the line after it: it doesn't end a list.
    if (IGNORE_START.test(text)) continue;
    const h = text.match(/^(#{1,6}) /);
    if (h) {
      if (level && h[1].length > level + 1) out.push({n, rule: 'md-heading', message: `a level ${h[1].length} heading after a level ${level} one skips a level`});
      level = h[1].length;
      step = 0;
      continue;
    }
    const s = text.match(/^(\d{1,9})\. /);
    if (s) {
      const k = Number(s[1]);
      if (step && k !== step + 1) out.push({n, rule: 'md-steps', message: `step ${k} follows step ${step}`});
      step = k;
    } else if (text.trim() !== '' && !/^\s/.test(text)) step = 0;
  }
  return out;
}

// The lint-ignore lines of a file whose comments cover the next line that
// isn't blank: {n, target, text}.
function lineIgnores(rows) {
  const out = [];
  let pending = [];
  for (const {n, text, fence} of rows) {
    if (!fence && IGNORE_START.test(text)) {
      pending.push({n, text: text.trim()});
      continue;
    }
    if (text.trim() === '') continue;
    for (const p of pending) out.push({...p, target: n});
    pending = [];
  }
  for (const p of pending) out.push({...p, target: 0});
  return out;
}

// ---- Leads: --leads and --pairs ----------------------------------------------

// These rules compare the words of rules and steps, so they are leads, never
// verdicts: they run only with --leads, and are warnings. --pairs uses the
// same words to list rule pairs that may pull against each other.
const LEADS = new Set(['dup-rule', 'second-sighting', 'promoted-drift', 'quoted-tool-output', 'unlabeled-claim']);
const MAX_ITEMS = 600; // rules and steps compared by --pairs, and lessons and steps by --leads
const MAX_ITEM_WORDS = 128; // topic words, word pairs and spans kept for one rule or step
const MAX_PAIRS = 40; // pairs printed by --pairs
const MAX_SHARED = 8; // shared words named in one message or pair
const LEAD_SCORE = 5; // the least overlap score for dup-rule and second-sighting
const LEAD_RATIO = 0.22; // and the least score for the two texts' sizes
// Words too common to say what a rule is about. Topic words have 4 letters or
// more, so shorter words need no place here.
const STOP = new Set(
  'about above after again also always another because been before being below between both cannot could does done down during each either else even ever every first from have having here into just less like made make many more most much must never next none nothing once only onto other over same should since some such than that their them then there these they this those though through under unless until upon very were what when where whether which while will with within without would your says said'.split(' '),
);
// A word's stem: a plural, -ing, -ed and a final e taken off, so "measures",
// "measured" and "measuring" are one word.
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length >= 6 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length >= 5 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length >= 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}
const NEGATOR = new Set(['not', 'no', 'never', 'nor', 'without', 'cannot', "don't", "doesn't", "didn't", "isn't", "aren't", "won't", "can't", "shouldn't", "mustn't"]);
// The negators that forbid, not describe: "don't", "never", "no", "nor", and
// "not" after do, must or should. Only these cover a word; "it didn't check"
// says what happened, not what to do.
const FORBID = new Set(['no', 'never', 'nor', "don't", "shouldn't", "mustn't"]);
const FORBID_NOT = new Set(['do', 'must', 'should']);
// A negator covers the first topic word after it, within two other words, and
// a list that goes on from that word with a comma, "or", "and" or "nor" ("no
// sleep, retry or skip").
const NEG_REACH = 2;
// One token: a span in backticks, a word, a mark that ends a clause, or a
// comma. Each alternative reads forward only, so a line is read once.
// The curly quotes are made from their codes, as the hidden characters above are.
const RSQUO = String.fromCharCode(0x2019);
const LDQUO = String.fromCharCode(0x201c);
const RDQUO = String.fromCharCode(0x201d);
const TOKEN = new RegExp("`([^`\\n]+)`|([A-Za-z0-9]+(?:['" + RSQUO + "][A-Za-z]+)?)|([.;:!?])|(,)", 'g');
const ONE_AT_A_TIME = /\bone at a time\b|\bone by one\b/i;
const AT_ONCE = /\b(?:all at once|at once|together|in parallel)\b|\ball\b/i;

// What a rule or step is about: its topic words (stem -> the word as written),
// the pairs of topic words next to each other, its spans in backticks
// (normalized -> as written; a <placeholder> is dropped), the commands among
// them with the topic word before each, the words a negator covers, the
// topic words of each clause that holds a negator, and the cue words it holds.
// Reads at most MAX_LINT_LINE characters, and keeps at most MAX_ITEM_WORDS of
// each kind, so comparing two of them costs at most that much.
// Text shaped like a key is removed first, so no part of it becomes a topic
// word that a lead or a pair prints: `ghp_` and its payload are split by the
// tokens, and unkeyed() can't find a payload without its prefix. A private key
// goes from its BEGIN line to its END line, or to the end of the text. The text
// is cut to MAX_LINT_LINE first, so the search stays linear; a key that the cut
// leaves without its end (too short to be key-shaped) goes from its prefix on.
const KEYS = new RegExp(KEY_SHAPED.source, 'g');
const PEM_BLOCK = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[^]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g;
const KEY_PREFIX = /\b(?:ghp_|github_pat_|sk-|AKIA|xox[abprs]-)/;
function topicOf(text) {
  let line = text;
  if (text.length > MAX_LINT_LINE) {
    line = text.slice(0, MAX_LINT_LINE);
    // The last word, found from the end so a long one costs its length once.
    let k = line.length;
    while (k > 0 && !/[\s`]/.test(line[k - 1])) k--;
    const at = line.slice(k).search(KEY_PREFIX);
    if (at >= 0) line = `${line.slice(0, k + at)} `;
  }
  line = line.replace(PEM_BLOCK, ' ').replace(KEYS, ' ');
  const t = {words: new Map(), pairs: new Set(), spans: new Map(), commands: new Map(), negated: new Map(), negClauses: [], negator: false};
  let prev = null; // the last topic stem, for word pairs
  let verb = null; // the last topic stem in this clause, for a command's verb
  // A negator's reach: 0 none; 1 waiting for its first topic word, with `reach`
  // other words left; 2 just after a word it covers, where a comma, "or" or
  // "and" goes on to 3, which covers the next topic word too.
  let neg = 0;
  let reach = 0;
  let negWord = '';
  let clause = new Set();
  let clauseNeg = false;
  // "must", "before" or "after", waiting for the topic word it governs, with
  // `leadReach` other words left.
  let lead = null;
  let leadReach = 0;
  let last = ''; // the word before, lower case
  const governed = {must: new Map(), before: new Map(), after: new Map()};
  let never = false;
  let always = false;
  const endClause = () => {
    if (clauseNeg && clause.size && t.negClauses.length < MAX_ITEM_WORDS) t.negClauses.push(clause);
    clause = new Set();
    clauseNeg = false;
    prev = null;
    verb = null;
    neg = 0;
    lead = null;
  };
  for (const m of line.matchAll(TOKEN)) {
    if (m[3]) {
      endClause();
      continue;
    }
    if (m[4]) {
      if (neg === 2) {
        neg = 3;
        reach = NEG_REACH;
      }
      continue;
    }
    if (m[1] !== undefined) {
      prev = null;
      neg = 0;
      lead = null;
      const n = m[1].replace(/<[^<>\n]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (n.length < 2 || t.spans.size >= MAX_ITEM_WORDS) continue;
      if (!t.spans.has(n)) t.spans.set(n, m[1]);
      // A command: a span with a space whose first word is a program, not a flag.
      const program = n.includes(' ') ? n.split(' ')[0] : '';
      if (verb && program && !program.startsWith('-')) {
        if (!t.commands.has(verb)) t.commands.set(verb, new Set());
        t.commands.get(verb).add(program);
      }
      continue;
    }
    const lower = m[2].toLowerCase().replace(RSQUO, "'");
    const before = last;
    last = lower;
    if (NEGATOR.has(lower)) {
      t.negator = true;
      clauseNeg = true;
      const forbids = FORBID.has(lower) || (lower === 'not' && FORBID_NOT.has(before));
      neg = forbids ? 1 : 0;
      reach = NEG_REACH;
      negWord = lower === 'not' ? `${before} not` : lower;
      lead = null; // "must not" is a negator's
      if (lower === 'never') never = true;
      continue;
    }
    if (lower === 'always') always = true;
    if (lower === 'must' || lower === 'before' || lower === 'after') {
      lead = lower;
      leadReach = NEG_REACH;
      continue;
    }
    const w = lower.endsWith("'s") ? lower.slice(0, -2) : lower;
    if (w.length < 4 || w.includes("'") || /^\d+$/.test(w) || STOP.has(w)) {
      if (neg === 2 && (lower === 'or' || lower === 'and')) {
        neg = 3;
        reach = NEG_REACH;
      } else if (neg === 2) neg = 0;
      else if (neg && --reach < 0) neg = 0;
      if (lead && --leadReach < 0) lead = null;
      continue;
    }
    const covered = neg === 1 || neg === 3;
    neg = covered ? 2 : 0;
    const s = stem(w);
    if (lead) {
      if (!governed[lead].has(s) && governed[lead].size < MAX_ITEM_WORDS) governed[lead].set(s, w);
      lead = null;
    }
    if (t.words.size < MAX_ITEM_WORDS && !t.words.has(s)) t.words.set(s, w);
    if (prev && prev !== s && t.pairs.size < MAX_ITEM_WORDS) t.pairs.add(`${prev} ${s}`);
    prev = s;
    verb = s;
    if (clause.size < MAX_ITEM_WORDS) clause.add(s);
    if (covered && !t.negated.has(s) && t.negated.size < MAX_ITEM_WORDS) t.negated.set(s, `${negWord} ${w}`);
  }
  endClause();
  t.must = governed.must;
  t.before = governed.before;
  t.after = governed.after;
  t.never = never;
  t.always = always;
  t.oneAtATime = ONE_AT_A_TIME.test(line);
  t.atOnce = t.oneAtATime ? '' : (line.match(AT_ONCE)?.[0] || '').toLowerCase();
  return t;
}

// The overlap of two topics: shared words (as the first text writes them), how
// many word pairs and spans they share, and a score: one for a word, two for a
// word pair or a span. Costs at most the smaller topic's size.
function overlap(a, b) {
  const [sa, sb] = a.words.size <= b.words.size ? [a, b] : [b, a];
  const shared = [];
  for (const s of sa.words.keys()) if (sb.words.has(s)) shared.push(a.words.get(s));
  let pairs = 0;
  const [pa, pb] = a.pairs.size <= b.pairs.size ? [a.pairs, b.pairs] : [b.pairs, a.pairs];
  for (const p of pa) if (pb.has(p)) pairs++;
  const spans = [];
  const [xa, xb] = a.spans.size <= b.spans.size ? [a.spans, b.spans] : [b.spans, a.spans];
  for (const [n, written] of xa) if (xb.has(n)) spans.push(written);
  const score = shared.length + 2 * pairs + 2 * spans.length;
  const ratio = score / Math.sqrt(Math.max(1, a.words.size) * Math.max(1, b.words.size));
  return {shared, pairs, spans, score, ratio};
}
const similar = (o) => o.score >= LEAD_SCORE && o.ratio >= LEAD_RATIO;
// Shared words and spans as a message gives them.
function sharedText(o) {
  const words = o.shared.slice(0, MAX_SHARED);
  const more = o.shared.length > MAX_SHARED ? ` and ${o.shared.length - MAX_SHARED} more` : '';
  const spans = o.spans.slice(0, MAX_SHARED).map((s) => `\`${label(s)}\``);
  return [...words, ...spans].join(', ') + more;
}

// The numbered steps of PLAYBOOK.md, outside code blocks and inside a section,
// each with the indented lines that go on from it: {line, n, section, text}.
function playbookSteps(log) {
  const steps = [];
  let last = null;
  for (const r of log.rows) {
    if (r.fence) {
      last = null;
      continue;
    }
    // A lint-ignore line belongs to the line after it, as in md-steps: it is
    // not part of a step's text, and the step goes on past it.
    if (IGNORE_START.test(r.text)) continue;
    const m = r.text.match(/^(\d{1,9})\. (.*)$/s);
    if (m && r.section) {
      last = {line: r.n, n: m[1], section: r.section, parts: [m[2]]};
      steps.push(last);
    } else if (last && /^\s+\S/.test(r.text)) last.parts.push(r.text.trim());
    else last = null;
  }
  return steps.map(({parts, ...s}) => ({...s, text: parts.join(' ')}));
}

// Pasted tool output in Evidence. Each pattern's repeats are bounded, so none
// can backtrack past a line or cost more than linear time.
const STACK_FRAME = /\bat [\w.$<>]{1,200} \([^\s()]{1,400}:\d{1,9}:\d{1,9}\)|\bFile "[^"\n]{1,400}", line \d{1,9}/;
const TRACEBACK = /\bTraceback\b/;
const ERROR_LINE = /^(?:[A-Z][A-Za-z]{0,40})?[Ee]rror:/;
// Straight quotes pair left to right, as backticks do, so the text between
// one quote's end and the next one's start is not taken for a quote. A curly
// quote runs from the first opening quote after the last closing one, so a
// second opening quote inside it doesn't end it. One pass each: linear time.
function longQuote(line) {
  let open = -1;
  for (let i = line.indexOf('"'); i >= 0; i = line.indexOf('"', i + 1)) {
    if (open < 0) open = i;
    else {
      if (i - open - 1 > 200) return true;
      open = -1;
    }
  }
  open = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === LDQUO) {
      if (open < 0) open = i;
    } else if (c === RDQUO) {
      if (open >= 0 && i - open - 1 > 200) return true;
      open = -1;
    } else if (c === '\n') open = -1;
  }
  return false;
}
function pastedOutput(text) {
  const line = text.length > MAX_LINT_LINE ? text.slice(0, MAX_LINT_LINE) : text;
  if (STACK_FRAME.test(line)) return 'a stack frame';
  if (TRACEBACK.test(line)) return 'a Traceback';
  if (ERROR_LINE.test(line)) return 'a line that starts with an error';
  if (longQuote(line)) return 'a quote over 200 characters';
  for (const m of line.matchAll(SPAN)) if (m[1].length > 200) return 'a span in backticks over 200 characters';
  return '';
}
// A Why that names a cause.
const CAUSE = /\b(?:because|caused by|due to|the cause was|the reason was)\b/i;
const ANY_LABEL = /\b(?:CONFIRMED|INFERRED|HYPOTHESIZED|RULED OUT)\b/;

// The lead findings of a loaded log: {line, f, entry}, all in LESSONS.md.
function leadFindings(log) {
  const out = [];
  const add = (line, rule, message, entry) => out.push({line, f: {rule, message}, entry});
  const fieldLine = (e, field) => e.lines.find((l) => l.field === field)?.n ?? e.line;
  const open = log.entries.filter((e) => e.status === 'open').slice(0, MAX_ITEMS);
  const rules = open.map((e) => ({e, line: fieldLine(e, 'Rule going forward'), t: topicOf(e.fields['Rule going forward'] || '')}));
  const allSteps = playbookSteps(log);
  const steps = allSteps.slice(0, MAX_ITEMS).map((s) => ({...s, t: topicOf(s.text)}));

  // dup-rule: the step closest to each open lesson's rule, if close enough.
  for (const r of rules) {
    let best = null;
    for (const s of steps) {
      const o = overlap(r.t, s.t);
      if (similar(o) && (!best || o.ratio > best.o.ratio)) best = {s, o};
    }
    if (best)
      add(r.line, 'dup-rule', `its rule shares ${sharedText(best.o)} with PLAYBOOK "${best.s.section.label}" step ${best.s.n}: if the step covers it, promote the lesson there (the lessons check, step 5). A lead, not a verdict`, r.e);
  }

  // second-sighting: two open lessons whose rules overlap, on the newer one.
  // The log is newest first, so of two on one date the newer is higher up.
  // One finding per lesson, naming the closest older one and counting the
  // rest, so many similar lessons give at most one finding each.
  const sightings = new Map(); // rules index of the newer -> {older, o, count}
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++) {
      const o = overlap(rules[i].t, rules[j].t);
      if (!similar(o)) continue;
      const a = rules[i].e;
      const b = rules[j].e;
      const [newer, older] = a.date > b.date || (a.date === b.date && a.line < b.line) ? [i, j] : [j, i];
      const s = sightings.get(newer);
      if (!s) sightings.set(newer, {older, o, count: 1});
      else {
        s.count++;
        if (o.ratio > s.o.ratio) Object.assign(s, {older, o});
      }
    }
  for (const [newer, {older, o, count}] of [...sightings].sort((x, y) => x[0] - y[0])) {
    const more = count > 1 ? `, and ${count - 1} more open lesson${count > 2 ? 's' : ''}` : '';
    add(rules[newer].line, 'second-sighting', `its rule overlaps the open lesson ${label(rules[older].e.key)} (${sharedText(o)})${more}: promote them into one step (the lessons check, step 5). A lead, not a verdict`, rules[newer].e);
  }

  // promoted-drift. A promoted step is short, and its lessons keep the details
  // (the lessons check, step 5), so a lesson's terms missing from its section
  // are by design. What this finds instead is a promoted lesson whose title
  // and rule share no topic word and no span with its section's heading and
  // steps: it looks filed in the wrong section. Each section's topic words and
  // spans are gathered once, from its heading and all its steps (not only the
  // first MAX_ITEMS), so a lesson costs time in its own words only.
  const sectionTopics = new Map(); // section -> {words, spans}
  const topicsOf = (section) => {
    if (!sectionTopics.has(section)) {
      const t = topicOf(section.name);
      sectionTopics.set(section, {words: new Set(t.words.keys()), spans: new Set(t.spans.keys())});
    }
    return sectionTopics.get(section);
  };
  allSteps.forEach((s, k) => {
    const t = k < steps.length ? steps[k].t : topicOf(s.text);
    const u = topicsOf(s.section);
    for (const w of t.words.keys()) u.words.add(w);
    for (const n of t.spans.keys()) u.spans.add(n);
  });
  for (const e of log.entries) {
    if (e.status !== 'promoted') continue;
    const section = log.sections.get(e.section);
    if (!section) continue; // from-mismatch reports it
    const own = topicOf(`${e.title}. ${e.fields['Rule going forward'] || ''}`);
    const u = topicsOf(section);
    const apart = ![...own.words.keys()].some((w) => u.words.has(w)) && ![...own.spans.keys()].some((n) => u.spans.has(n));
    if (apart)
      add(e.line, 'promoted-drift', `promoted to "${section.label}", but its title and rule share no topic word or span with that section's heading and steps: check that it is filed in the right section. A lead, not a verdict`, e);
  }

  for (const e of log.entries) {
    if (e.status === 'closed') continue;
    // quoted-tool-output: Evidence, for open and promoted lessons.
    for (const l of e.lines) {
      if (l.field !== 'Evidence') continue;
      const what = pastedOutput(l.text);
      if (what) {
        add(l.n, 'quoted-tool-output', `Evidence holds pasted tool output (${what}): name the file, the command or the log line that shows it instead. A lead, not a verdict`, e);
        break;
      }
    }
    // unlabeled-claim: a cause in an open lesson's Why, with no label and no
    // word of what was tried.
    if (e.status !== 'open') continue;
    const why = e.fields.Why || '';
    const cause = why.match(CAUSE);
    if (cause && !ANY_LABEL.test(why) && !ATTEMPT.test(why))
      add(fieldLine(e, 'Why'), 'unlabeled-claim', `its Why states a cause ("${cause[0].toLowerCase()}") with no label (CONFIRMED, INFERRED, HYPOTHESIZED or RULED OUT) and no word of what was tried. A lead, not a verdict`, e);
  }
  return out;
}

// --pairs: rule pairs that share a topic and may pull in opposite directions,
// for a model to review. Items are open lessons' rules, PLAYBOOK steps, and
// the lines of rule files that read as rules (a list item, or a line with
// must, never, always, don't or do not). A pair is a candidate when the two
// share two or more topic words or the same command in backticks, and a cue
// says they pull apart. A pair's score is its overlap score plus 10 for each
// point of its cue's weight (3, 2 or 1), so a strong cue ranks first.
// Strongest first, and of two with one score, the one found first.
// The overlap score (shared topic words, and 2 for each shared word pair or
// span) two texts need before a weak cue (weight 1) makes them a pair.
const WEAK_SHARED = 4;
// The steps of this plugin's playbook template, each as the first 16 hex
// characters of the sha256 of its text, without its number, with each run of
// white space made one space. Its steps were written to agree, so two of them
// left unchanged are not a pair. A test keeps this list the same as the
// template's steps.
export const SHIPPED_STEPS = new Set([
  '571da1f9351a8b54', '382527a74578856c', '0aaef69d40705001', '74058ac1afb648eb', '5c01ab6599d2e5ae', '3e59ac7fbaa2e25f',
  '593310ba476f9a3c', '1723d7cd773a3a79', '777077b20da876e2', 'bf077e03e5a79af5', '98fe0333a5b322b7',
]);
export const stepKey = (text) => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
const RULE_LINE =/^\s*(?:[-*+]|\d{1,9}\.) |\b(?:must|never|always|don't|do not)\b/i;
// The cue between two topics, strongest first, as {weight, text}, or null.
function cueOf(a, b) {
  for (const [verb, programs] of a.commands) {
    const other = b.commands.get(verb);
    if (other && ![...programs].some((p) => other.has(p))) return {weight: 3, text: `two commands for "${a.words.get(verb) || verb}": \`${label([...programs][0])}\` and \`${label([...other][0])}\``};
  }
  if (a.oneAtATime && b.atOnce) return {weight: 3, text: `"one at a time" against "${b.atOnce}"`};
  if (b.oneAtATime && a.atOnce) return {weight: 3, text: `"${a.atOnce}" against "one at a time"`};
  if ((a.never && !a.always && b.always && !b.never) || (b.never && !b.always && a.always && !a.never)) return {weight: 3, text: '"never" against "always"'};
  // "must X" against "don't X", and "before X" against "after X".
  for (const [s, w] of a.must) if (b.negated.has(s)) return {weight: 2, text: `"must ${w}" against "${b.negated.get(s)}"`};
  for (const [s, w] of b.must) if (a.negated.has(s)) return {weight: 2, text: `"${a.negated.get(s)}" against "must ${w}"`};
  for (const [s, w] of a.before) if (b.after.has(s)) return {weight: 2, text: `"before ${w}" against "after ${b.after.get(s)}"`};
  for (const [s, w] of a.after) if (b.before.has(s)) return {weight: 2, text: `"after ${w}" against "before ${b.before.get(s)}"`};
  // A word one says not to do, and the other says plainly. Common words make
  // this cue fire often ("no tool" against "tool"), so it is a weak one: like
  // the next, it needs more shared words to count (WEAK_SHARED).
  for (const [s, said] of a.negated) if (b.words.has(s) && !b.negated.has(s)) return {weight: 1, text: `"${said}" against "${b.words.get(s)}"`};
  for (const [s, said] of b.negated) if (a.words.has(s) && !a.negated.has(s)) return {weight: 1, text: `"${a.words.get(s)}" against "${said}"`};
  // A clause with a negator that shares two topic words with a text that has none.
  const negClause = (x, y) =>
    !y.negator &&
    x.negClauses.some((c) => {
      let n = 0;
      for (const s of c) if (y.words.has(s) && ++n >= 2) return true;
      return false;
    });
  if (negClause(a, b) || negClause(b, a)) return {weight: 1, text: 'a "not" against a plain statement'};
  return null;
}
// Returns {pairs, candidates, items, over, ruleFiles}.
export function pairsReport(log) {
  const look = finder(log.root);
  const items = [];
  let total = 0;
  // `section` is a promoted lesson's section, or a step's own section: a
  // promoted lesson is not paired with its own section's steps, since step 3 of
  // "The lessons check" already says the step wins where they conflict.
  // `shipped` is a step left as the playbook template wrote it (SHIPPED_STEPS).
  const addItem = (file, line, text, section = null, shipped = false) => {
    total++;
    if (items.length < MAX_ITEMS) items.push({file, line, section, shipped, t: topicOf(text)});
  };
  // Open and promoted lessons: a promoted lesson's rule still gives its step's
  // details, so it is followed too.
  for (const e of log.entries)
    if (e.status !== 'closed') addItem('LESSONS.md', e.lines.find((l) => l.field === 'Rule going forward')?.n ?? e.line, e.fields['Rule going forward'] || '', e.status === 'promoted' ? e.section : null);
  for (const s of playbookSteps(log)) addItem('PLAYBOOK.md', s.line, s.text, s.section.name, SHIPPED_STEPS.has(stepKey(s.text)));
  const rules = ruleFiles(log, look);
  for (const file of rules.files) {
    let fence = false;
    file.lines.forEach((text, i) => {
      if (text.startsWith('```')) {
        fence = !fence;
        return;
      }
      if (fence || text.startsWith('#') || IGNORE_START.test(text) || text.trim() === '') return;
      if (RULE_LINE.test(text.length > MAX_LINT_LINE ? text.slice(0, MAX_LINT_LINE) : text)) addItem(file.name, i + 1, text);
    });
  }
  // Each item is compared only with the items it shares a topic word or a
  // command with, found through an index from each word to the items that
  // hold it, so items with nothing in common cost nothing.
  const words = new Map(); // stem -> indexes of the items before that hold it
  const commands = new Map(); // a command span -> the same
  const count = new Int32Array(items.length);
  const sameCommand = new Uint8Array(items.length);
  const touched = [];
  let candidates = 0;
  const best = []; // the strongest MAX_PAIRS, strongest first
  for (let i = 0; i < items.length; i++) {
    const it = items[i].t;
    for (const s of it.words.keys()) for (const j of words.get(s) || []) if (count[j]++ === 0 && !sameCommand[j]) touched.push(j);
    for (const n of it.spans.keys()) {
      if (!n.includes(' ')) continue;
      for (const j of commands.get(n) || []) {
        if (!sameCommand[j] && count[j] === 0) touched.push(j);
        sameCommand[j] = 1;
      }
    }
    for (const j of touched) {
      if (count[j] >= 2 || sameCommand[j]) {
        const a = items[j];
        // A promoted lesson and a step of its own section, where the step wins,
        // or two template steps left unchanged. Two lessons of one section are
        // compared: a detail the step doesn't mention still applies, from each.
        // Not a `continue`: count[j] and sameCommand[j] are reset below.
        const own = (a.shipped && items[i].shipped) || (a.section !== null && a.section === items[i].section && (a.file === 'LESSONS.md') !== (items[i].file === 'LESSONS.md'));
        const cue = own ? null : cueOf(a.t, it);
        const o = cue ? overlap(a.t, it) : null;
        // A weak cue counts only for two texts that share more of their topic:
        // shared words and word pairs, as the overlap score counts them.
        if (cue && (cue.weight > 1 || sameCommand[j] || o.score >= WEAK_SHARED)) {
          candidates++;
          const pair = {score: o.score + 10 * cue.weight, a: {file: a.file, line: a.line}, b: {file: items[i].file, line: items[i].line}, shared: o.shared.slice(0, MAX_SHARED), spans: o.spans.slice(0, MAX_SHARED), cue: cue.text};
          if (best.length < MAX_PAIRS || pair.score > best[best.length - 1].score) {
            let at = best.length;
            while (at > 0 && best[at - 1].score < pair.score) at--;
            best.splice(at, 0, pair);
            if (best.length > MAX_PAIRS) best.pop();
          }
        }
      }
      count[j] = 0;
      sameCommand[j] = 0;
    }
    touched.length = 0;
    for (const s of it.words.keys()) {
      if (!words.has(s)) words.set(s, []);
      words.get(s).push(i);
    }
    for (const n of it.spans.keys()) {
      if (!n.includes(' ')) continue;
      if (!commands.has(n)) commands.set(n, []);
      commands.get(n).push(i);
    }
  }
  return {pairs: best, candidates, items: items.length, over: total - items.length, ruleFiles: rules.files.map((f) => f.name)};
}
const pairWords = (p) => [...p.shared, ...p.spans.map((s) => `\`${label(s)}\``)].join(', ');
// --pairs as lines, not yet made safe to print: the command line passes each
// through show().
export function pairsLines(report) {
  const lines = report.pairs.map((p) => unkeyed(`PAIR ${p.score} ${label(p.a.file)}:${p.a.line} ${label(p.b.file)}:${p.b.line} ${pairWords(p)}; ${p.cue}`));
  if (report.over) lines.push(`-- pairs: past the limit of ${MAX_ITEMS} rules and steps, ${report.over} not compared`);
  lines.push(`-- pairs: ${report.candidates} candidate pair${report.candidates === 1 ? '' : 's'} among ${report.items} rules and steps, ${report.pairs.length} printed (at most ${MAX_PAIRS}); a lead for review, not a verdict`);
  return lines;
}
// --pairs --json: one object, its text made safe to print.
export function pairsJson(report) {
  const where = (w) => ({file: show(w.file, MAX_NAME), line: w.line});
  return JSON.stringify({
    version: VERSION,
    candidates: report.candidates,
    items: report.items,
    notCompared: report.over,
    pairs: report.pairs.map((p) => ({score: p.score, a: where(p.a), b: where(p.b), shared: p.shared.map((w) => show(w, MAX_NAME)), spans: p.spans.map((s) => show(unkeyed(s), MAX_NAME)), cue: show(unkeyed(p.cue))})),
    ruleFiles: report.ruleFiles.map((n) => show(n, MAX_NAME)),
  });
}

// Runs every rule on a loaded log. Returns {findings, silenced, errors,
// warnings, notes, sizes}. Findings are {file, line, rule, severity, message},
// in file and line order; a silenced one also has its reason. `leads` adds the
// lead rules (--leads).
export function lintReport(log, {leads = false} = {}) {
  const look = finder(log.root);
  const ctx = {look, texts: new Map(), refs: 0, unchecked: 0};
  // At most MAX_KEEP findings are kept; past that only the errors are counted.
  const found = []; // {file, line, rule, severity, message, entry}
  let dropped = 0;
  let droppedErrors = 0;
  const push = (file, line, f, entry = null) => {
    const severity = f.severity || RULES[f.rule];
    if (found.length >= MAX_KEEP) {
      dropped++;
      if (severity === 'error') droppedErrors++;
      return;
    }
    found.push({file, line, rule: f.rule, severity, message: unkeyed(f.message), entry});
  };

  // --check's problems.
  for (const it of log.items) push(it.file, it.line, {rule: it.rule, message: it.text.replace(/^PLAYBOOK\.md line \d+[:,] /, '')});
  const notes = [];
  if (log.badCount > MAX_BAD) notes.push(`${log.badCount - MAX_BAD} more format problems, not listed: run node dev/lessons.mjs --check`);

  // LESSONS.md: the fields of each lesson that isn't closed.
  const ignores = []; // {file, n, text, target, entry}
  // A promoted lesson's step is its rule's home, but the lesson's rule still
  // gives the step's details (PLAYBOOK "The lessons check", step 3): its rule
  // and its Evidence are read, not what went wrong or why.
  for (const e of log.entries) {
    for (const ig of e.ignores) {
      ignores.push({file: 'LESSONS.md', n: ig.n, text: ig.text, target: null, entry: e});
      for (const f of contentFindings(ig.text, {kind: 'playbook', comment: true}, ctx)) push('LESSONS.md', ig.n, f);
    }
    if (e.status === 'closed') continue;
    const attempted = new Map();
    for (const l of e.lines) {
      if (e.status !== 'open' && l.field !== 'Evidence' && l.field !== 'Rule going forward') continue;
      // Whether the field says what was tried, found once for each field.
      if (!attempted.has(l.field)) attempted.set(l.field, ATTEMPT.test(e.fields[l.field] || ''));
      for (const f of contentFindings(l.text, {kind: 'lesson', field: l.field, attempted: attempted.get(l.field)}, ctx)) push('LESSONS.md', l.n, f, e);
    }
  }
  // Evidence, as --stale reads it: file names, bare ones too, and search text.
  // Limited to MAX_REFS names, as --stale is.
  let refs = 0;
  for (const e of log.entries) {
    if (e.status === 'closed') continue;
    const at = e.lines.find((l) => l.field === 'Evidence')?.n ?? e.line;
    for (const m of (e.fields.Evidence || '').matchAll(EVIDENCE_REF)) {
      if (!isFileName(m[1])) continue;
      if (refs++ >= MAX_REFS) {
        ctx.unchecked++;
        continue;
      }
      const hit = look(m[1]);
      if (hit.problem === 'no such file') push('LESSONS.md', at, {rule: 'stale-path', severity: 'warning', message: `Evidence names \`${label(m[1])}\`, which is not in the repo: a lead, not a verdict`}, e);
      else if (!hit.problem && m[2] !== undefined) {
        const wrong = holds(hit, m[2]);
        if (wrong.startsWith('no longer')) push('LESSONS.md', at, {rule: 'stale-path', severity: 'warning', message: `Evidence: \`${label(m[1])}\` ${wrong}`}, e);
      }
    }
  }

  // The header's settings are fixed by changing them, not silenced.
  for (const h of log.header) if (IGNORE_START.test(h.text)) push('LESSONS.md', h.n, {rule: 'bad-ignore', message: 'a lint-ignore in LESSONS.md\'s header covers nothing: change the setting instead'});

  // PLAYBOOK.md.
  for (const r of log.rows) {
    const comment = !r.fence && IGNORE_START.test(r.text);
    for (const f of contentFindings(r.text, {kind: 'playbook', comment}, ctx)) push('PLAYBOOK.md', r.n, f);
  }
  for (const f of structureFindings(log.rows)) push('PLAYBOOK.md', f.n, f);
  ignores.push(...lineIgnores(log.rows).map((ig) => ({...ig, file: 'PLAYBOOK.md'})));

  // Rule files.
  const rules = ruleFiles(log, look);
  for (const p of rules.problems) push('LESSONS.md', p.line, {rule: 'bad-setting', message: p.text});
  for (const file of rules.files) {
    const rows = [];
    let fence = false;
    file.lines.forEach((text, i) => {
      const marker = text.startsWith('```');
      if (marker) fence = !fence;
      rows.push({n: i + 1, text, fence: fence || marker});
    });
    for (const r of rows) {
      const comment = !r.fence && IGNORE_START.test(r.text);
      if (hasHidden(r.text)) push(file.name, r.n, {rule: 'suspicious-instruction', message: 'holds a control or invisible character'});
      for (const f of contentFindings(r.text, {kind: 'rule-file', comment}, ctx)) push(file.name, r.n, f);
    }
    if (/\.md$/i.test(file.name)) for (const f of structureFindings(rows)) push(file.name, f.n, f);
    ignores.push(...lineIgnores(rows).map((ig) => ({...ig, file: file.name})));
  }

  // Sizes.
  const {budget} = log.settings;
  const allTokens = tokens(allReport(log).join('\n'));
  const sizes = {lessons: {tokens: log.lessonsTokens, budget: budget.lessons}, all: {tokens: allTokens, budget: budget.all}, sections: []};
  const advice = 'close lessons whose rules no longer hold, promote second sightings, and shorten Evidence';
  if (log.lessonsTokens > budget.lessons) push('LESSONS.md', 0, {rule: 'size-budget', message: `LESSONS.md is about ${log.lessonsTokens} tokens, over its budget of ${budget.lessons}: ${advice}`});
  if (allTokens > budget.all) push('LESSONS.md', 0, {rule: 'size-budget', message: `--all prints about ${allTokens} tokens, over its budget of ${budget.all}: ${advice}`});
  const bySection = new Map();
  for (const r of log.rows) if (r.section) bySection.set(r.section, (bySection.get(r.section) || 0) + Buffer.byteLength(r.text, 'utf8') + 1);
  for (const [section, bytes] of bySection) {
    const t = Math.ceil(bytes / 4);
    if (t > budget.section) {
      sizes.sections.push({name: section.name, line: section.line, tokens: t, budget: budget.section});
      push('PLAYBOOK.md', section.line, {rule: 'size-budget', message: `section "${section.label}" is about ${t} tokens, over its budget of ${budget.section}: split it, or move detail to a doc it points to`});
    }
  }

  // Silencing. A comment names a rule and a reason; it covers its entry (in
  // LESSONS.md) or the next line that isn't blank (elsewhere).
  const silenced = [];
  const kept = [];
  const valid = [];
  // A silencing comment's key: its file, its rule, and its entry's line (in
  // LESSONS.md) or the line it covers. The first comment for a key is used.
  const byTarget = new Map();
  const keyOf = (file, rule, at) => `${file}\n${rule}\n${at}`;
  for (const ig of ignores) {
    const m = ig.text.match(IGNORE);
    const at = ig.n;
    if (!m || !m[2]) push(ig.file, at, {rule: 'bad-ignore', message: 'a lint-ignore line needs a rule ID and a reason: <!-- lint-ignore <rule>: <reason> -->'});
    else if (!Object.hasOwn(RULES, m[1])) push(ig.file, at, {rule: 'bad-ignore', message: `lint-ignore names no rule "${label(m[1])}"`});
    else if (FIXED.has(m[1])) push(ig.file, at, {rule: 'bad-ignore', message: `${m[1]} can't be silenced`});
    else {
      const v = {...ig, rule: m[1], reason: m[2], used: false};
      valid.push(v);
      const key = keyOf(ig.file, v.rule, ig.entry ? `entry ${ig.entry.line}` : ig.target);
      if (!byTarget.has(key)) byTarget.set(key, v);
    }
  }
  // Leads last, so past MAX_KEEP they are what is dropped, not an error.
  if (leads) for (const l of leadFindings(log)) push('LESSONS.md', l.line, l.f, l.entry);
  for (const f of found) {
    const ig = FIXED.has(f.rule) ? null : byTarget.get(keyOf(f.file, f.rule, f.entry ? `entry ${f.entry.line}` : f.line));
    if (ig) {
      ig.used = true;
      silenced.push({...f, reason: unkeyed(ig.reason)});
    } else kept.push(f);
  }
  // A silence for a lead rule is unused only when the leads ran.
  for (const v of valid) if (!v.used && (leads || !LEADS.has(v.rule))) kept.push({file: v.file, line: v.n, rule: 'unused-ignore', severity: 'warning', message: `this lint-ignore for ${v.rule} matches no finding: remove it`});

  const order = new Map([['LESSONS.md', 0], ['PLAYBOOK.md', 1], ...rules.files.map((f, i) => [f.name, i + 2])]);
  const sort = (a, b) => (order.get(a.file) ?? 99) - (order.get(b.file) ?? 99) || a.line - b.line;
  kept.sort(sort);
  silenced.sort(sort);
  if (ctx.unchecked) notes.push(`${ctx.unchecked} file names past the limit, not looked up`);
  if (dropped) notes.push(`${dropped} more findings past the limit of ${MAX_KEEP}, not kept (${droppedErrors} of them errors)`);
  const strip = ({entry, ...f}) => f;
  const errors = kept.filter((f) => f.severity === 'error').length + Math.max(0, log.badCount - MAX_BAD) + droppedErrors;
  return {findings: kept.map(strip), silenced: silenced.map(strip), errors, warnings: kept.filter((f) => f.severity === 'warning').length, notes, sizes, ruleFiles: rules.files.map((f) => f.name)};
}

// How a finding is printed.
const findingLine = (f) => `${f.severity === 'error' ? 'ERROR' : 'WARN '} ${f.rule} ${f.file}${f.line ? `:${f.line}` : ''} ${f.message}`;

// --lint and --doctor as lines. `all` also lists the silenced findings;
// `doctor` adds the summary of the whole log.
export function lintLines(log, report, {all = false, doctor = false} = {}) {
  // Past the cap, errors are chosen before warnings, so many leads can't push
  // an error out of the list. The printed ones keep their file and line order.
  const rank = (f) => (f.severity === 'error' ? 0 : 1);
  const shown = report.findings.length <= MAX_FINDINGS ? report.findings
    : report.findings.map((f, k) => [f, k]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1])
      .slice(0, MAX_FINDINGS).sort((x, y) => x[1] - y[1]).map(([f]) => f);
  const lines = shown.map(findingLine);
  if (report.findings.length > MAX_FINDINGS) lines.push(`... and ${report.findings.length - MAX_FINDINGS} more, not printed`);
  if (all) for (const f of report.silenced.slice(0, MAX_FINDINGS)) lines.push(`SILENCED ${f.rule} ${f.file}${f.line ? `:${f.line}` : ''} ${f.message} (reason: ${f.reason})`);
  for (const n of report.notes) lines.push(`-- ${n}`);
  const quiet = report.silenced.length ? `, ${report.silenced.length} silenced${all ? '' : ' (--all lists them)'}` : '';
  lines.push(`-- lint: ${report.errors} error${report.errors === 1 ? '' : 's'}, ${report.warnings} warning${report.warnings === 1 ? '' : 's'}${quiet}`);
  if (doctor) {
    const files = report.ruleFiles.length ? `; rule files: ${report.ruleFiles.join(', ')}` : '';
    const {lessons, all: whole} = report.sizes;
    lines.push(`-- doctor: ${log.totals}, ${log.badCount} bad; LESSONS.md about ${lessons.tokens} tokens (budget ${lessons.budget}), --all about ${whole.tokens} (budget ${whole.budget})${files}`);
  }
  return lines;
}

// --lint and --doctor as one JSON object. Text from the files is made safe to
// print as it is for the terminal.
export function lintJson(log, report) {
  const safe = (f) => ({...f, file: show(f.file, MAX_NAME), message: show(f.message)});
  return JSON.stringify({
    version: VERSION,
    errors: report.errors,
    warnings: report.warnings,
    silenced: report.silenced.length,
    findings: report.findings.map(safe),
    silencedFindings: report.silenced.map((f) => ({...safe(f), reason: show(f.reason)})),
    notes: report.notes,
    lessons: {totals: log.totals, bad: log.badCount},
    sizes: {...report.sizes, sections: report.sizes.sections.map((s) => ({...s, name: show(s.name, MAX_NAME)}))},
    ruleFiles: report.ruleFiles.map((n) => show(n, MAX_NAME)),
  });
}

// ---- The command line -------------------------------------------------------

// Whether this file was started directly, not imported. Node resolves links
// in import.meta.url but not in process.argv[1], so both are compared by their
// real paths: a script started through a link (a `dev` that links to another
// folder) still runs.
function startedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

function say(text) {
  for (const line of String(text).split('\n')) console.log(show(line));
}

// The mode, the words and the root from the arguments, or null for a usage
// error.
function parseArgs(args) {
  // The repo root is the parent of the folder the script was started from, as
  // given on the command line. Node resolves links in import.meta.url, so a `dev`
  // that is a link to another project's folder would move the root there.
  let dir = resolve(dirname(process.argv[1] || fileURLToPath(import.meta.url)), '..');
  let mode = 'counts';
  let all = false; // --all after --lint or --doctor
  let json = false;
  let leads = false;
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--leads') {
      if (leads) return null;
      leads = true;
    } else if (a === '--pairs') {
      if (mode !== 'counts' || words.length) return null;
      mode = 'pairs';
    } else if (a === '--dir') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) return null;
      dir = resolve(args[++i]);
    } else if (a === '--all' && (mode === 'lint' || mode === 'doctor')) {
      if (all) return null;
      all = true;
    } else if (a === '--json') {
      if (json) return null;
      json = true;
    } else if (a === '--lint' || a === '--doctor') {
      if ((mode !== 'counts' && mode !== 'all') || words.length) return null;
      if (mode === 'all') all = true;
      mode = a.slice(2);
    } else if (a === '--check' || a === '--all' || a === '--stale') {
      if (mode !== 'counts' || words.length) return null;
      mode = a.slice(2);
    } else if (a.startsWith('-')) {
      return null;
    } else {
      if (mode !== 'counts' && mode !== 'words') return null;
      mode = 'words';
      words.push(a.toLowerCase());
    }
  }
  // --leads alone is --lint --leads, and so is --all --leads.
  if (leads && mode === 'counts') mode = 'lint';
  else if (leads && mode === 'all') {
    mode = 'lint';
    all = true;
  }
  if (leads && mode !== 'lint' && mode !== 'doctor') return null;
  if (json && mode !== 'lint' && mode !== 'doctor' && mode !== 'pairs') return null;
  return {dir, mode, words, all, json, leads};
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    say(USAGE);
    process.exitCode = 2;
    return;
  }
  const {dir, mode, words, all, json, leads} = parsed;
  const log = loadLog(dir);
  if (log.error) {
    if (json) console.log(JSON.stringify({version: VERSION, error: show(log.error)}));
    else say(log.error);
    process.exitCode = 2;
    return;
  }
  if (mode === 'lint' || mode === 'doctor') {
    const report = lintReport(log, {leads});
    if (json) console.log(lintJson(log, report));
    else lintLines(log, report, {all, doctor: mode === 'doctor'}).forEach((l) => say(l));
    process.exitCode = report.errors ? 1 : 0;
    return;
  }
  if (mode === 'pairs') {
    const report = pairsReport(log);
    if (json) console.log(pairsJson(report));
    else pairsLines(report).forEach((l) => say(l));
    return;
  }
  if (mode === 'check') {
    const {lines, ok} = checkReport(log);
    lines.forEach((l) => say(l));
    process.exitCode = ok ? 0 : 1;
    return;
  }
  const lines = mode === 'counts' ? countsReport(log) : mode === 'all' ? allReport(log) : mode === 'stale' ? staleReport(log) : lookupReport(log, words);
  lines.forEach((l) => say(l));
  const end = problemsLine(log);
  if (end) say(end);
}

if (startedDirectly()) main();
