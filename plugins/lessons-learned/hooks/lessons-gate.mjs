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
// error lets the call through, and so does anything it doesn't recognise.
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
const POLL_FOR = 300; // ms to wait for the current call to be on disk
const MAX_FILE = 1024 * 1024; // bytes of PLAYBOOK.md or dev/lessons.mjs read
const MAX_PATH = 4096; // characters of a path looked at; a longer one passes
const MAX_PARTS = 512; // names in a path looked at; a deeper one passes
const MAX_DEPTH = 4; // shells inside shells (bash -c "pwsh -c ...") read
const HEADING = '## The lessons check';
// Fixed text, so nothing from the repo reaches the agent through the hook.
const DENY_MARK = 'Lessons check (PLAYBOOK.md';
const OFF = ' To turn this check off: LESSONS_GATE=off (see the lessons-learned README).';
const REASON_LOOKUP = `${DENY_MARK}, 'The lessons check'): run \`node dev/lessons.mjs <2-4 topic words>\`, write a visible \`Lessons checked:\` line, then retry.${OFF}`;
const REASON_LINE = `${DENY_MARK}, 'The lessons check'): write a visible \`Lessons checked:\` line naming the lessons that apply, then retry.${OFF}`;
// Earlier wording of the reasons, so a call denied by an older copy is known.
const OLD_REASONS = [REASON_LOOKUP.slice(0, -OFF.length), REASON_LINE.slice(0, -OFF.length)];
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
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

// Here-doc and here-string bodies are text, not commands. Both are found line
// by line, so the work grows linearly with the command.
function dropBodies(command, dialect) {
  if (dialect === 'ps') return dropHereStrings(command);
  if (dialect !== 'sh' || !command.includes('<<')) return command;
  const out = [];
  // Here-docs opened and not yet closed, in order; `next` is the one whose
  // closing line comes first.
  const waiting = [];
  let next = 0;
  const state = {stack: []};
  for (const raw of command.split('\n')) {
    if (next < waiting.length) {
      const line = raw.replace(/\r$/, '');
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
// until its `)`.
const HERE_DOC = /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z0-9_.-]+))/y;
function hereDocs(line, state) {
  const found = [];
  const st = state.stack;
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
    else if (c === '#' && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) break;
    else if (c === '<' && line[i + 1] === '<') {
      if (line[i + 2] === '<') {
        i += 2;
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

// Whether the @ at `at` in a line of PowerShell is outside quotes and
// comments, so an @' or @" there opens a here-string. `st` holds the open
// contexts: a quote, or ( for a $( ) inside double quotes, which is code
// again until its ). A quote opened on an earlier line is not seen.
function codeAt(line, at) {
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
        st.push('(');
        i++;
      }
    } else if (c === "'" || c === '"') st.push(c);
    else if (c === '`') i++;
    else if (top === '(' && c === '(') st.push('(');
    else if (top === '(' && c === ')') st.pop();
    else if (c === '<' && line[i + 1] === '#') {
      const k = line.indexOf('#>', i + 2);
      if (k < 0 || k + 2 > at) return false;
      i = k + 1;
    } else if (c === '#' && (i === 0 || /[\s;|&(){}]/.test(line[i - 1]))) return false;
  }
  return st.length === 0;
}

// PowerShell here-strings: a line ending in @' or @" outside quotes and
// comments opens one, and a line starting with '@ or "@ closes it. The body
// becomes '' on the opening line; one never closed is left as it was.
function dropHereStrings(command) {
  if (!command.includes('@')) return command;
  const out = [];
  let open = null;
  for (const raw of command.split('\n')) {
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
    if (m && codeAt(raw, m.index)) {
      open = {q: m[1], at: out.length, lines: [raw]};
      out.push(`${raw.slice(0, m.index)}''`);
    } else out.push(raw);
  }
  if (open) {
    out.length = open.at;
    for (const line of open.lines) out.push(line);
  }
  return out.join('\n');
}

function tokenize(input, dialect) {
  const s = dropBodies(input, dialect);
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
  const add = (c, dyn = false) => {
    w ??= {text: '', dyn: false};
    w.text += c;
    if (dyn) w.dyn = true;
  };
  const n = s.length;
  // The index of the ")" that closes a "(" just before `from`.
  const close = (from) => {
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
    const j = close(i + 2);
    subs.push(s.slice(i + 2, j));
    add(s.slice(i, j + 1), true);
    return j + 1;
  };
  const isVar = (i) => s[i] === '$' && /[A-Za-z_{(?!$@*#0-9]/.test(s[i + 1] ?? '');
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === esc && dialect !== 'cmd') {
      if (s[i + 1] === '\n') i += 2;
      else if (s[i + 1] === '\r' && s[i + 2] === '\n') i += 3;
      else {
        if (i + 1 < n) add(s[i + 1]);
        i += 2;
      }
      continue;
    }
    if (c === '^' && dialect === 'cmd') {
      if (i + 1 < n && s[i + 1] !== '\n') add(s[i + 1]);
      i += 2;
      continue;
    }
    // bash's $'...': a backslash escapes the next character, a quote included.
    if (dialect === 'sh' && c === '$' && s[i + 1] === "'") {
      let j = i + 2;
      let text = '';
      while (j < n && s[j] !== "'") {
        if (s[j] === '\\' && j + 1 < n) {
          text += s[j + 1];
          j += 2;
        } else text += s[j++];
      }
      add(text);
      i = j + 1;
      continue;
    }
    if (c === "'" && dialect !== 'cmd') {
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
      continue;
    }
    if (c === '"') {
      add('');
      let j = i + 1;
      while (j < n && s[j] !== '"') {
        if (s[j] === esc && dialect !== 'cmd') {
          const next = s[j + 1];
          if (dialect === 'ps' || '$`"\\\n'.includes(next ?? '')) {
            if (next !== '\n' && next !== undefined) add(next);
            j += 2;
          } else {
            add(s[j]);
            j++;
          }
        } else if (s[j] === '$' && s[j + 1] === '(' && dialect !== 'cmd') {
          j = sub(j);
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
      continue;
    }
    if (dialect !== 'cmd' && c === '$' && s[i + 1] === '(') {
      i = sub(i);
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
    if (c === '\n' || c === ';' || c === '(' || c === ')' || (dialect === 'ps' && (c === '{' || c === '}'))) {
      brk();
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
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (/\s/.test(c)) {
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
function walk(command, dialect, cwd, out = [], depth = 0) {
  if (depth > MAX_DEPTH || typeof command !== 'string') return out;
  const {cmds, subs} = tokenize(command, dialect);
  for (const body of subs) walk(body, dialect, cwd, out, depth + 1);
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
        if (at >= 0 && args[at + 1]) walk(args[at + 1].text, 'sh', here, out, depth + 1);
      } else if (PWSH.has(name)) {
        const at = args.findIndex((a) => /^-(c|command|co|com|comm|comma|comman)$/i.test(a.text));
        if (at >= 0) walk(args.slice(at + 1).map((a) => a.text).join(' '), 'ps', here, out, depth + 1);
      } else {
        // cmd /c, or cmd //c as Git Bash spells it.
        const at = args.findIndex((a) => /^\/\/?[ck]$/i.test(a.text));
        if (at >= 0) walk(args.slice(at + 1).map((a) => a.text).join(' '), 'cmd', here, out, depth + 1);
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
// and returns where that record's line ends; null if it never comes. What
// comes after it (later calls of the same message, already on disk) is not
// read. A record longer than the window read (a large Write) widens the window.
async function waitForCall(fd, id) {
  const needle = Buffer.from(JSON.stringify(id));
  const start = Date.now();
  for (;;) {
    const size = Number(fstatSync(fd).size);
    let win = CHUNK;
    for (;;) {
      const from = Math.max(0, size - win);
      const buf = readAt(fd, Buffer.alloc(size - from), from);
      let grow = from > 0 && buf.lastIndexOf(10, buf.length - 2) < 0;
      for (let i = buf.indexOf(needle); i >= 0 && !grow; i = buf.indexOf(needle, i + 1)) {
        const a = buf.lastIndexOf(10, i) + 1;
        if (a === 0 && from > 0) {
          grow = true;
          break;
        }
        const b = buf.indexOf(10, i);
        const r = parse(buf.subarray(a, b < 0 ? buf.length : b));
        if (r && r.type === 'assistant' && blocks(r).some((x) => x.type === 'tool_use' && x.id === id)) return from + (b < 0 ? buf.length : b + 1);
      }
      if (!grow || win >= MAX_WINDOW) break;
      win = Math.min(win * 4, MAX_WINDOW);
    }
    if (Date.now() - start >= POLL_FOR) return null;
    await sleep(POLL_EVERY);
  }
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
    const call = line.includes('"tool_use"') && (line.includes('lessons.mjs') || line.includes('git'));
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
      const ours = b.is_error === true && [REASON_LOOKUP, REASON_LINE, ...OLD_REASONS].some((x) => text.includes(x));
      if (refused || ours || (b.is_error === true && text.trimStart().startsWith('<tool_use_error>'))) ids.add(b.tool_use_id);
    }
  }
  return ids;
}

// Whether the turn holds the line, and a lookup of the session repo's script,
// after its last commit or push to a gated repo (a call that never ran
// doesn't count), up to the current call: a later call of the same message is
// on disk too, and is left out. In the current call, a lookup before its first
// such commit or push counts.
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
        v.ran(walk(b.input.command, dialectOf(b.name), rcwd));
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
    const ran = line.includes('"CommandExecution"') && (line.includes('lessons.mjs') || line.includes('git'));
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
        if (c) v.ran(walk(c, 'sh', fileUrl(item.cwd) ?? ctx.cwd));
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
  let current = null;
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
    if (typeof command !== 'string' || !command.includes('git')) return;
    const dialect = !codex ? dialectOf(p.tool_name) : process.platform === 'win32' ? 'ps' : 'sh';
    current = walk(command, dialect, cwd);
    for (const e of current) {
      const root = e.kind === 'git' ? gatedRoot(e.dir) : null;
      if (root) roots.add(root);
    }
    if (!roots.size) return;
  } else return;

  if (!codex && (typeof id !== 'string' || !id)) return;
  // The lookup is asked for only in the session's own repo, where the deny
  // reason's `node dev/lessons.mjs` runs the script whose hash was checked.
  const home = cwd && gatedRoot(cwd);
  const needLookup = home !== null && home !== undefined && roots.has(home) && scriptMatches(home);
  const ctx = {
    cwd,
    current,
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
  const modern = typeof p.prompt_id === 'string' && p.prompt_id !== '';
  const fd = openSync(tp, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) return;
    if (codex) {
      const {records, other} = readCodexTurn(fd, Number(fstatSync(fd).size), turnId);
      if (other) return;
      const v = judgeCodex(records, turnId, ctx);
      if (v.line && (!needLookup || v.lookup)) return;
      return deny(needLookup);
    }
    const size = await waitForCall(fd, id);
    if (size === null) return;
    const {records, start} = readTurn(fd, size, modern);
    // A turn start for another prompt means this isn't the shape expected.
    if (modern && start && typeof start.promptId === 'string' && start.promptId !== p.prompt_id) return;
    const v = judge(records, id, ctx);
    if (v.line && (!needLookup || v.lookup)) return;
  } finally {
    closeSync(fd);
  }
  deny(needLookup);
}

// Claude Code and Codex both read this shape as a deny.
function deny(needLookup) {
  process.stdout.write(
    `${JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: needLookup ? REASON_LOOKUP : REASON_LINE}})}\n`,
  );
}

main().catch(() => {});
