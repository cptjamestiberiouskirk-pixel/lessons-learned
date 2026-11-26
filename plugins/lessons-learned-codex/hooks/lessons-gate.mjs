#!/usr/bin/env node
// lessons-gate.mjs from the lessons-learned plugin: a PreToolUse hook for
// Claude Code and for Codex (the same file in both copies). In a repo whose
// PLAYBOOK.md has "## The lessons check", it denies an edit, a git commit or a
// git push until the session has written a visible "Lessons checked:" line in
// this turn, after its last commit or push to that repo, and, where the
// session's own repo has this plugin's dev/lessons.mjs, has run a lookup with
// it.
//
// A nudge, not a security boundary: shell writes and other tools get past it.
// It reads the target repo's PLAYBOOK.md, its dev/lessons.mjs (for the hash)
// and the session transcript (Claude Code's, or Codex's rollout file). It
// writes nothing, starts no program and opens no network connection. Every
// error lets the call through, and so does anything it doesn't recognise,
// except running out of time (past DEADLINE, at its next look at the clock,
// it stops reading and denies) and, in Claude Code, a current call it can't
// find within POLL_FOR in a transcript that holds this session's records,
// which it denies too.
// LESSONS_GATE=off in its environment turns it off.

import {closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';

// The fingerprint of this release's templates/lessons.mjs, as the setup skill
// computes it (sha256 of the text with CRLF made LF). A test keeps it equal.
const FINGERPRINT = '24884e95499ad2e54735c16fb81bc027508ab69776cf854d8aa4c00cfd59b90f';
// The fingerprints of the released scripts, from each release tag's
// templates/lessons.mjs. Each takes `node dev/lessons.mjs <word>...` as a
// lookup, so a repo set up by an older release still needs one. Any other
// script is a mismatch: it may not be a lookup at all.
const RELEASED = new Set([
  'e6b41bf9d1ddda284178590e08a7abcdf6c5b0d7877f05b2b7290f3dc9ffa130', // v0.2.0
  'ec55848c3c07540568dd52be8e0a2cba47408f153490ae7976b9cd591333e455', // v0.2.1
  'ae8257c08a861066ec1bc5c4eca66b88e4a3e44ba68bde7c17111964041a1622', // v0.3.0
  '86d3cd28d4d1cbb16eeb04e21fc9bbe542cc86ac1326c03d84deb09f8e5d04ea', // v0.3.1
  '909da94a2c53a0b0e46aa7d34e4d3e483bb080d4a822a37a94248400cf39881a', // v0.4.0
]);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const CHUNK = 1024 * 1024; // bytes of transcript read at a time
const MAX_WINDOW = 32 * 1024 * 1024; // bytes of transcript read back at most
const POLL_EVERY = 15; // ms between looks for the current call
// ms to wait for the current call to be on disk. Claude Code can write its
// record after the hook starts (in one test 5.9 s after the record's own
// time), so a call still not there, in a transcript that holds this
// session's records (ownTranscript), is denied with REASON_UNSEEN.
const POLL_FOR = 1300;
const MAX_FILE = 1024 * 1024; // bytes of PLAYBOOK.md or dev/lessons.mjs read
const MAX_PATH = 4096; // characters of a path looked at; a longer one passes
const MAX_PARTS = 512; // names in a path looked at; a deeper one passes
const MAX_DEPTH = 4; // shells inside shells (bash -c "pwsh -c ...") read
// ms after Node's start past which the gate stops reading and denies the
// call. Claude Code ends a hook at its timeout (10 s in hooks.json) and then
// runs the call, so a gate still reading then would let it through unread.
// LESSONS_GATE_DEADLINE_MS can lower it (the tests do), never raise it.
const DEADLINE = 6000;
const HEADING = '## The lessons check';
// Fixed text, so nothing from the repo reaches the agent through the hook.
const DENY_MARK = 'Lessons check (PLAYBOOK.md';
const OFF = ' To turn this check off: LESSONS_GATE=off (see the lessons-learned README).';
const REASON_LOOKUP = `${DENY_MARK}, 'The lessons check'): run \`node dev/lessons.mjs <2-4 topic words>\` from the repo's top folder and let it finish. Then, just before the call, write a short \`Lessons checked:\` line alone as your reply's text (a line in thinking or a quoted mention doesn't count), and retry. A new turn (any new message to you but a background task's notice) uses both up, and so does any command with a \`git commit\` or \`git push\` in it, even one that fails or never reaches it. If this deny comes back, do both again as above. If it still comes back, check that the lookup finished before the call started and ran from the repo's top folder, with any \`cd\` there giving the path as its first argument (not a variable or \`$(...)\`), and that your reply's text starts with exactly \`Lessons checked:\`.${OFF}`;
const REASON_LINE = `${DENY_MARK}, 'The lessons check'): just before the call, write a short \`Lessons checked:\` line naming the lessons that apply, alone as your reply's text (a line in thinking or a quoted mention doesn't count), and retry. A new turn (any new message to you but a background task's notice) uses the line up, and so does any command with a \`git commit\` or \`git push\` in it, even one that fails or never reaches it. If this deny comes back, write the line again as above, starting it with exactly \`Lessons checked:\`.${OFF}`;
const REASON_LATE = `${DENY_MARK}, 'The lessons check'): the gate ran out of time before it could read this turn up to the call, so it denies the call rather than let it through unread. Retry it in the next turn. If this deny keeps coming back, tell the user that the gate runs out of time in this session.${OFF}`;
const REASON_UNSEEN = `${DENY_MARK}, 'The lessons check'): the gate didn't find this call in the session's transcript in time, so it denies the call rather than let it through unread. Retry it as the only call in your next reply. If this deny keeps coming back, tell the user that the gate can't find calls in this session's transcript.${OFF}`;
// Earlier wording of the reasons, so a call denied by an older copy is known:
// 0.4.0's two texts, and the out-of-time text main had from Q82 until Q93
// (no release holds it, but copies installed from the marketplace then do),
// each without OFF. Each such reason is one of them followed by OFF, so
// matching by includes finds it.
const OLD_REASONS = [
  `${DENY_MARK}, 'The lessons check'): run \`node dev/lessons.mjs <2-4 topic words>\`, write a visible \`Lessons checked:\` line, then retry.`,
  `${DENY_MARK}, 'The lessons check'): write a visible \`Lessons checked:\` line naming the lessons that apply, then retry.`,
  `${DENY_MARK}, 'The lessons check'): this turn holds more commands than the gate can read in time, so it denies the call rather than let it through unread. Retry it in the next turn.`,
];
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const LIMIT = (() => {
  const v = process.env.LESSONS_GATE_DEADLINE_MS;
  const ms = v ? Number(v) : NaN;
  return Number.isFinite(ms) && ms >= 0 && ms < DEADLINE ? ms : DEADLINE;
})();
const LATE = new Error('out of time');
// Called as the gate reads commands. Past the deadline it stops, and main()
// denies the call.
const inTime = () => {
  if (performance.now() > LIMIT) throw LATE;
};
const HOME = process.env.HOME || process.env.USERPROFILE || null;

const foldAscii = (p) => (/^(win32|darwin)$/.test(process.platform) ? p.replace(/[A-Z]/g, (c) => c.toLowerCase()) : p);
// A UNC path, \\?\ or \\.\ path, or one in the // form: not looked at.
const unc = (p) => /^[\\/]{2}/.test(p);
const withSep = (dir) => join(dir, 'x').slice(0, -1);
const tooLong = (p) => p.length > MAX_PATH || p.split(/[\\/]/).length > MAX_PARTS;
// On Windows, a Git Bash path (/c/Users/x) or a WSL one (/mnt/c/Users/x) is
// the drive path it stands for.
const native = (p) => {
  if (process.platform !== 'win32') return p;
  const m = /^(?:\/mnt)?\/([A-Za-z])(?:\/|$)/.exec(p);
  return m ? `${m[1].toUpperCase()}:\\${p.slice(m[0].length)}` : p;
};

function realOf(p) {
  try {
    const r = realpathSync.native(p);
    return unc(r) ? null : r;
  } catch {
    return null;
  }
}

// The real path of a target that may not exist yet: the nearest existing
// folder's real path, with the missing names joined back on.
function nearestReal(target) {
  let p = resolve(target);
  const rest = [];
  for (;;) {
    try {
      lstatSync(p);
      break;
    } catch {
      const up = dirname(p);
      if (up === p) return null;
      rest.unshift(basename(p));
      p = up;
    }
  }
  const real = realOf(p);
  if (!real) return null;
  return {real: rest.length ? join(real, ...rest) : real, existing: rest.length === 0};
}

// The nearest folder at or above `dir` (a real path) that holds a .git file
// or folder. The first one found wins, so a .git in a parent folder never
// takes over a repo below it.
function findRoot(dir) {
  let d = dir;
  for (;;) {
    try {
      lstatSync(join(d, '.git'));
      return d;
    } catch {}
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// As the template script reads a file: through one handle that must be the
// file the look saw, a regular file with one hard link, of at most `max`
// bytes, giving exactly as many bytes as it has.
const OPEN = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
function readSame(path, seen, max) {
  let fd;
  try {
    fd = openSync(path, OPEN);
  } catch {
    return null;
  }
  try {
    const now = fstatSync(fd, {bigint: true});
    if (now.dev !== seen.dev || now.ino !== seen.ino || !now.isFile() || now.nlink !== 1n) return null;
    if (now.size > BigInt(max)) return null;
    const size = Number(now.size);
    const buf = Buffer.alloc(size + 1);
    let got = 0;
    for (let n; got < buf.length && (n = readSync(fd, buf, got, buf.length - got, null)) > 0; ) got += n;
    if (got !== size) return null;
    return buf.toString('utf8', 0, got);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// A file in the repo, by its parts under the root: no link on the way or at
// the file, a regular file with one hard link, and a real path that is the
// root's real path, exactly, then the parts, with only ASCII case ignored and
// only on Windows and macOS. Null if anything is off.
function readInRepo(root, parts, max) {
  try {
    let at = root;
    for (let k = 0; k < parts.length; k++) {
      at = join(at, parts[k]);
      const st = lstatSync(at, {bigint: true});
      if (st.isSymbolicLink()) return null;
      if (k < parts.length - 1 && !st.isDirectory()) return null;
      if (k === parts.length - 1) {
        if (!st.isFile() || st.nlink !== 1n || st.size > BigInt(max)) return null;
        const real = realOf(at);
        const base = withSep(root);
        if (!real || !real.startsWith(base) || foldAscii(real.slice(base.length)) !== foldAscii(join(...parts))) return null;
        return readSame(at, st, max);
      }
    }
  } catch {}
  return null;
}

// Whether a real path is `<root>/<parts>`, compared as readInRepo does.
function isInRepo(real, root, parts) {
  const base = withSep(root);
  return real.startsWith(base) && foldAscii(real.slice(base.length)) === foldAscii(join(...parts));
}

function hasCheck(root) {
  let text = readInRepo(root, ['PLAYBOOK.md'], MAX_FILE);
  if (text === null) return false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r/g, '').split('\n').includes(HEADING);
}

function scriptMatches(root) {
  const text = readInRepo(root, ['dev', 'lessons.mjs'], MAX_FILE);
  if (text === null) return false;
  const hash = createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
  return hash === FINGERPRINT || RELEASED.has(hash);
}

// Edits that are never gated: the root's own LESSONS.md, by its given name
// and its real path, as a plain file with one name; anything under the
// root's .git folder; anything under its .claude folder but the settings
// files there, which could turn this hook off.
function exempt(given, target, root) {
  const base = withSep(root);
  if (!target.real.startsWith(base)) return false;
  const parts = target.real.slice(base.length).split(sep);
  const top = foldAscii(parts[0]);
  if (parts.length > 1 && top === '.git') return true;
  if (parts.length > 1 && top === '.claude') {
    // On Windows, settings.json::$DATA and settings.json. name the same file.
    let name = foldAscii(parts[parts.length - 1]);
    if (process.platform === 'win32') name = name.split(':')[0];
    name = name.replace(/[. ]+$/, '');
    return !(parts.length === 2 && /^settings.*\.json$/i.test(name));
  }
  const name = foldAscii('LESSONS.md');
  if (parts.length !== 1 || foldAscii(parts[0]) !== name || foldAscii(basename(given)) !== name) return false;
  if (!target.existing) return true;
  try {
    const st = lstatSync(given, {bigint: true});
    return st.isFile() && !st.isSymbolicLink() && st.nlink === 1n;
  } catch {
    return false;
  }
}

// ---- Reading a command ----------------------------------------------------
//
// A command is read as its shell would split it: quotes, escapes, here-doc
// bodies, separators and redirections, in bash ('sh'), PowerShell ('ps') or
// cmd ('cmd') rules. It needn't be exact: it finds the simple commands and
// their words, and a word built from a variable or a substitution is marked
// as one that can't be told.
//
// With `legacy`, a $( ) is read as before this hook learned comments,
// $'...' and the nesting of double quotes in it: quotes only. `split` is
// null, or a pair of ways to read a CR and an escape before a newline (see
// tokenize): sh as bash on Linux ('linux') or Git Bash ('git') reads them,
// and PowerShell with each word the hook can't place read as one pwsh reads
// on ('in') or ends ('start'). Without it, they are read as main's reading
// read them. main() judges a call each way and denies it if any reading
// does, so a rule learned here can deny more than the legacy reading, never
// less.

// Here-doc and here-string bodies are text, not commands. Both are found line
// by line, so the work grows linearly with the command.
function dropBodies(command, dialect, legacy, cr = false, linux = false) {
  if (dialect === 'ps') return dropHereStrings(command, legacy, cr);
  if (dialect !== 'sh' || !command.includes('<<')) return command;
  const out = [];
  // Here-docs opened and not yet closed, in order; `next` is the one whose
  // closing line comes first. bash on Linux keeps a CR in the tag and in
  // the closing line; the other readings take a CR at the line's end off.
  const waiting = [];
  let next = 0;
  const state = {stack: [], legacy, linux};
  for (const raw of command.split('\n')) {
    if (next < waiting.length) {
      const line = linux ? raw : raw.replace(/\r$/, '');
      if ((waiting[next].tabs ? line.replace(/^\t+/, '') : line) === waiting[next].tag) next++;
      out.push('');
      continue;
    }
    out.push(raw);
    for (const opener of hereDocs(raw, state)) waiting.push(opener);
  }
  return out.join('\n');
}

// The here-docs a line of sh opens: each `<<` in command context, but not in
// quotes, `$(( ))`, `$[ ]` or a comment, and not `<<<` (a here-string).
// `state.stack` holds the open contexts, carried to the next line: a quote,
// or `(` for a `$(` inside double quotes, which is command context again
// until its `)`. With `state.legacy`, a tag is read as main read it.
const HERE_DOC = /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z0-9_.-]+))/y;

// The tag of a here-doc whose `<<` is at `at`, as bash reads the word after it
// (scratch q83/probe-sh.mjs): quotes and backslashes come off, $'...' is
// decoded, and every other character up to a space, a tab or one of ;&|()<>
// is kept, $ ` { } and + included; a $( ), ${ } or backticks are kept whole.
// A CR ends it, but bash on Linux (`linux`) keeps one. Null where no word
// follows, or a quote or a $( ) isn't closed on the line. `look` finds where
// a $( ) or ${ } closes, and marks where a scan failed from (hereDocs).
function hereTag(line, at, linux, look) {
  let i = at + 2;
  const tabs = line[i] === '-';
  if (tabs) i++;
  while (line[i] === ' ' || line[i] === '\t') i++;
  let tag = '';
  const start = i;
  // From each place the scan passes between a word's pieces, it goes on the
  // same way whatever came before, so a scan that failed would fail again
  // from each of them. hereDocs tries each << inside a word whose scan
  // failed, and each would read the rest of it again (Q83 review round 3),
  // so those places are marked, and a scan that comes to one stops there.
  const dead = look.dead();
  const passed = [];
  const fail = () => {
    for (const k of passed) dead[k] = 1;
    return null;
  };
  while (i < line.length) {
    if (dead[i]) return fail();
    passed.push(i);
    const c = line[i];
    if (' \t;&|()<>'.includes(c) || (c === '\r' && !linux)) break;
    if (c === "'") {
      const k = line.indexOf("'", i + 1);
      if (k < 0) return fail();
      tag += line.slice(i + 1, k);
      i = k + 1;
    } else if (c === '$' && line[i + 1] === "'") {
      let k = i + 2;
      while (k < line.length && line[k] !== "'") k += line[k] === '\\' ? 2 : 1;
      if (k >= line.length) return fail();
      tag += ansiC(line.slice(i + 2, k));
      i = k + 1;
    } else if (c === '"' || (c === '$' && line[i + 1] === '"')) {
      let k = c === '$' ? i + 2 : i + 1;
      for (; k < line.length && line[k] !== '"'; k++) {
        if (line[k] === '\\' && '$`"\\'.includes(line[k + 1] ?? '')) k++;
        tag += line[k];
      }
      if (k >= line.length) return fail();
      i = k + 1;
    } else if (c === '\\') {
      if (i + 1 < line.length) tag += line[i + 1];
      i += 2;
    } else if (c === '$' && (line[i + 1] === '(' || line[i + 1] === '{')) {
      const k = line[i + 1] === '(' ? look.parens(i + 1) : look.brace(i + 2);
      if (k < 0 || k >= line.length) return fail();
      tag += line.slice(i, k + 1);
      i = k + 1;
    } else if (c === '`') {
      const k = line.indexOf('`', i + 1);
      if (k < 0) return fail();
      tag += line.slice(i, k + 1);
      i = k + 1;
    } else {
      tag += c;
      i++;
    }
  }
  return i > start ? {tag, tabs, end: i} : null;
}

function hereDocs(line, state) {
  const found = [];
  const st = state.stack;
  // A tag whose $( ) or ${ } isn't closed on its line is looked for to the
  // line's end, and each << after it looks as far again (Q83 review round 1),
  // so the ends are found once for the line, each in one pass: where each (
  // is balanced (parenEnds), and the next } from each place (braceNexts).
  // Nested tags look from places that go back and forth, so neither is a
  // search that goes on from the last (Q83 review round 3). `dead` marks
  // where a tag's scan failed from (hereTag).
  let parenTable = null;
  let braceTable = null;
  let deadTable = null;
  const look = {
    parens: (open) => (parenTable ??= parenEnds(line))[open],
    brace: (from) => (braceTable ??= braceNexts(line))[from],
    dead: () => (deadTable ??= new Uint8Array(line.length)),
  };
  let arith = 0;
  let brackets = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const top = st[st.length - 1];
    if (top === "'") {
      if (c === "'") st.pop();
    } else if (top === '"') {
      if (c === '\\') i++;
      else if (c === '"') st.pop();
      else if (c === '$' && line[i + 1] === '(' && line[i + 2] !== '(') {
        st.push('(');
        i++;
      }
    } else if (c === '\\') i++;
    else if (c === "'" || c === '"') st.push(c);
    else if (arith) {
      if (c === '(') arith++;
      else if (c === ')') arith--;
    } else if (brackets) {
      if (c === '[') brackets++;
      else if (c === ']') brackets--;
    } else if (c === '(' && line[i + 1] === '(') {
      arith = 2;
      i++;
    } else if (c === '$' && line[i + 1] === '[') {
      brackets = 1;
      i++;
    } else if (top === '(' && c === '(') st.push('(');
    else if (top === '(' && c === ')') st.pop();
    else if (c === '#' && (i === 0 || (state.legacy ? /[\s;&|()]/ : state.linux ? /[ \t;&|()]/ : /[ \t\r;&|()]/).test(line[i - 1]))) break;
    else if (c === '<' && line[i + 1] === '<') {
      if (line[i + 2] === '<') {
        i += 2;
        continue;
      }
      if (!state.legacy) {
        const t = hereTag(line, i, state.linux, look);
        if (!t) {
          i++;
          continue;
        }
        found.push({tag: t.tag, tabs: t.tabs});
        i = t.end - 1;
        continue;
      }
      HERE_DOC.lastIndex = i;
      const m = HERE_DOC.exec(line);
      if (!m) {
        i++;
        continue;
      }
      found.push({tag: m[2] ?? m[3] ?? m[4], tabs: m[1] === '-'});
      i = HERE_DOC.lastIndex - 1;
    }
  }
  return found;
}

// The index of the ")" that balances a "(" just before `from` in `text`,
// counting parentheses only, or text.length if none does. pwsh ends a $( )
// inside double quotes so (ScanSubExpression in its tokenizer.cs).
function parens(text, from) {
  let depth = 1;
  for (let j = from; j < text.length; j++) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')' && --depth === 0) return j;
  }
  return text.length;
}

// For each ( in `text`, what parens() gives for the text after it: the index
// of the ) that balances it, or text.length. Found in one pass, so a text
// whose parentheses are looked up again and again is read once (Q83 review
// round 2: psHead and hereTag looked from many places to the same end).
function parenEnds(text) {
  const ends = new Int32Array(text.length).fill(text.length);
  const open = [];
  for (let j = 0; j < text.length; j++) {
    if (text[j] === '(') open.push(j);
    else if (text[j] === ')' && open.length) ends[open.pop()] = j;
  }
  return ends;
}

// For each place in `text`, its end included, what text.indexOf('}', from)
// gives: the first } at or after it, or -1. Found in one pass from the end.
function braceNexts(text) {
  const next = new Int32Array(text.length + 1);
  let at = -1;
  next[text.length] = -1;
  for (let j = text.length - 1; j >= 0; j--) {
    if (text[j] === '}') at = j;
    next[j] = at;
  }
  return next;
}

// The characters pwsh reads as a space between words, as its tokenizer's
// IsWhitespace: a space, a tab, a vertical tab, a form feed, U+0085, U+00A0
// and Unicode's other spaces and line and paragraph separators, but not
// U+FEFF, U+180E or U+200B (scratch q83/probe-ps.mjs). bash reads only a space
// or a tab. JavaScript's \s, which this hook read before, holds U+FEFF and not
// U+0085; the legacy reading still reads it.
const PS_SPACES = new Set([0x09, 0x0b, 0x0c, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
const psSpace = (c) => {
  const k = c === undefined ? -1 : c.charCodeAt(0);
  return PS_SPACES.has(k) || (k >= 0x2000 && k <= 0x200a);
};

// bash's $'...' body as bash 5 reads it: \a \b \e \E \f \n \r \t \v \\ \' \"
// \?, up to three octal digits, \x and up to two hex digits, \u up to four,
// \U up to eight, and \c and a character, its control character. Any other
// escape keeps its backslash, and a NUL ends the text.
const C_ESC = {a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?'};
const HEX = {x: /[0-9A-Fa-f]{1,2}/y, u: /[0-9A-Fa-f]{1,4}/y, U: /[0-9A-Fa-f]{1,8}/y};
function ansiC(body) {
  let out = '';
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    const d = body[j + 1];
    if (c !== '\\' || d === undefined) {
      out += c;
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(body.slice(j + 1, j + 4));
    const hex = Object.hasOwn(HEX, d) ? HEX[d] : null;
    if (hex) hex.lastIndex = j + 2;
    const digits = hex && hex.exec(body);
    if (Object.hasOwn(C_ESC, d)) {
      out += C_ESC[d];
      j++;
    } else if (oct) {
      out += String.fromCharCode(parseInt(oct[0], 8) & 0xff);
      j += oct[0].length;
    } else if (digits) {
      const v = parseInt(digits[0], 16);
      out += d === 'x' ? String.fromCharCode(v) : v <= 0x10ffff ? String.fromCodePoint(v) : '';
      j += 1 + digits[0].length;
    } else if (d === 'c' && j + 2 < body.length) {
      const x = body[j + 2];
      out += x === '?' ? '\x7f' : String.fromCharCode(x.toUpperCase().charCodeAt(0) & 0x1f);
      j += 2;
    } else out += c;
  }
  const nul = out.indexOf('\0');
  return nul < 0 ? out : out.slice(0, nul);
}

// pwsh's escape at k, after a `, in a bareword or in double quotes: `0 `a
// `b `e `f `n `r `t `v, and `u{ } with one to six hex digits; any other
// character, or a capital (`N), stands for itself. The text it makes, and how
// many characters it takes.
const PS_ESC = {0: '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v'};
const PS_U = /u\{([0-9A-Fa-f]{1,6})\}/y;
function psEscape(s, k) {
  PS_U.lastIndex = k;
  const m = PS_U.exec(s);
  if (m && parseInt(m[1], 16) <= 0x10ffff) return [String.fromCodePoint(parseInt(m[1], 16)), m[0].length];
  return [Object.hasOwn(PS_ESC, s[k]) ? PS_ESC[s[k]] : s[k], 1];
}

// Where the head a pwsh argument starts with at k ends, and whether it is an
// expression by itself: a quoted string or a $( ) is, and a variable is with
// a member or an index after it ($x[0], $x.y.z, $env:x.y, $x::y). null with
// none. It reads as far as the text goes, so a word's head is found once; an
// escape that cuts the word before the head's end leaves it no expression
// yet. $?, $$ and $^ take none in an argument. `ends` gives parenEnds(s),
// found once for s, so a $( ) head costs no scan of its own.
const PS_VAR = /\$(?:\{[^}]*\}|(?:[\p{L}_][\p{L}\p{N}_]*:(?!:))?[\p{L}\p{N}_][\p{L}\p{N}_?]*)/uy;
const PS_NAME = /[\p{L}\p{N}_]+/uy;
function psHead(s, k, ends) {
  let e;
  if (s[k] === "'") {
    for (e = k + 1; ; e += 2) {
      e = s.indexOf("'", e);
      if (e < 0) return null;
      if (s[e + 1] !== "'") return [e + 1, true];
    }
  }
  if (s[k] === '"') {
    for (e = k + 1; e < s.length; ) {
      if (s[e] === '`') e += 2;
      else if (s[e] === '$' && s[e + 1] === '(') e = ends()[e + 1] + 1;
      else if (s[e] === '"' && s[e + 1] === '"') e += 2;
      else if (s[e] === '"') return [e + 1, true];
      else e++;
    }
    return null;
  }
  if (s[k] === '$' && s[k + 1] === '(') return [ends()[k + 1] + 1, true];
  PS_VAR.lastIndex = k;
  return PS_VAR.exec(s) ? [PS_VAR.lastIndex, false] : null;
}

// The member or index at e after an expression ([0], .y, ."y", ::y): where it
// ends, e if none is there, or -1 if one may go on past `to`, the escape
// that cuts the word: a [ with no ] before it (`st` keeps where its scan got
// to, so the next `to` goes on from there), a quoted member not closed before
// it, or a . or :: right at it. A call's ( ) is never inside a word here, as
// a ( or ) ends one; the word after its ) goes on (psKind's `lead`).
function psStep(s, e, to, st) {
  if (s[e] === '[') {
    let j = e + 1;
    let depth = 1;
    if (st.j > e) ({j, depth} = st);
    for (; j < to; j++) {
      if (s[j] === '[') depth++;
      else if (s[j] === ']' && --depth === 0) return j + 1;
    }
    st.j = j;
    st.depth = depth;
    return -1;
  }
  if (s[e] !== '.' && !(s[e] === ':' && s[e + 1] === ':')) return e;
  if (e + 1 >= to) return -1;
  const n0 = s[e] === '.' ? e + 1 : e + 2;
  const q = s[n0];
  if (q === "'" || q === '"') {
    const c = s.indexOf(q, n0 + 1);
    if (c < 0) return e;
    return c < to ? c + 1 : -1;
  }
  PS_NAME.lastIndex = n0;
  if (!PS_NAME.exec(s)) return e;
  return PS_NAME.lastIndex > to ? -1 : PS_NAME.lastIndex;
}

// How pwsh reads a ` and a newline right after s[from..to), an argument so far
// (scratch q83/probe-ps.mjs, probe-ps2.mjs): 'start' after an index or a
// member, where they are a space; 'param' after a parameter (-a, -a$x, a
// letter past ASCII, and a dash pwsh reads as one, PS_DASH) or a word like
// :a, where the ` is part of it and the newline ends the command; null inside
// any other word, or with no argument. There each split reads it (tokenize):
// pwsh reads the newline as part of a plain word, but as a space where it
// reads an expression, as after = or a comma or at a statement's start
// (scratch q83/verify/f1.mjs). An expression it starts with ends it, and
// what follows is read as a new one: $x.y-z ends in the parameter -z. Where
// a word could be a parameter or a plain one, it is read as a parameter:
// that reading can only deny more. `lead` is whether the word starts right
// after a ), so its members and indexes are the value's before it:
// $x.y(1).z, (1)[0] and a(1).z end in an expression, where a(1) is a and
// (1) (scratch q83/probe-paren.mjs). `cache` keeps the word's place between
// its escapes, each read with a later `to`, so a word with many escapes is
// read once: k, where the expression being read starts or, once `rest`,
// where the words after the last one start (pe and colon: where PS_PARAM
// ends there and whether in a :, found once); h, k's head; e, where the
// expression is read to, -1 before its head; at and head, its head's end and
// whether that alone makes an expression. A . or [ where `to` cut it is read
// again from there, and a [ from where its scan got to.
// pwsh reads U+2013, U+2014 and U+2015 as a parameter's dash wherever it reads
// - (scratch q83/verify/dash.mjs). `ends` is psHead's.
const PS_DASH = `-${String.fromCharCode(0x2013, 0x2014, 0x2015)}`;
const PS_PARAM = new RegExp(`(?:[${PS_DASH}][\\p{L}_?]|:[\\p{L}\\p{N}_?])[\\p{L}\\p{N}_?$-]*:?`, 'uy');
function psKind(s, from, to, c, lead, ends) {
  if (from >= to) return null;
  if (c.from !== from || to < c.to) {
    c.from = from;
    c.k = from;
    c.h = undefined;
    c.e = lead ? from : -1;
    c.at = from;
    c.head = true;
    c.j = -1;
    c.rest = false;
    c.pe = -1;
  }
  c.to = to;
  let cut = false;
  while (!c.rest) {
    if (c.e < 0) {
      if (c.h === undefined) c.h = psHead(s, c.k, ends);
      if (!c.h) {
        c.rest = true;
        break;
      }
      if (c.h[0] > to) {
        break;
      }
      [c.e, c.head] = c.h;
      c.at = c.e;
    }
    for (;;) {
      const f = psStep(s, c.e, to, c);
      if (f < 0) cut = true;
      if (f <= c.e) break;
      c.e = f;
    }
    const whole = c.head || c.e > c.at;
    if (c.e === to && whole) return 'start';
    if (cut) break;
    if (!whole) {
      c.rest = true;
      break;
    }
    c.k = c.e;
    c.h = undefined;
    c.e = -1;
  }
  if (c.rest && c.pe === -1) {
    PS_PARAM.lastIndex = c.k;
    const m = PS_PARAM.exec(s);
    c.pe = m ? PS_PARAM.lastIndex : -2;
    c.colon = Boolean(m) && PS_DASH.includes(s[c.k]) && m[0].endsWith(':');
  }
  // Cut, the words after the expression start at its . or [ (or its $, if it
  // is a variable with no member yet), where no parameter does.
  if (!c.rest || c.pe !== to) return null;
  return c.colon ? 'start' : 'param';
}

// The code pwsh reads from the text of a $( ) inside double quotes: a ` or
// a " before a " is dropped. (pwsh drops one before a typographic double
// quote too, which this hook reads as text everywhere.)
const psSubText = (text) => text.replace(/[`"]"/g, '"');

// Whether the @ at `at` in a line of PowerShell is outside quotes and
// comments, so an @' or @" there opens a here-string. `st` holds the open
// quote. A $( inside double quotes runs to the ) that balances it, as pwsh
// reads it. An @ inside one opens no here-string here: pwsh reads one there
// only when it reads the $( )'s text as code, and tokenize reads that text
// on its own, here-strings included. With `legacy`, such a $( ) pushes a (
// instead: code until its ), quotes included. A quote opened on an earlier
// line is not seen.
function codeAt(line, at, legacy) {
  const st = [];
  for (let i = 0; i < at; i++) {
    const c = line[i];
    const top = st[st.length - 1];
    if (top === "'") {
      if (c === "'") {
        if (line[i + 1] === "'") i++;
        else st.pop();
      }
    } else if (top === '"') {
      if (c === '`') i++;
      else if (c === '"') {
        if (line[i + 1] === '"') i++;
        else st.pop();
      } else if (c === '$' && line[i + 1] === '(') {
        if (!legacy) i = parens(line, i + 2);
        else {
          st.push('(');
          i++;
        }
      }
    } else if (c === "'" || c === '"') st.push(c);
    else if (c === '`') i++;
    else if (top === '(' && c === '(') st.push('(');
    else if (top === '(' && c === ')') st.pop();
    else if (c === '<' && line[i + 1] === '#') {
      const k = line.indexOf('#>', i + 2);
      if (k < 0 || k + 2 > at) return false;
      i = k + 1;
    } else if (c === '#' && (i === 0 || (legacy ? /\s/.test(line[i - 1]) : psSpace(line[i - 1]) || /[\r\n]/.test(line[i - 1])) || /[;|&(){}]/.test(line[i - 1]))) return false;
  }
  return st.length === 0;
}

// PowerShell here-strings: a line ending in @' or @" outside quotes and
// comments opens one, and a line starting with '@ or "@ closes it. The body
// becomes '' on the opening line; one never closed is left as it was. With
// `cr`, a CR with no LF after it ends a line too, as pwsh reads it; each
// line keeps what ended it.
function dropHereStrings(command, legacy, cr = false) {
  if (!command.includes('@')) return command;
  const parts = command.split(cr ? /(\r(?!\n)|\n)/ : /(\n)/);
  const ends = parts.filter((_, k) => k % 2 === 1);
  const out = [];
  let open = null;
  for (const raw of parts.filter((_, k) => k % 2 === 0)) {
    if (open) {
      open.lines.push(raw);
      if (raw.startsWith(`${open.q}@`)) {
        out[open.at] += raw.slice(2).replace(/\r$/, '');
        open = null;
      }
      out.push('');
      continue;
    }
    const m = /@(['"])[ \t]*\r?$/.exec(raw);
    if (m && codeAt(raw, m.index, legacy)) {
      open = {q: m[1], at: out.length, lines: [raw]};
      out.push(`${raw.slice(0, m.index)}''`);
    } else out.push(raw);
  }
  if (open) {
    out.length = open.at;
    for (const line of open.lines) out.push(line);
  }
  return out.map((line, k) => line + (ends[k] ?? '')).join('');
}

function tokenize(input, dialect, legacy = false, split = null) {
  // A CR, with `split`: Git Bash and cmd drop each one, bash on Linux reads
  // it as part of a word, and pwsh reads one with no LF after it as a
  // newline in code (`cr`). Without `split`, it is a space.
  const drop = split && (dialect === 'cmd' || (dialect === 'sh' && split.sh === 'git'));
  const cr = Boolean(split) && dialect === 'ps';
  const linux = Boolean(split) && dialect === 'sh' && split.sh === 'linux';
  const s = dropBodies(drop ? input.replace(/\r/g, '') : input, dialect, legacy, cr, linux);
  // psKind's table of where each ( in s is balanced, found when first needed.
  let parenTable = null;
  const psEnds = () => (parenTable ??= parenEnds(s));
  const isNl = (k) => s[k] === '\n' || (cr && s[k] === '\r' && s[k + 1] !== '\n');
  // A space between words, as the shell reads one (see psSpace). A CR is
  // one but in bash on Linux. The legacy reading and cmd read \s.
  const space =
    legacy || dialect === 'cmd' ? (c) => /\s/.test(c) : dialect === 'ps' ? (c) => c === '\r' || psSpace(c) : (c) => c === ' ' || c === '\t' || (c === '\r' && !linux);
  // The end of the line `from` is on.
  const eol = (from) => {
    let k = from;
    while (k < s.length && !isNl(k)) k++;
    return k;
  };
  const esc = dialect === 'ps' ? '`' : dialect === 'cmd' ? '^' : '\\';
  const cmds = [];
  const subs = [];
  let words = [];
  let w = null;
  let dropNext = false;
  // sh case statements, innermost last: 'head' (case WORD in), 'pat' (a
  // pattern, which ends in a ")" that closes no subshell) or 'list' (its
  // commands, up to ;; ;& ;;& or esac). `lead` is true while the words so
  // far in this command are only keywords, so the next word starts it.
  const cases = [];
  let lead = true;
  let headWords = 0;
  const caseWord = (word) => {
    const t = word.dyn ? null : word.text;
    const top = cases.length - 1;
    if (cases[top] === 'head') {
      if (t === 'in' && headWords > 0) {
        cases[top] = 'pat';
        lead = true;
        return;
      }
      headWords++;
    } else if (cases[top] === 'pat') {
      if (lead && t === 'esac') cases.pop();
    } else if (lead && t === 'case') {
      cases.push('head');
      headWords = 0;
    } else if (lead && t === 'esac' && cases.length) cases.pop();
    lead = lead && KEYWORDS.has(t);
  };
  const end = () => {
    if (w && !dropNext) {
      if (dialect === 'sh') caseWord(w);
      words.push(w);
    } else if (w) dropNext = false;
    w = null;
  };
  const brk = () => {
    end();
    dropNext = false;
    lead = true;
    if (words.length) cmds.push(words);
    words = [];
  };
  // Where the main loop is, where the word being built began, and psKind's
  // cache for that word.
  let i = 0;
  let wAt = 0;
  const kinds = {from: -1};
  const add = (c, dyn = false) => {
    if (!w) {
      w = {text: '', dyn: false};
      wAt = i;
    }
    w.text += c;
    if (dyn) w.dyn = true;
  };
  const n = s.length;
  // The index of the ")" that closes a "(" just before `from`, as the shell
  // reads it. `st` holds the open contexts: a quote; $' for bash's $'...',
  // where a backslash escapes the next character; ( for a ( in code, or in
  // sh for a $( inside double quotes, which is code again until its ); and
  // A for a ( of sh arithmetic, (( )) or $(( )), where a # is no comment. In
  // code, a # that starts a word starts a comment to the line's end, and in
  // PowerShell <# #> is one too. `start` is whether the next character in
  // code starts a word; an escape before a LF joins the lines, in bash and
  // in pwsh but where pwsh reads it as a space (below). In PowerShell a $(
  // inside double quotes ends at the ) that
  // balances its parentheses, whatever is between.
  const close = (from) => {
    const st = [dialect === 'sh' && s[from] === '(' ? 'A' : '('];
    let start = true;
    // Whether the quote open now started a word, where the last quoted
    // string or $( ) that started one ended, and where the last ) of a ( that
    // is no $( did.
    let fresh = false;
    let whole = -1;
    let after = -1;
    // Where the word now open in code began, psKind's cache for it, and for
    // each ( open, the word it is in, whether its $ started that word, and
    // that word's cache and `after`. At the ) the word goes on from where
    // its cache got to, so it is read once, however many words the ( holds.
    let wordAt = from;
    let kc = {from: -1};
    const outer = [];
    // In PowerShell a quoted string or a $( ) that starts a word ends it,
    // unless a member or an index follows (scratch q83/probe-after*.ps1):
    // "a"x is two words, and in "a"#b the # starts a comment.
    const ends = (j) => dialect === 'ps' && whole === j && s[j] !== '.' && s[j] !== '[' && !(s[j] === ':' && s[j + 1] === ':');
    for (let j = from; j < n; j++) {
      const c = s[j];
      const top = st[st.length - 1];
      if (top === "'" || top === "$'" || top === '"') {
        if (top === "$'" && c === '\\') j++;
        else if (top === '"' && c === esc) j++;
        else if (c === (top === '"' ? '"' : "'")) {
          st.pop();
          if (fresh) whole = j + 1;
          start = false;
        } else if (top === '"' && c === '$' && s[j + 1] === '(') {
          if (dialect === 'ps') j = parens(s, j + 2);
          else {
            st.push(s[j + 2] === '(' ? 'A' : '(');
            outer.push(null);
            start = true;
            j++;
          }
        }
      } else if (c === "'" || c === '"' || (dialect === 'sh' && c === '$' && s[j + 1] === "'")) {
        fresh = start || ends(j);
        if (fresh) wordAt = j;
        st.push(c === '$' ? "$'" : c);
        if (c === '$') j++;
      } else if (c === esc) {
        // An escape before a LF joins the lines, but where pwsh reads them
        // as a space, or as a parameter's end and a newline (see psKind), a
        // # after it starts a comment.
        if (isNl(j + 1) && cr) {
          if ((start || whole === j ? 'start' : (psKind(s, wordAt, j, kc, wordAt === after, psEnds) ?? split.ps)) !== 'in') start = true;
        } else if (!isNl(j + 1)) {
          if (start || ends(j)) wordAt = j;
          start = false;
        }
        j++;
      } else if (c === '(') {
        st.push(top === 'A' || (dialect === 'sh' && s[j + 1] === '(') ? 'A' : '(');
        if (dialect === 'ps' && s[j - 1] === '$' && j - 1 >= from) {
          outer.push({wordAt, fresh: wordAt === j - 1, kc, after});
          kc = {from: -1};
        } else outer.push(null);
        start = true;
      } else if (c === ')') {
        st.pop();
        if (!st.length) return j;
        // After a PowerShell $( ), the word it is in goes on.
        const o = outer.pop();
        if (o) {
          ({wordAt, kc, after} = o);
          if (o.fresh) whole = j + 1;
          start = false;
        } else {
          start = true;
          after = j + 1;
        }
      } else if (top === '(' && dialect === 'ps' && c === '<' && s[j + 1] === '#') {
        const k = s.indexOf('#>', j + 2);
        j = k < 0 ? n : k + 1;
        start = true;
      } else if (top === '(' && c === '#' && (start || ends(j))) {
        j = eol(j) - 1;
      } else {
        const sep = dialect === 'ps' ? psSpace(c) || /[\r\n;&|{}<>]/.test(c) : /[ \t\n;&|<>]/.test(c);
        if ((start || ends(j)) && !sep) wordAt = j;
        start = sep;
      }
    }
    return n;
  };
  // The legacy reading's end of a $( ): it knows quotes and nothing else, so
  // a $( ) inside double quotes is text there.
  const closeLegacy = (from) => {
    let depth = 1;
    let q = null;
    for (let j = from; j < n; j++) {
      const c = s[j];
      if (q) {
        if (c === q) q = null;
        else if (c === esc && q === '"') j++;
      } else if (c === "'" || c === '"') q = c;
      else if (c === esc) j++;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j;
    }
    return n;
  };
  const sub = (i) => {
    const j = legacy ? closeLegacy(i + 2) : close(i + 2);
    subs.push(s.slice(i + 2, j));
    add(s.slice(i, j + 1), true);
    return j + 1;
  };
  // A $( inside PowerShell double quotes: its text, read as code once each
  // `" and "" in it is one ".
  const inString = (i) => {
    const j = parens(s, i + 2);
    subs.push(psSubText(s.slice(i + 2, j)));
    add(s.slice(i, j + 1), true);
    return j + 1;
  };
  const isVar = (i) => s[i] === '$' && /[A-Za-z_{(?!$@*#0-9]/.test(s[i + 1] ?? '');
  // A token surely starts at `i` in pwsh where no word is open here and the
  // character before is a space, a tab, a newline or one of ;|&(){}.
  const tokenStart = (i) => w === null && (i === 0 || /[ \t\r\n;|&(){}]/.test(s[i - 1]));
  // Where the last quoted string or $( ) that started a word ended, and
  // where the last ) did.
  let whole = -1;
  let after = -1;
  let steps = 0;
  while (i < n) {
    if ((++steps & 0xffff) === 0) inTime();
    const c = s[i];
    // In PowerShell a quoted string or a $( ) that starts a word ends it,
    // unless a member or an index follows: git "push"x is git, push and x
    // (scratch q83/probe-after*.ps1). The legacy reading joins them.
    if (whole === i && w && dialect === 'ps' && !legacy && c !== '.' && c !== '[' && !(c === ':' && s[i + 1] === ':')) end();
    // An escape before a newline. bash joins the lines at \ LF. At \ CR LF
    // Git Bash joins them too, as it drops the CR, and bash on Linux reads an
    // escaped CR, so the LF ends the command. pwsh reads ` and a newline as a
    // space where a token starts, and after a quoted string or a $( ) that
    // started a word. Inside another word it reads by that word (psKind): a
    // space after an expression, or the parameter's last character before a
    // newline that ends the command. Any other word pwsh reads by where it
    // is: an escaped LF, part of the word, or an escaped CR, and the LF ends
    // the command, but a space where it reads an expression. Without `split`
    // the lines join, as main's reading joined them. With it, in PowerShell,
    // a word this hook can't place is read as one the escape is inside ('in')
    // or ends ('start'). Any other escape is the character it makes: in
    // PowerShell `n is a LF (psEscape), but not in the legacy reading.
    if (c === esc && dialect !== 'cmd') {
      const nl = isNl(i + 1) ? 1 : s[i + 1] === '\r' && s[i + 2] === '\n' ? 2 : 0;
      if (nl && cr) {
        const kind = tokenStart(i) || whole === i ? 'start' : ((w ? psKind(s, wAt, i, kinds, wAt === after, psEnds) : null) ?? split.ps);
        if (kind === 'start') {
          end();
          i += nl + 1;
          continue;
        }
        if (kind === 'param') {
          end();
          i++;
          continue;
        }
        if (nl === 1) {
          i += 2;
          continue;
        }
      } else if (nl === 1 || (nl === 2 && !(split && dialect === 'sh'))) {
        i += nl + 1;
        continue;
      }
      if (i + 1 < n && dialect === 'ps' && !legacy) {
        const [text, len] = psEscape(s, i + 1);
        add(text);
        i += 1 + len;
        continue;
      }
      if (i + 1 < n) add(s[i + 1]);
      i += 2;
      continue;
    }
    if (c === '^' && dialect === 'cmd') {
      if (i + 1 < n && s[i + 1] !== '\n') add(s[i + 1]);
      i += 2;
      continue;
    }
    // bash's $'...': a backslash escapes the next character, a quote
    // included, and is decoded as bash decodes it (ansiC). The legacy reading
    // keeps the character after it.
    if (dialect === 'sh' && c === '$' && s[i + 1] === "'") {
      let j = i + 2;
      let text = '';
      while (j < n && s[j] !== "'") {
        if (s[j] === '\\' && j + 1 < n) {
          text += s[j + 1];
          j += 2;
        } else text += s[j++];
      }
      add(legacy ? text : ansiC(s.slice(i + 2, Math.min(j, n))));
      i = j + 1;
      continue;
    }
    if (c === "'" && dialect !== 'cmd') {
      const fresh = w === null;
      let j = i + 1;
      let text = '';
      for (;;) {
        const k = s.indexOf("'", j);
        if (k < 0) {
          text += s.slice(j);
          j = n;
          break;
        }
        text += s.slice(j, k);
        if (dialect === 'ps' && s[k + 1] === "'") {
          text += "'";
          j = k + 2;
          continue;
        }
        j = k + 1;
        break;
      }
      add(text);
      i = j;
      if (fresh) whole = i;
      continue;
    }
    if (c === '"') {
      const fresh = w === null;
      add('');
      let j = i + 1;
      while (j < n && s[j] !== '"') {
        if (s[j] === esc && dialect === 'ps' && !legacy && j + 1 < n) {
          // pwsh's escapes, `n and ` and a LF included, as psEscape reads them.
          const [text, len] = psEscape(s, j + 1);
          add(text);
          j += 1 + len;
        } else if (s[j] === esc && dialect !== 'cmd') {
          const next = s[j + 1];
          if (dialect === 'ps' || '$`"\\\n'.includes(next ?? '')) {
            if (next !== '\n' && next !== undefined) add(next);
            j += 2;
          } else {
            add(s[j]);
            j++;
          }
        } else if (s[j] === '$' && s[j + 1] === '(' && dialect !== 'cmd') {
          j = dialect === 'ps' && !legacy ? inString(j) : sub(j);
        } else if (s[j] === '`' && dialect === 'sh') {
          const k = s.indexOf('`', j + 1);
          subs.push(s.slice(j + 1, k < 0 ? n : k));
          add('`', true);
          j = k < 0 ? n : k + 1;
        } else {
          add(s[j], dialect !== 'cmd' && isVar(j));
          j++;
        }
        if (dialect === 'ps' && s[j] === '"' && s[j + 1] === '"') {
          add('"');
          j += 2;
        }
      }
      i = j + 1;
      if (fresh) whole = i;
      continue;
    }
    if (dialect !== 'cmd' && c === '$' && s[i + 1] === '(') {
      const fresh = w === null;
      i = sub(i);
      if (fresh) whole = i;
      continue;
    }
    // PowerShell's ${name} is one variable.
    if (dialect === 'ps' && c === '$' && s[i + 1] === '{') {
      const k = s.indexOf('}', i + 2);
      add(s.slice(i, k < 0 ? n : k + 1), true);
      i = k < 0 ? n : k + 1;
      continue;
    }
    if (dialect === 'sh' && c === '`') {
      const k = s.indexOf('`', i + 1);
      subs.push(s.slice(i + 1, k < 0 ? n : k));
      add('`', true);
      i = k < 0 ? n : k + 1;
      continue;
    }
    // bash's $"..." is a double-quoted string, translated where a translation
    // exists: $"git" push runs git push. The legacy reading keeps the $.
    if (dialect === 'sh' && !legacy && c === '$' && s[i + 1] === '"') {
      i++;
      continue;
    }
    if (c === '$' && dialect !== 'cmd') {
      add(c, isVar(i));
      i++;
      continue;
    }
    if (c === '%' && dialect === 'cmd') {
      add(c, true);
      i++;
      continue;
    }
    if (dialect === 'sh' && cases.length && (c === '(' || c === ')' || c === ';')) {
      // The word before it may be the esac that ends the case.
      end();
      const top = cases.length - 1;
      // A case pattern: a ( before it opens no subshell, and its ) closes
      // none. Its words are dropped, as they are not a command.
      if (cases[top] === 'pat' && c !== ';') {
        if (c === ')') {
          words = [];
          lead = true;
          cases[top] = 'list';
        } else lead = false;
        i++;
        continue;
      }
      // ;; ;& and ;;& end a case item: a pattern comes next.
      if (cases[top] === 'list' && c === ';' && (s[i + 1] === ';' || s[i + 1] === '&')) {
        brk();
        cases[top] = 'pat';
        i += s[i + 1] === ';' && s[i + 2] === '&' ? 3 : 2;
        continue;
      }
    }
    // In PowerShell a script block's braces also end a command:
    // try { git push } catch { }, ForEach-Object { git ... }.
    if (isNl(i) || c === ';' || c === '(' || c === ')' || (dialect === 'ps' && (c === '{' || c === '}'))) {
      brk();
      if (c === ')') after = i + 1;
      // In sh, ( ) is a subshell: a cd inside it ends with it.
      if (dialect === 'sh' && (c === '(' || c === ')')) cmds.push(c === '(' ? SUB_OPEN : SUB_CLOSE);
      i++;
      continue;
    }
    if (c === '&' || c === '|') {
      if (c === '&' && s[i + 1] === '>') {
        end();
        i += 2;
        if (s[i] === '>') i++;
        dropNext = true;
        continue;
      }
      if (s[i + 1] === c) {
        brk();
        i += 2;
        continue;
      }
      // PowerShell's call operator at a command's start is not a separator.
      if (c === '&' && dialect === 'ps' && !w && !words.length) {
        i++;
        continue;
      }
      brk();
      i++;
      continue;
    }
    // A PowerShell block comment, <# ... #>.
    if (dialect === 'ps' && c === '<' && s[i + 1] === '#') {
      end();
      const k = s.indexOf('#>', i + 2);
      i = k < 0 ? n : k + 2;
      continue;
    }
    if (c === '>' || c === '<') {
      if (w && /^\d+$/.test(w.text) && !w.dyn) w = null;
      else end();
      while (s[i] === '>' || s[i] === '<') i++;
      if (s[i] === '&') {
        i++;
        while (i < n && /[0-9-]/.test(s[i])) i++;
      } else dropNext = true;
      continue;
    }
    if (c === '#' && !w && dialect !== 'cmd') {
      i = eol(i);
      continue;
    }
    // A space as the shell reads one (see `space`).
    if (space(c)) {
      end();
      i++;
      continue;
    }
    add(c);
    i++;
  }
  brk();
  return {cmds, subs};
}

const program = (word) => basename(String(word).replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const POP = new Set(['popd', 'pop-location']);
const PUSH = new Set(['pushd', 'push-location']);
const GIT_TAKES_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'time']);
// Programs that run the command after them, and their options that take a
// value as the next word, short and long (a long one given as --name=value
// is one word).
const WRAPPERS = new Map([
  ['sudo', /^(-[ugCDhpRrT]|--(user|group|chdir|host|prompt|role|type|close-from|other-user))$/],
  ['doas', /^-[uC]$/],
  ['command', null],
  ['builtin', null],
  ['exec', /^-a$/],
  ['nohup', null],
  ['nice', /^(-n|--adjustment)$/],
  ['stdbuf', /^(-[ioe]|--(input|output|error))$/],
  ['xargs', /^(-[IdEaLnPs]|--(delimiter|arg-file|max-args|max-procs|max-chars|process-slot-var))$/],
  ['env', /^(-[uCS]|--(unset|chdir|split-string))$/],
  ['timeout', /^(-[ks]|--(kill-after|signal))$/],
  ['wsl', /^(-d|--distribution|-u|--user|--cd|--shell-type)$/],
]);
// Marks in a command list where an sh subshell opens and closes.
const SUB_OPEN = [];
const SUB_CLOSE = [];
const SH = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PWSH = new Set(['pwsh', 'powershell']);
const assignment = (t) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t);

// A folder named in a command, from the folder `from`: a path that can't be
// told (a variable, a substitution) leaves the folder as it was. `~` is the
// home folder.
function move(from, word) {
  if (from === null || word === undefined) return from;
  if (word.dyn) return from;
  let to = native(word.text);
  if (to === '-' || to === '') return from;
  if (to === '~' || to.startsWith('~/') || to.startsWith('~\\')) {
    if (!HOME) return from;
    to = join(HOME, to.slice(1));
  }
  if (unc(to) || tooLong(to)) return null;
  const at = resolve(from, to);
  return tooLong(at) ? null : at;
}

// Each git commit or push and each lookup in a command, in order, with the
// folder it runs in: git's -C <dir>, --work-tree or --git-dir, else the last
// cd, Set-Location or pushd before it, else `cwd`.
function walk(command, dialect, cwd, out = [], depth = 0, legacy = false, split = null) {
  if (depth > MAX_DEPTH || typeof command !== 'string') return out;
  inTime();
  const {cmds, subs} = tokenize(command, dialect, legacy, split);
  for (const body of subs) walk(body, dialect, cwd, out, depth + 1, legacy, split);
  let cur = cwd;
  let prev;
  const stack = [];
  const scopes = [];
  const go = (to) => {
    prev = cur;
    cur = to;
  };
  for (const words of cmds) {
    if (words === SUB_OPEN) {
      scopes.push([cur, prev]);
      continue;
    }
    if (words === SUB_CLOSE) {
      if (scopes.length) [cur, prev] = scopes.pop();
      continue;
    }
    let k = 0;
    // A folder for this one command (env -C, wsl --cd).
    let here = cur;
    for (;;) {
      const t = words[k]?.text;
      if (t === undefined) break;
      if (assignment(t) || KEYWORDS.has(t)) {
        k++;
        continue;
      }
      // PowerShell: $out = git ..., $null = git push, $x+=git ...
      if (dialect === 'ps' && t.startsWith('$')) {
        if (/^([-+*/%]|\?\?)?=$/.test(words[k + 1]?.text ?? '')) {
          k += 2;
          continue;
        }
        // One of a list of targets: $a, $b = git push.
        if (/^\$[\w:,$]*,$/.test(t)) {
          k++;
          continue;
        }
        // Joined: $x=git, $a=$b=git. All of them in one pass.
        const m = /^(?:\$[\w:]+(?:[-+*/%]|\?\?)?=)+/.exec(t);
        if (m) {
          const rest = t.slice(m[0].length);
          if (rest) words[k] = {text: rest, dyn: rest.includes('$')};
          else k++;
          continue;
        }
      }
      const wrapper = program(t);
      if (WRAPPERS.has(wrapper)) {
        const takesValue = WRAPPERS.get(wrapper);
        k++;
        while (k < words.length && (words[k].text.startsWith('-') || (wrapper === 'env' && assignment(words[k].text)))) {
          const o = words[k].text;
          if ((wrapper === 'env' && (o === '-C' || o === '--chdir')) || (wrapper === 'wsl' && o === '--cd')) here = move(here, words[k + 1]);
          else if (wrapper === 'env' && o.startsWith('--chdir=')) here = move(here, {text: o.slice(8), dyn: words[k].dyn});
          if (takesValue && takesValue.test(o)) k++;
          k++;
        }
        if (wrapper === 'timeout' && k < words.length) k++;
        continue;
      }
      break;
    }
    if (k >= words.length) continue;
    const name = program(words[k].text);
    const args = words.slice(k + 1);
    if (SH.has(name) || PWSH.has(name) || name === 'cmd') {
      if (SH.has(name)) {
        const at = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a.text));
        if (at >= 0 && args[at + 1]) walk(args[at + 1].text, 'sh', here, out, depth + 1, legacy, split);
      } else if (PWSH.has(name)) {
        const at = args.findIndex((a) => /^-(c|command|co|com|comm|comma|comman)$/i.test(a.text));
        if (at >= 0) walk(args.slice(at + 1).map((a) => a.text).join(' '), 'ps', here, out, depth + 1, legacy, split);
      } else {
        // cmd /c, or cmd //c as Git Bash spells it.
        const at = args.findIndex((a) => /^\/\/?[ck]$/i.test(a.text));
        if (at >= 0) walk(args.slice(at + 1).map((a) => a.text).join(' '), 'cmd', here, out, depth + 1, legacy, split);
      }
      continue;
    }
    if (CD.has(name)) {
      // cd - goes back to the folder before the last cd, if this command named it.
      const arg = args.find((a) => (a.text === '-' || !a.text.startsWith('-')) && a.text.toLowerCase() !== '/d');
      if (PUSH.has(name)) stack.push(cur);
      if (arg !== undefined && arg.text === '-' && !arg.dyn) {
        if (prev !== undefined) go(prev);
      } else if (arg !== undefined) go(move(cur, arg));
      else if (dialect === 'sh' && name === 'cd' && HOME) go(resolve(HOME));
      continue;
    }
    if (POP.has(name)) {
      if (stack.length) go(stack.pop());
      continue;
    }
    if (name === 'git') {
      let dir = here;
      let tree = null;
      let gitDir = null;
      let i = 0;
      while (i < args.length && args[i].text.startsWith('-')) {
        const t = args[i].text;
        const eq = t.indexOf('=');
        const key = eq > 0 ? t.slice(0, eq) : t;
        const value = eq > 0 ? {text: t.slice(eq + 1), dyn: args[i].dyn} : args[i + 1];
        if (key === '-C') dir = move(dir, value);
        else if (key === '--work-tree') tree = value;
        else if (key === '--git-dir') gitDir = value;
        i += GIT_TAKES_VALUE.has(key) && eq < 0 ? 2 : 1;
      }
      const subcommand = args[i]?.text;
      if (subcommand !== 'commit' && subcommand !== 'push') continue;
      const rest = args.slice(i + 1).map((a) => a.text);
      if (rest.includes('--dry-run') || rest.includes('-h') || rest.includes('--help') || (subcommand === 'push' && rest.includes('-n'))) continue;
      if (tree) dir = move(dir, tree);
      else if (gitDir && !gitDir.dyn) {
        const g = move(dir, gitDir);
        dir = g === null ? null : dirname(g);
      }
      out.push({kind: 'git', dir});
      continue;
    }
    if (name === 'node') {
      const at = args.findIndex((a) => !a.text.startsWith('-'));
      if (at < 0 || program(args[at].text) !== 'lessons.mjs') continue;
      let topic = false;
      for (let j = at + 1; j < args.length; j++) {
        // A section name is not a topic word: --section prints no open lesson.
        if (args[j].text === '--dir' || args[j].text === '--section') j++;
        else if (!args[j].text.startsWith('-')) topic = true;
      }
      if (topic) out.push({kind: 'lookup', script: args[at].dyn ? null : move(here, args[at])});
    }
  }
  return out;
}
const dialectOf = (tool) => (tool === 'PowerShell' ? 'ps' : 'sh');

// ---- The line ---------------------------------------------------------------
//
// "Lessons checked", an optional label in parentheses, then ":" (emphasis
// may close before the label or the colon). Before it on its line, only
// space, a quote marker, a heading mark or emphasis; before those, the start
// of the text, a line break, or a sentence end or colon and a space.
// A quote mark or backtick before it is not in that set, so a mention in
// quotes doesn't count. Linear: each match looks back only over the marks.
const LINE_WORDS = 'Lessons checked';
const MAX_LABEL = 200;
const emphasis = (text, i) => {
  let k = i;
  while (k < i + 3 && (text[k] === '*' || text[k] === '_')) k++;
  return k;
};
// Whether what follows the words at `i` ends the line's lead: up to three
// emphasis marks (***bold italic***), a label in parentheses (nested ones
// too, at most MAX_LABEL characters, on one line), up to three marks again,
// then ":".
function lineEnd(text, i) {
  let k = emphasis(text, i);
  if (text[k] === ' ' && text[k + 1] === '(') k++;
  if (text[k] === '(') {
    let depth = 0;
    const stop = Math.min(text.length, k + MAX_LABEL + 2);
    for (; k < stop; k++) {
      const c = text[k];
      if (lineBreak(c)) return false;
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    if (depth !== 0 || k >= stop) return false;
    k++;
  }
  return text[emphasis(text, k)] === ':';
}
const lineBreak = (c) => c === '\n' || c === '\r' || c === LS || c === PS;
function hasLine(text) {
  for (let at = text.indexOf(LINE_WORDS); at >= 0; at = text.indexOf(LINE_WORDS, at + 1)) {
    if (!lineEnd(text, at + LINE_WORDS.length)) continue;
    let j = at - 1;
    while (j >= 0 && !lineBreak(text[j]) && /[\s>*_#-]/.test(text[j])) j--;
    if (j < 0 || lineBreak(text[j])) return true;
    if ('.!?:'.includes(text[j]) && /\s/.test(text[j + 1])) return true;
  }
  return false;
}

// ---- The transcript ---------------------------------------------------------

function readAt(fd, buf, pos) {
  let got = 0;
  while (got < buf.length) {
    const n = readSync(fd, buf, got, buf.length - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return got === buf.length ? buf : buf.subarray(0, got);
}
const parse = (line) => {
  try {
    const v = JSON.parse(line.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const blocks = (r) => (r.message && Array.isArray(r.message.content) ? r.message.content.filter((b) => b && typeof b === 'object') : []);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Waits until the transcript holds the assistant record of the current call,
// and returns where that record's line ends; null if it isn't there within
// POLL_FOR. Each look reads the file's last chunk, and the last look reads the
// whole window, for a record that over a chunk of later records follows (the
// large results of earlier calls of the same message). What comes after the
// record is not read. A record cut at the start of the window read (a large
// Write) widens the window, and at the whole window it is skipped. A first
// line that a line feed right before the window ends is whole, not cut. An
// assistant record that holds the call's id, but not as the id of a tool_use
// block in its message content, may be the call in a shape the gate doesn't
// read: when the last look finds one and not the call, it returns UNREAD.
// The id in a record of any other type is no sign the call is on disk, as
// Claude Code writes data-flow-records lines that name a call's id before
// the call's own record. Past the deadline, a look that found neither stops
// the wait (inTime); a look under way then still finishes first.
const UNREAD = -1;
async function waitForCall(fd, id) {
  const needle = Buffer.from(JSON.stringify(id));
  const start = Date.now();
  for (;;) {
    const last = Date.now() - start >= POLL_FOR;
    const size = Number(fstatSync(fd).size);
    let win = last ? MAX_WINDOW : CHUNK;
    let odd = false;
    for (;;) {
      const from = Math.max(0, size - win);
      const buf = readAt(fd, Buffer.alloc(size - from), from);
      let grow = from > 0 && buf.lastIndexOf(10, buf.length - 2) < 0;
      for (let i = buf.indexOf(needle); i >= 0 && !grow; i = buf.indexOf(needle, i + 1)) {
        const a = buf.lastIndexOf(10, i) + 1;
        if (a === 0 && from > 0 && readAt(fd, Buffer.alloc(1), from - 1)[0] !== 10) {
          if (win < MAX_WINDOW) {
            grow = true;
            break;
          }
          i = buf.indexOf(10, i);
          if (i < 0) break;
          continue;
        }
        const b = buf.indexOf(10, i);
        const r = parse(buf.subarray(a, b < 0 ? buf.length : b));
        if (!r || r.type !== 'assistant') continue;
        if (blocks(r).some((x) => x.type === 'tool_use' && x.id === id)) return from + (b < 0 ? buf.length : b + 1);
        odd = true;
      }
      if (!grow || win >= MAX_WINDOW) break;
      win = Math.min(win * 4, MAX_WINDOW);
    }
    if (odd && last) return UNREAD;
    inTime();
    if (last) return null;
    await sleep(POLL_EVERY);
  }
}

// Whether the transcript holds a user or assistant record of this session
// (its sessionId is the payload's session_id), read back from its end. Then
// it is the file Claude Code writes for the session, and a call not found in
// it is late, or in a record type the gate doesn't read the call from (a new
// type, or a user record), which it can't tell apart. Past the deadline it
// stops.
function ownTranscript(fd, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  const quoted = JSON.stringify(sessionId);
  let found = false;
  readBack(fd, Number(fstatSync(fd).size), (line) => {
    inTime();
    if (!line.includes('"sessionId"') || !line.includes(quoted)) return false;
    const r = parse(line);
    found = r !== null && (r.type === 'user' || r.type === 'assistant') && r.sessionId === sessionId;
    return found;
  });
  return found;
}

// A record that starts a turn. With the payload's prompt_id (current Claude
// Code), a user record with turnPosition that isn't a compaction summary.
// Without it (older versions), a user record that a person typed: not meta,
// not a tool result, not a slash command's record, not the interrupt marker.
function startsTurn(r, modern) {
  if (r.type !== 'user' || r.isSidechain === true || r.isCompactSummary === true) return false;
  if (r.turnPosition) return true;
  if (modern || 'turnPosition' in r || r.isMeta === true) return false;
  const content = r.message && r.message.content;
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === 'tool_result')) return false;
    const first = content.find((b) => b && b.type === 'text');
    text = first && typeof first.text === 'string' ? first.text : '';
  } else return false;
  return !/^\s*(<command-|<local-command|\[Request interrupted)/.test(text);
}

// A turn start that only tells the session a background task finished. It
// carries on the turn before it, so a line written there still counts (and a
// commit or push there still uses it up). A record that says where it came
// from (turnOrigin, origin.kind) is taken at its word; only one with neither
// field is told by its text, so a prompt that starts with the tag is not one.
function wakeUp(r) {
  const kind = r.origin && typeof r.origin === 'object' ? r.origin.kind : undefined;
  if (r.turnOrigin !== undefined || kind !== undefined) return kind === 'task-notification' || r.turnOrigin === 'task_notification';
  const content = r.message && r.message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? (content.find((b) => b && b.type === 'text') || {}).text : '';
  return typeof text === 'string' && /^\s*<task-notification>/.test(text);
}

// Whether a command, or a transcript line holding one, may name git. A shell
// reads git from g, i and t with only quotes, escapes, a line join or a CR
// between them (g'i't, gi\ and a LF, g<CR>it in Git Bash and cmd), in any
// case (GIT runs git on Windows and macOS), or from an escape that makes a
// letter (bash's $'\x67it', pwsh's `u{67}). So the text, lowercased, is taken
// if it holds $' or `u{, or if its letters and digits hold git once all
// else is dropped, or once JSON's escapes (\n, \r, \\ and \u with four hex
// digits) are dropped too, each read from the left, so in g\r\\it the \\ is
// one escape and the i a letter. Other characters between them make git
// only where the shell expands them when it runs (g$1it, g${9}it), which
// the gate can't read in any case (SECURITY.md, the known limits). It may
// take more than it needs: that only costs a read. A transcript line is a
// Buffer.
const NOT_ALNUM = /[^a-z0-9]+/g;
const JSON_ESC = /\\(?:u[0-9a-f]{4}|[^])/g;
function mayNameGit(text) {
  if (text.includes('git') || text.includes("$'")) return true;
  const t = String(text).toLowerCase();
  if (t.includes('git') || t.includes('`u{')) return true;
  return t.replace(NOT_ALNUM, '').includes('git') || t.replace(JSON_ESC, '').replace(NOT_ALNUM, '').includes('git');
}
// A transcript line is also read if it holds a CR (JSON's \r after an even
// run of backslashes), as main's reading read it, so the lines read are
// never fewer than there.
const JSON_CR = /(?:^|[^\\])(?:\\\\)*\\r/;
const mayRunGit = (line) => line.includes('lessons.mjs') || JSON_CR.test(line) || mayNameGit(line);

// The records of this turn, oldest first, read backwards from `size` in
// chunks until the turn's start (past any wake-up starts), at most
// MAX_WINDOW bytes. Only lines that
// can matter are parsed: assistant text that may hold the line and tool calls
// that may be a lookup or a commit or push, user records that can start a
// turn, and tool results of calls that never ran. The tests on the raw text
// use quoted words, never a key with its colon, so JSON written with spaces
// passes them the same.
function readTurn(fd, size, modern) {
  const found = [];
  let start = null;
  const take = (line) => {
    const text = line.includes('"text"') && line.includes(LINE_WORDS);
    const call = line.includes('"tool_use"') && mayRunGit(line);
    const asst = (text || call) && line.includes('"assistant"');
    const user =
      line.includes('"user"') &&
      ((modern ? line.includes('"turnPosition"') : !line.includes('"tool_result"')) || line.includes('"toolDenialKind"') || line.includes('<tool_use_error>') || line.includes(DENY_MARK));
    if (!asst && !user) return false;
    const r = parse(line);
    if (!r || r.isSidechain === true) return false;
    if (r.type === 'assistant') found.push(r);
    else if (r.type === 'user') {
      if (startsTurn(r, modern)) {
        // The latest start is the payload's turn, for the prompt_id check.
        start ??= r;
        return !wakeUp(r);
      }
      found.push(r);
    }
    return false;
  };
  readBack(fd, size, take);
  return {records: found.reverse(), start};
}

// Each line of the file before `size`, last first, given to `take` as a
// Buffer, until `take` returns true or MAX_WINDOW bytes have been read. At the
// window's start a cut first line is left out.
function readBack(fd, size, take) {
  let pos = size;
  let carry = Buffer.alloc(0);
  let read = 0;
  outer: while (pos > 0 && read < MAX_WINDOW) {
    const n = Math.min(CHUNK, pos, MAX_WINDOW - read);
    pos -= n;
    read += n;
    const buf = Buffer.concat([readAt(fd, Buffer.alloc(n), pos), carry]);
    let first = 0;
    if (pos > 0 && read < MAX_WINDOW) {
      const nl = buf.indexOf(10);
      if (nl < 0) {
        carry = buf;
        continue;
      }
      carry = buf.subarray(0, nl);
      first = nl + 1;
    }
    // At the window's start a cut first line is left out: it doesn't parse.
    let end = buf.length;
    while (end > first) {
      while (end > first && buf[end - 1] === 10) end--;
      if (end <= first) break;
      const nl = buf.lastIndexOf(10, end - 1);
      const from = nl < first ? first : nl + 1;
      if (take(buf.subarray(from, end))) break outer;
      end = nl < first ? first : nl;
    }
  }
}

// The ids of tool calls in these records that never ran: refused by a hook,
// a permission rule or the user (Claude Code marks those toolDenialKind), or
// rejected by the tool before it started.
function notRun(records) {
  const ids = new Set();
  for (const r of records) {
    if (r.type !== 'user') continue;
    for (const b of blocks(r)) {
      if (b.type !== 'tool_result') continue;
      const c = b.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n') : '';
      const refused = typeof r.toolDenialKind === 'string' && r.toolDenialKind !== '';
      const ours = b.is_error === true && [REASON_LOOKUP, REASON_LINE, REASON_LATE, REASON_UNSEEN, ...OLD_REASONS].some((x) => text.includes(x));
      if (refused || ours || (b.is_error === true && text.trimStart().startsWith('<tool_use_error>'))) ids.add(b.tool_use_id);
    }
  }
  return ids;
}

// Whether the turn holds the line, and a lookup of the session repo's script,
// after its last commit or push to a gated repo (a call that never ran
// doesn't count), up to the current call: a later call of the same message is
// on disk too, and is left out. In the current call, a lookup before its first
// such commit or push counts. Commands are read by ctx.read: the legacy way if
// ctx.legacy, and with each CR and escape before a newline read the ctx.split
// way if it is set.
function judge(records, id, ctx) {
  const skip = notRun(records);
  const v = verdict(ctx);
  for (const r of records) {
    if (r.type !== 'assistant') continue;
    const rcwd = typeof r.cwd === 'string' && isAbsolute(r.cwd) && !unc(r.cwd) ? r.cwd : ctx.cwd;
    for (const b of blocks(r)) {
      if (b.type === 'text' && typeof b.text === 'string') v.text(b.text);
      else if (b.type === 'tool_use' && typeof b.id === 'string') {
        // Nothing at or after the current call counts.
        if (b.id === id) return v.finish();
        if (skip.has(b.id) || !SHELL_TOOLS.has(b.name) || !b.input || typeof b.input.command !== 'string') continue;
        ctx.seen.note(b.input.command);
        v.ran(ctx.read(b.input.command, dialectOf(b.name), rcwd));
      }
    }
  }
  return v.finish();
}

// The verdict, built up in the turn's order: text that may hold the line, and
// the commits, pushes and lookups of each call that ran. A commit or push to a
// gated repo uses up the line and the lookup. Last, the current call: a
// lookup before its first such commit or push counts.
function verdict(ctx) {
  let line = false;
  let lookup = false;
  const apply = (events, stopAtGated) => {
    for (const e of events) {
      if (e.kind === 'lookup') {
        if (ctx.isScript(e.script)) lookup = true;
      } else if (ctx.gated(e.dir)) {
        if (stopAtGated) return;
        line = false;
        lookup = false;
      }
    }
  };
  return {
    text: (text) => {
      if (hasLine(text)) line = true;
    },
    ran: (events) => apply(events, false),
    finish: () => {
      if (ctx.current) apply(ctx.current, true);
      return {line, lookup};
    },
  };
}

// ---- Codex ------------------------------------------------------------------
//
// Codex sends `turn_id` in the payload, and its transcript is the session's
// rollout file, whose first record is `session_meta`. As read from Codex
// 0.171's source and local rollouts: a shell command comes as tool `Bash` with
// `tool_input.command` the script the model gave, run in the user's default
// shell (PowerShell on Windows), and the payload's `cwd` is the folder it
// runs in; an edit comes as `apply_patch` with the patch text in
// `tool_input.command`, its paths relative to the payload's `cwd`. Codex
// writes and flushes each item to the rollout before the tool runs, and waits
// for the file before it starts a hook, so there is nothing to wait for. A
// command that ran is an `item_completed` event with a `CommandExecution`
// item: its argv, its folder as a file URL, and its status.

const CODEX_EDIT = 'apply_patch';
const MAX_TARGETS = 512; // files named in a patch looked at; past that, the patch passes
const MAX_PATCH_PARTS = 16384; // names in all of a patch's paths looked at; past that, the patch passes
// Codex's patch parser trims a line before it looks for a header.
const PATCH_FILE = /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to): ([^]*)$/;

// Whether the file at `path` is a Codex rollout: a regular file whose first
// record is session_meta (its type comes after a timestamp and an ordinal).
function rolloutAt(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return false;
    const head = readAt(fd, Buffer.alloc(512), 0).toString('utf8');
    const nl = head.indexOf('\n');
    return (nl < 0 ? head : head.slice(0, nl)).includes('"session_meta"');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The files a patch adds, updates, deletes or moves to, as written in it;
// null when there are too many to look at. Each name in a path costs a look
// on disk, so the names in all the paths share one budget.
function patchTargets(patch) {
  const out = [];
  let parts = 0;
  for (const raw of patch.split('\n')) {
    const m = PATCH_FILE.exec(raw);
    if (!m) continue;
    // trim also takes off a CR before the line break.
    const name = m[1].trim();
    if (!name) continue;
    if (out.length >= MAX_TARGETS) return null;
    parts += name.split(/[\\/]/).length;
    if (parts > MAX_PATCH_PARTS) return null;
    out.push(name);
  }
  return out;
}

// A record's folder, given as a file URL (file:///E:/Code/x) or a plain
// absolute path. Anything else, a host in the URL included, is null.
function fileUrl(u) {
  if (typeof u !== 'string') return null;
  let p = u;
  if (u.startsWith('file://')) {
    if (!u.startsWith('file:///')) return null;
    try {
      p = decodeURIComponent(u.slice(7));
    } catch {
      return null;
    }
    if (process.platform === 'win32') {
      if (!/^\/[A-Za-z]:\//.test(p)) return null;
      p = p.slice(1).replace(/\//g, '\\');
    }
  }
  return isAbsolute(p) && !unc(p) && !tooLong(p) ? p : null;
}

// A command that ran, from its argv, as an sh command with each word quoted,
// so its words are read as they were run. The command reader then reads the
// script after pwsh -Command, bash -c or cmd /c in that shell's rules.
function argvCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) return null;
  return argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
}

// The records of this turn, oldest first, read backwards from the end to the
// turn's task_started event. Only lines that can matter are parsed: the
// turn's start, visible assistant text that may hold the line, and commands
// that ran and may be a lookup or a commit or push. `other` is set when the
// latest turn start is another turn's, a shape not expected.
function readCodexTurn(fd, size, turnId) {
  const found = [];
  let start = false;
  let other = false;
  readBack(fd, size, (line) => {
    const begins = line.includes('"task_started"');
    const text = line.includes(LINE_WORDS) && (line.includes('"AgentMessage"') || line.includes('"assistant"'));
    const ran = line.includes('"CommandExecution"') && mayRunGit(line);
    if (!begins && !text && !ran) return false;
    const r = parse(line);
    const q = r && r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload) ? r.payload : null;
    if (!q) return false;
    if (r.type === 'event_msg' && q.type === 'task_started') {
      if (q.turn_id === turnId) start = true;
      else other = true;
      return true;
    }
    found.push(r);
    return false;
  });
  return {records: found.reverse(), start, other};
}

// The text of a message's content: Codex's output_text blocks, or the Text
// blocks of an AgentMessage item.
const texts = (content) => (Array.isArray(content) ? content.filter((c) => c && (c.type === 'output_text' || c.type === 'Text') && typeof c.text === 'string').map((c) => c.text) : []);

function judgeCodex(records, turnId, ctx) {
  const v = verdict(ctx);
  for (const r of records) {
    const q = r.payload;
    // An event of another turn, should one be here, is not this turn's.
    if (q.turn_id !== undefined && q.turn_id !== turnId) continue;
    if (r.type === 'response_item' && q.type === 'message' && q.role === 'assistant') texts(q.content).forEach(v.text);
    else if (r.type === 'event_msg' && q.type === 'item_completed' && q.item && typeof q.item === 'object') {
      const item = q.item;
      if (item.type === 'AgentMessage') texts(item.content).forEach(v.text);
      else if (item.type === 'CommandExecution' && (item.status === 'completed' || item.status === 'failed')) {
        const c = argvCommand(item.command);
        if (!c) continue;
        ctx.seen.note(c);
        v.ran(ctx.read(c, 'sh', fileUrl(item.cwd) ?? ctx.cwd));
      }
    }
  }
  return v.finish();
}

function readPayload() {
  let text = readFileSync(0, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const p = JSON.parse(text);
  return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
}

async function main() {
  if (process.env.LESSONS_GATE === 'off') return;
  const p = readPayload();
  if (!p || p.agent_id) return;
  if (p.hook_event_name !== undefined && p.hook_event_name !== 'PreToolUse') return;
  const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const cwd = typeof p.cwd === 'string' && isAbsolute(p.cwd) && !unc(p.cwd) && !tooLong(p.cwd) ? p.cwd : null;
  // The repo each folder is in, if it has the check; looked up once each.
  const rootOf = new Map();
  const gatedRoot = (dir) => {
    if (dir === null || dir === undefined || unc(dir) || tooLong(dir)) return null;
    if (!rootOf.has(dir)) {
      const real = realOf(dir);
      const root = real && findRoot(real);
      rootOf.set(dir, root && hasCheck(root) ? root : null);
    }
    return rootOf.get(dir);
  };
  // The gated repo an edit of `raw` is in, unless the file is exempt.
  const editRoot = (raw) => {
    if (typeof raw !== 'string' || !raw || unc(raw) || tooLong(raw)) return null;
    const given = native(raw);
    const abs = isAbsolute(given) ? given : cwd && resolve(cwd, given);
    if (!abs) return null;
    const target = nearestReal(abs);
    if (!target) return null;
    const root = findRoot(dirname(target.real));
    return root && hasCheck(root) && !exempt(abs, target, root) ? root : null;
  };
  // Codex: the payload names its turn (Claude Code's doesn't) and its
  // transcript is a rollout. Its commands run in the user's shell, PowerShell
  // on Windows.
  const id = p.tool_use_id;
  const tp = p.transcript_path;
  if (typeof tp !== 'string' || !isAbsolute(tp) || unc(tp)) return;
  const turnId = typeof p.turn_id === 'string' && p.turn_id !== '' ? p.turn_id : null;
  const codex = turnId !== null && rolloutAt(tp);
  const roots = new Set();
  // The current call's commands, read as this hook reads them, the legacy
  // way, and each split way that reads them otherwise (see "Reading a
  // command"). A command holding no CR reads the same with either `sh` way,
  // one holding no ` the same with either `ps` way, and one holding neither
  // a CR nor a ` and a LF the same as without `split`. Inner commands are cut
  // from the command's text, and no reading makes a CR or a ` of other
  // characters, or a LF of anything but a CR, but for an escape a reading
  // decodes: bash's $'...' or pwsh's `r, `n or `u{ }. A text with one is
  // taken to hold all three, so the text tells.
  const SPLITS = [
    {sh: 'linux', ps: 'in'},
    {sh: 'linux', ps: 'start'},
    {sh: 'git', ps: 'in'},
    {sh: 'git', ps: 'start'},
  ];
  const needs = (text) => {
    const decoded = text.includes("$'") || /`[rnu]/.test(text);
    const cr = decoded || text.includes('\r');
    const tick = decoded || text.includes('`');
    const lf = decoded || text.includes('\n');
    const need = SPLITS.map((x) => (x.ps === 'in' || tick) && (cr || (tick && lf && x.sh === 'linux')));
    return Object.assign(need, {cr, tick});
  };
  // The reading that stands for split k of a text whose `need` doesn't hold
  // it: its `in` partner if the text holds no `, else its `linux` partner if
  // it holds no CR, each in turn, down to -1, the plain reading.
  const standIn = (k, need) => {
    while (k >= 0 && !need[k]) {
      if (SPLITS[k].ps === 'start' && !need.tick) k -= 1;
      else if (SPLITS[k].sh === 'git' && !need.cr) k -= 2;
      else return -1;
    }
    return k;
  };
  let current = null;
  let currentLegacy = null;
  let currentSplit = [];
  if (!codex && EDIT_TOOLS.has(p.tool_name)) {
    const root = editRoot(typeof input.file_path === 'string' ? input.file_path : input.notebook_path);
    if (!root) return;
    roots.add(root);
  } else if (codex && p.tool_name === CODEX_EDIT) {
    if (typeof input.command !== 'string') return;
    const targets = patchTargets(input.command);
    if (!targets) return;
    for (const raw of targets) {
      const root = editRoot(raw);
      if (root) roots.add(root);
    }
    if (!roots.size) return;
  } else if (SHELL_TOOLS.has(p.tool_name) && (!codex || p.tool_name === 'Bash')) {
    const command = input.command;
    if (typeof command !== 'string' || !mayNameGit(command)) return;
    const dialect = !codex ? dialectOf(p.tool_name) : process.platform === 'win32' ? 'ps' : 'sh';
    current = walk(command, dialect, cwd);
    currentLegacy = walk(command, dialect, cwd, [], 0, true);
    const own = needs(command);
    SPLITS.forEach((x, k) => {
      const at = standIn(k, own);
      currentSplit[k] = at === k ? walk(command, dialect, cwd, [], 0, false, x) : at < 0 ? current : currentSplit[at];
    });
    for (const e of [current, currentLegacy, ...currentSplit].flat()) {
      const root = e.kind === 'git' ? gatedRoot(e.dir) : null;
      if (root) roots.add(root);
    }
    if (!roots.size) return;
  } else return;

  if (!codex && (typeof id !== 'string' || !id)) return;
  // The lookup is asked for only in the session's own repo. The deny asks
  // for it from the repo's top folder, where `node dev/lessons.mjs` runs
  // the script whose hash was checked.
  const home = cwd && gatedRoot(cwd);
  const needLookup = home !== null && home !== undefined && roots.has(home) && scriptMatches(home);
  // Whether a command of the turn reads otherwise in a split reading. Judging
  // with ctx, the first reading, notes each command; only then is the turn
  // read so. If one does, every split reading runs, even one that no one
  // command needs: each command is read in its own stand-in, so that reading
  // still pairs two commands' partners, such as a Bash call read the Git Bash
  // way with a PowerShell call read the `start` way. Its walks are all made
  // for the other readings already.
  const seen = {
    any: false,
    note(text) {
      if (!this.any && needs(text).some(Boolean)) this.any = true;
    },
  };
  if (current) seen.note(input.command);
  const ctx = {
    cwd,
    current,
    legacy: false,
    split: null,
    seen,
    gated: (dir) => {
      const root = gatedRoot(dir);
      return root !== null && roots.has(root);
    },
    isScript: (script) => {
      if (!needLookup || !script) return false;
      const real = realOf(script);
      return real !== null && isInRepo(real, home, ['dev', 'lessons.mjs']);
    },
  };
  // The turn is judged with each reading, and passes only if all pass.
  const ctxLegacy = {...ctx, current: currentLegacy, legacy: true};
  const ctxSplit = SPLITS.map((x, k) => ({...ctx, current: currentSplit[k] ?? null, split: x, k}));
  // Each command of the turn is walked once for each reading it can read
  // otherwise in: a split reading it doesn't need is the one that stands for
  // it. Nothing changes a walk's events after it is made.
  const walked = new Map();
  const reader = (c) => (text, dialect, dir) => {
    let m = walked.get(text);
    if (!m) walked.set(text, (m = {need: needs(text), by: new Map()}));
    const k = c.legacy ? -2 : c.split ? standIn(c.k, m.need) : -1;
    const key = `${k} ${dialect} ${dir}`;
    if (!m.by.has(key)) m.by.set(key, walk(text, dialect, dir, [], 0, c.legacy, k >= 0 ? SPLITS[k] : null));
    return m.by.get(key);
  };
  for (const c of [ctx, ctxLegacy, ...ctxSplit]) c.read = reader(c);
  const pass =(judgeWith) => [ctx, ctxLegacy, ...ctxSplit].every((c) => {
    if (c.split && !seen.any) return true;
    const v = judgeWith(c);
    return v.line && (!needLookup || v.lookup);
  });
  const modern = typeof p.prompt_id === 'string' && p.prompt_id !== '';
  const fd = openSync(tp, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) return;
    if (codex) {
      const {records, other} = readCodexTurn(fd, Number(fstatSync(fd).size), turnId);
      if (other) return;
      if (pass((c) => judgeCodex(records, turnId, c))) return;
      return deny(needLookup ? REASON_LOOKUP : REASON_LINE);
    }
    const size = await waitForCall(fd, id);
    // Maybe on disk in a shape the gate doesn't read: it passes, as any
    // record the gate can't read does.
    if (size === UNREAD) return;
    // Not found in time. In this session's own transcript the record is late
    // (or in a record type the gate doesn't read), and the turn can't be read
    // up to the call: deny. A transcript the gate can't tie to the session
    // lets the call through, as any transcript it can't read does.
    if (size === null) {
      if (ownTranscript(fd, p.session_id)) deny(REASON_UNSEEN);
      return;
    }
    const {records, start} = readTurn(fd, size, modern);
    // A turn start for another prompt means this isn't the shape expected.
    if (modern && start && typeof start.promptId === 'string' && start.promptId !== p.prompt_id) return;
    if (pass((c) => judge(records, id, c))) return;
  } finally {
    closeSync(fd);
  }
  deny(needLookup ? REASON_LOOKUP : REASON_LINE);
}

// Claude Code and Codex both read this shape as a deny.
function deny(reason) {
  process.stdout.write(`${JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason}})}\n`);
}

// Any error lets the call through, but running out of time denies it: the
// tool's timeout would let it through unread.
main().catch((e) => {
  if (e === LATE) deny(REASON_LATE);
});
