#!/usr/bin/env node
// Prints the rules in LESSONS.md for the lessons check in PLAYBOOK.md, and checks
// the log's format. Reads LESSONS.md and PLAYBOOK.md and writes nothing.
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

import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const USAGE = 'usage: node dev/lessons.mjs [--dir <folder>] [--check | --all | <word>...]';
const FIELDS = ['What went wrong', 'Why', 'Rule going forward', 'Evidence', 'Status'];

const args = process.argv.slice(2);
let dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  console.log(message);
  process.exit(2);
}

function read(name) {
  try {
    return readFileSync(join(dir, name), 'utf8').replace(/\r/g, '').split('\n');
  } catch {
    fail(`lessons: cannot read ${join(dir, name)}`);
  }
}

const bad = [];
const problem = (line, text) => bad.push(`BAD   ${line ? `line ${line}: ` : ''}${text}`);

// PLAYBOOK.md: its "## " sections and the lessons each one's "From:" line names.
const sections = new Map();
{
  let current = null;
  let fence = false;
  read('PLAYBOOK.md').forEach((line, i) => {
    if (line.startsWith('```')) fence = !fence;
    if (fence) return;
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      current = {name: heading[1].trim(), from: [], line: i + 1};
      if (sections.has(current.name)) problem(0, `PLAYBOOK.md line ${i + 1}: a second section named "${current.name}"`);
      else sections.set(current.name, current);
    } else if (current && line.startsWith('From: ')) {
      for (const m of line.matchAll(/(\d{4}-\d{2}-\d{2}) "([^"]+)"/g)) current.from.push(`${m[1]} "${m[2]}"`);
    }
  });
}

// LESSONS.md: one entry per "## YYYY-MM-DD: title" heading.
const entries = [];
{
  let entry = null;
  let field = null;
  let fence = false;
  let fenceLine = 0;
  const finish = () => {
    if (!entry) return;
    const missing = FIELDS.filter((f) => !entry.fields[f]);
    if (missing.length) problem(entry.line, `${entry.title}: missing or empty: ${missing.join(', ')}`);
    const status = entry.fields.Status || '';
    let m;
    if (status === 'open') entry.status = 'open';
    else if ((m = status.match(/^promoted to PLAYBOOK "([^"]+)"$/))) {
      entry.status = 'promoted';
      entry.section = m[1];
      const section = sections.get(m[1]);
      if (!section) problem(entry.line, `${entry.title}: PLAYBOOK.md has no section "## ${m[1]}"`);
      else if (!section.from.includes(entry.key)) problem(entry.line, `${entry.title}: the "From:" line of "${m[1]}" does not name it`);
    } else if ((m = status.match(/^closed: (.+)$/))) {
      entry.status = 'closed';
    } else if (status) {
      problem(entry.line, `${entry.title}: Status must be open, promoted to PLAYBOOK "<section>" or closed: <reason>`);
    }
    entries.push(entry);
  };
  read('LESSONS.md').forEach((line, i) => {
    const n = i + 1;
    if (line.startsWith('```')) {
      fence = !fence;
      fenceLine = n;
      return;
    }
    if (fence) return;
    const heading = line.match(/^## (\d{4})-(\d{2})-(\d{2}): (.+)$/);
    if (heading) {
      finish();
      const [, y, mo, d, title] = heading;
      const date = `${y}-${mo}-${d}`;
      const real = new Date(`${date}T00:00:00Z`);
      if (Number.isNaN(real.getTime()) || real.toISOString().slice(0, 10) !== date) problem(n, `not a real date: ${date}`);
      const previous = entries.length ? entries[entries.length - 1].date : null;
      if (previous && date > previous) problem(n, `${title}: newer than the entry above it (the log is newest first)`);
      const key = `${date} "${title.trim()}"`;
      if (title.includes('"')) problem(n, `${title}: a title may not hold a double quote (PLAYBOOK "From:" lines quote titles)`);
      if (entries.some((e) => e.key === key)) problem(n, `${title}: a second entry with this date and title`);
      entry = {date, title: title.trim(), key, line: n, fields: {}};
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
    const f = line.match(/^- ([^:]+):(.*)$/);
    if (f && FIELDS.includes(f[1])) {
      field = f[1];
      if (field in entry.fields) problem(n, `${entry.title}: "${field}" appears twice`);
      else if (Object.keys(entry.fields).some((k) => FIELDS.indexOf(k) > FIELDS.indexOf(field)))
        problem(n, `${entry.title}: "${field}" is out of order (${FIELDS.join(', ')})`);
      entry.fields[field] = f[2].trim();
    } else if (/^\s+\S/.test(line) && field) {
      entry.fields[field] = `${entry.fields[field]} ${line.trim()}`.trim();
    } else if (line.trim() !== '') {
      problem(n, `${entry.title}: not a field (- ${FIELDS.join(': / - ')}:) or an indented continuation: ${line}`);
    }
  });
  finish();
  if (fence) problem(fenceLine, 'code fence is never closed');
}

// Every "From:" name in PLAYBOOK.md must be a lesson promoted to that section.
for (const section of sections.values()) {
  for (const key of section.from) {
    const e = entries.find((x) => x.key === key);
    if (!e || e.status !== 'promoted' || e.section !== section.name)
      problem(0, `PLAYBOOK.md line ${section.line}, "${section.name}": From: names ${key}, which is not a lesson promoted to this section`);
  }
}

const count = (s) => entries.filter((e) => e.status === s).length;
const totals = `${entries.length} lessons: ${count('open')} open, ${count('promoted')} promoted, ${count('closed')} closed`;

if (mode === 'check') {
  bad.forEach((b) => console.log(b));
  console.log(`${totals}; ${bad.length} bad`);
  process.exit(bad.length ? 1 : 0);
}

if (mode === 'counts') {
  console.log(totals);
  console.log(USAGE);
} else if (mode === 'all') {
  for (const e of entries) console.log(`[${e.fields.Status || '?'}] ${e.key}\n    ${e.fields['Rule going forward'] || ''}`);
  console.log(`-- ${totals}`);
} else {
  let shown = 0;
  const promoted = new Map(); // section -> how many matching lessons it holds
  const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const starts = words.map((w) => new RegExp(`(^|[^a-z0-9])${escape(w)}`));
  for (const e of entries) {
    // Search the title and the field values, not the field labels or Status.
    const text = [e.title, ...FIELDS.filter((f) => f !== 'Status').map((f) => e.fields[f] || '')].join(' ').toLowerCase();
    if (e.status === 'closed' || !starts.some((re) => re.test(text))) continue;
    shown++;
    if (e.status === 'promoted') promoted.set(e.section, (promoted.get(e.section) || 0) + 1);
    else console.log(`${e.key}\n    ${e.fields['Rule going forward'] || ''}`);
  }
  for (const [section, n] of promoted) console.log(`PLAYBOOK "${section}": follow its steps (${n} matching lesson${n > 1 ? 's' : ''})`);
  console.log(`-- ${shown} shown; ${totals}`);
}
if (bad.length) console.log(`lessons: the log has ${bad.length} format problem(s): run node dev/lessons.mjs --check`);
