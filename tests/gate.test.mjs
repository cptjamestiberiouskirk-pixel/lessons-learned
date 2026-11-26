// Tests for plugins/lessons-learned/hooks/lessons-gate.mjs, the PreToolUse
// hook. Each test builds a repo and a transcript in a temp folder and runs the
// hook as Claude Code does: the payload on stdin, a deny on stdout. The
// transcript records are synthetic, shaped like Claude Code 2.1's records.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from './child.mjs';
import {execFileSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {appendFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {can, NO_HARD_LINKS} from './links.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugins/lessons-learned');
const GATE = process.env.LESSONS_GATE_SCRIPT || join(PLUGIN, 'hooks/lessons-gate.mjs');
const TEMPLATE = readFileSync(join(PLUGIN, 'templates/lessons.mjs'), 'utf8');
const PLAYBOOK = readFileSync(join(PLUGIN, 'templates/PLAYBOOK.md'), 'utf8');
const OFF = ' To turn this check off: LESSONS_GATE=off (see the lessons-learned README).';
const REASON_LOOKUP = "Lessons check (PLAYBOOK.md, 'The lessons check'): run `node dev/lessons.mjs <2-4 topic words>` from the repo's top folder and let it finish. Then, just before the call, write a short `Lessons checked:` line alone as your reply's text (a line in thinking or a quoted mention doesn't count), and retry. A new turn (any new message to you but a background task's notice) uses both up, and so does any command with a `git commit` or `git push` in it, even one that fails or never reaches it. If this deny comes back, do both again as above. If it still comes back, check that the lookup finished before the call started and ran from the repo's top folder, with any `cd` there giving the path as its first argument (not a variable or `$(...)`), and that your reply's text starts with exactly `Lessons checked:`." + OFF;
const REASON_LINE = "Lessons check (PLAYBOOK.md, 'The lessons check'): just before the call, write a short `Lessons checked:` line naming the lessons that apply, alone as your reply's text (a line in thinking or a quoted mention doesn't count), and retry. A new turn (any new message to you but a background task's notice) uses the line up, and so does any command with a `git commit` or `git push` in it, even one that fails or never reaches it. If this deny comes back, write the line again as above, starting it with exactly `Lessons checked:`." + OFF;
// The reasons of 0.4.0. The gate knows each by its text before OFF, so a
// result holding only that text counts too. A call 0.4.0 denied never ran.
const OLD_LOOKUP = "Lessons check (PLAYBOOK.md, 'The lessons check'): run `node dev/lessons.mjs <2-4 topic words>`, write a visible `Lessons checked:` line, then retry.";
const OLD_LINE = "Lessons check (PLAYBOOK.md, 'The lessons check'): write a visible `Lessons checked:` line naming the lessons that apply, then retry.";
const OLD_REASONS = [['0.4.0, the lookup', OLD_LOOKUP + OFF], ['0.4.0, the line', OLD_LINE + OFF], ['0.4.0, the lookup before OFF', OLD_LOOKUP], ['0.4.0, the line before OFF', OLD_LINE]];
const REASON_LATE = "Lessons check (PLAYBOOK.md, 'The lessons check'): this turn holds more commands than the gate can read in time, so it denies the call rather than let it through unread. Retry it in the next turn." + OFF;
const REASON_UNSEEN = "Lessons check (PLAYBOOK.md, 'The lessons check'): the gate didn't find this call in the session's transcript in time, so it denies the call rather than let it through unread. Retry it as the only call in your next reply. If this deny keeps coming back, tell the user that the gate can't find calls in this session's transcript." + OFF;
const LINE = 'Lessons checked: none apply';
const LOOKUP = 'node dev/lessons.mjs hook test';
const WIN = process.platform === 'win32';
// A path as Git Bash would take it in a command: forward slashes.
const fwd = (p) => p.replace(/\\/g, '/');

const folders = [];
after(() => folders.forEach((f) => rmSync(f, {recursive: true, force: true})));
function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'lessons-gate-'));
  folders.push(d);
  return realpathSync.native(d);
}

// A repo: a .git folder (or a worktree's .git file), PLAYBOOK.md with or
// without the check, and dev/lessons.mjs as this plugin's script, another
// version, or none.
function makeRepo({check = true, script = 'match', worktree = false, at, playbook} = {}) {
  const root = at ?? join(scratch(), 'repo');
  mkdirSync(root, {recursive: true});
  if (worktree) writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/repo\n');
  else mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'PLAYBOOK.md'), playbook ?? (check ? PLAYBOOK : PLAYBOOK.replace('## The lessons check', '## Some other section')));
  if (script) {
    mkdirSync(join(root, 'dev'));
    const text = typeof script === 'object' ? script.text : script === 'match' ? TEMPLATE : script === 'crlf' ? TEMPLATE.replace(/\n/g, '\r\n') : `${TEMPLATE}// changed\n`;
    writeFileSync(join(root, 'dev/lessons.mjs'), text);
  }
  return root;
}

// A transcript in Claude Code's shape. Each assistant record holds one block,
// as Claude Code writes them; the records of one message share message.id.
// Each record carries the folder the session was in, as Claude Code's do.
class Transcript {
  constructor(cwd = 'C:\\work') {
    this.cwd = cwd;
    this.lines = [];
    this.n = 0;
    this.prompts = 0;
    this.promptId = null;
    this.msg = 0;
  }
  base(type, extra) {
    this.n++;
    return {parentUuid: this.n > 1 ? `uuid-${this.n - 1}` : null, isSidechain: false, userType: 'external', cwd: this.cwd, sessionId: 'sess-1', version: '2.1.330', gitBranch: 'main', type, uuid: `uuid-${this.n}`, timestamp: new Date(Date.UTC(2026, 10, 21, 12, 0, this.n)).toISOString(), ...extra};
  }
  push(r) {
    this.lines.push(JSON.stringify(r));
    return this;
  }
  // A turn start: a human prompt, or a wake-up, task notification or peer message.
  prompt(text = 'Do the task.', {origin = 'human', meta = false, promptId} = {}) {
    this.prompts++;
    this.promptId = promptId ?? `prompt-${this.prompts}`;
    const kind = {human: 'human', scheduled: undefined, task_notification: 'task-notification', peer: 'peer'}[origin];
    return this.push(this.base('user', {promptId: this.promptId, message: {role: 'user', content: text}, turnPosition: {promptIndex: this.prompts, turnIndex: this.prompts}, turnOrigin: origin, ...(kind ? {origin: {kind}} : {}), ...(meta ? {isMeta: true} : {})}));
  }
  // A prompt from an older Claude Code: no turnPosition, no promptId.
  oldPrompt(text = 'Do the task.') {
    return this.push(this.base('user', {message: {role: 'user', content: text}}));
  }
  assistant(block, {sidechain = false} = {}) {
    return this.push(this.base('assistant', {isSidechain: sidechain, requestId: `req-${this.msg}`, message: {id: `msg-${this.msg}`, type: 'message', role: 'assistant', model: 'claude-test', content: [block], stop_reason: null}}));
  }
  newMessage() {
    this.msg++;
    return this;
  }
  text(text, opts) {
    return this.assistant({type: 'text', text}, opts);
  }
  thinking(text) {
    return this.assistant({type: 'thinking', thinking: text, signature: 'sig'});
  }
  use(id, name, input) {
    return this.assistant({type: 'tool_use', id, name, input, caller: {type: 'direct'}});
  }
  result(id, content = 'ok', isError = false, extra = {}) {
    return this.push(this.base('user', {promptId: this.promptId, message: {role: 'user', content: [{tool_use_id: id, type: 'tool_result', content, is_error: isError}]}, toolUseResult: {stdout: '', stderr: '', interrupted: false}, sourceToolAssistantUUID: `uuid-${this.n}`, ...extra}));
  }
  // A tool call and its result, as a whole message.
  call(id, name, input, content = 'ok') {
    return this.newMessage().use(id, name, input).result(id, content);
  }
  lookup(id = `toolu_look${this.n}`) {
    return this.call(id, 'Bash', {command: LOOKUP, description: 'Look up lessons'}, '-- 0 shown; 0 lessons');
  }
  compact() {
    return this.push(this.base('user', {promptId: this.promptId, isCompactSummary: true, isVisibleInTranscriptOnly: true, turnPosition: {promptIndex: this.prompts, turnIndex: this.prompts}, turnOrigin: 'human', message: {role: 'user', content: 'This session is being continued from a previous conversation.'}}));
  }
  meta(text = 'Base directory for this skill: x') {
    return this.push(this.base('user', {isMeta: true, message: {role: 'user', content: [{type: 'text', text}]}}));
  }
  interrupt() {
    return this.push(this.base('user', {message: {role: 'user', content: [{type: 'text', text: '[Request interrupted by user]'}]}}));
  }
  attachment(bytes = 200) {
    return this.push({type: 'attachment', attachment: {type: 'noise', content: 'x'.repeat(bytes)}, uuid: `att-${this.n++}`, timestamp: '2026-11-21T12:00:00Z', sessionId: 'sess-1'});
  }
  // `respace` writes each record with a space after its colons and commas,
  // as another JSON writer might.
  write(path = join(scratch(), 'transcript.jsonl'), {respace = false} = {}) {
    const lines = respace ? this.lines.map((l) => JSON.stringify(JSON.parse(l), null, 1).replace(/\n */g, ' ')) : this.lines;
    writeFileSync(path, `${lines.join('\n')}\n`);
    return path;
  }
}

function gate(payload, env = {}, args = []) {
  const e = {...process.env, ...env};
  if (!('LESSONS_GATE' in env)) delete e.LESSONS_GATE;
  const started = performance.now();
  const r = spawnSync(process.execPath, [...args, GATE], {input: JSON.stringify(payload), encoding: 'utf8', env: e});
  const ms = performance.now() - started;
  const out = r.stdout.trim();
  let reason = null;
  if (out) reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
  return {status: r.status, out, reason, deny: reason !== null, ms, stderr: r.stderr};
}

let ids = 0;
// The current call: a tool_use at the end of the transcript, in a new
// message, after `before` text blocks of that same message.
function current(t, name, input, {before = [], id = `toolu_cur${++ids}`} = {}) {
  t.newMessage();
  for (const b of before) t.text(b);
  t.use(id, name, input);
  return id;
}
function payload(t, path, name, input, id, extra = {}) {
  return {session_id: 'sess-1', transcript_path: path, cwd: extra.cwd ?? dirname(path), prompt_id: t.promptId, permission_mode: 'acceptEdits', effort: 'high', hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id, ...extra};
}
// An edit of `file` after the records `build` adds to a fresh turn.
function edit(root, build, {file = join(root, 'src.txt'), before = [], tool = 'Write', extra = {}, env, content = 'x', respace = false} = {}) {
  const t = new Transcript(extra.cwd ?? root).prompt();
  build(t);
  const input = tool === 'NotebookEdit' ? {notebook_path: file, new_source: content} : {file_path: file, content};
  const id = current(t, tool, input, {before});
  const path = t.write(undefined, {respace});
  return gate(payload(t, path, tool, input, id, {cwd: root, ...extra}), env);
}
function command(cwd, cmd, build, {tool = 'Bash', before = [], extra = {}, env} = {}) {
  const t = new Transcript(cwd).prompt();
  build(t);
  const input = {command: cmd, description: 'Run it'};
  const id = current(t, tool, input, {before});
  const path = t.write();
  return gate(payload(t, path, tool, input, id, {cwd, ...extra}), env);
}
const ready = (t) => t.newMessage().text(LINE).lookup();

test('an edit passes with the line and a lookup, and is denied without either', () => {
  const root = makeRepo();
  assert.equal(edit(root, ready).deny, false);
  const none = edit(root, () => {});
  assert.equal(none.deny, true);
  assert.equal(none.reason, REASON_LOOKUP);
  assert.equal(none.status, 0);
  assert.equal(edit(root, (t) => t.newMessage().text(LINE)).reason, REASON_LOOKUP, 'a line with no lookup');
  assert.equal(edit(root, (t) => t.lookup()).reason, REASON_LOOKUP, 'a lookup with no line');
});

test('a line written in the same message as the edit passes', () => {
  const root = makeRepo();
  assert.equal(edit(root, (t) => t.lookup(), {before: [LINE]}).deny, false);
});

test('a lookup with only --check, --stale, --all or --section is not a lookup', () => {
  const root = makeRepo();
  for (const cmd of ['node dev/lessons.mjs --check', 'node dev/lessons.mjs --stale', 'node dev/lessons.mjs --all', 'node dev/lessons.mjs --dir x --check 2>&1', 'node dev/lessons.mjs --section "The lessons check"', 'node dev/lessons.mjs --section Committing', 'node dev/lessons.mjs --dir . --section Committing']) {
    const r = edit(root, (t) => t.newMessage().text(LINE).call('toolu_l', 'Bash', {command: cmd}));
    assert.equal(r.deny, true, cmd);
  }
  for (const cmd of [`cd "${root}" && node dev/lessons.mjs commit test`, `node "${join(root, 'dev', 'lessons.mjs')}" hook`, 'node ./dev/lessons.mjs --dir . skill']) {
    const r = edit(root, (t) => t.newMessage().text(LINE).call('toolu_l', 'PowerShell', {command: cmd}));
    assert.equal(r.deny, false, cmd);
  }
});

test('a scheduled wake-up, a peer message and a new prompt after an interrupt each start a new turn', () => {
  const root = makeRepo();
  const cases = {
    scheduled: (t) => t.prompt('<scheduled-wakeup>', {origin: 'scheduled', meta: true}),
    peer: (t) => t.prompt('<peer-message>', {origin: 'peer', meta: true}),
    interrupt: (t) => t.interrupt().prompt('Go on.'),
  };
  for (const [name, start] of Object.entries(cases)) {
    assert.equal(edit(root, (t) => start(ready(t))).deny, true, name);
    assert.equal(edit(root, (t) => ready(start(ready(t)))).deny, false, `${name}, then a fresh line`);
  }
});

test('a task notification carries on the turn before it, and a commit there still uses up the line', () => {
  const root = makeRepo();
  const task = (t) => t.prompt('<task-notification>\n<task-id>b1</task-id>\n</task-notification>', {origin: 'task_notification'});
  assert.equal(edit(root, (t) => task(ready(t))).deny, false, 'the line before the notification counts');
  assert.equal(edit(root, (t) => task(task(ready(t)))).deny, false, 'two notifications in a row');
  assert.equal(edit(root, (t) => task(ready(t).call('toolu_c', 'Bash', {command: 'git commit -m x'}))).deny, true, 'a commit after the line, before the notification');
  assert.equal(edit(root, (t) => task(ready(t).prompt('Next.'))).deny, true, 'a human prompt before the notification still starts a turn');
  // A record that names its origin in only one of the two fields.
  for (const drop of ['turnOrigin', 'origin']) {
    const one = (t) => {
      task(ready(t));
      const r = JSON.parse(t.lines.pop());
      delete r[drop];
      return t.push(r);
    };
    assert.equal(edit(root, one).deny, false, `a notification without ${drop}`);
  }
  // An older Claude Code: no turnPosition, the notification only in the text.
  const t = new Transcript(root).oldPrompt();
  ready(t).oldPrompt('<task-notification>\n<task-id>b2</task-id>');
  const input = {file_path: join(root, 'x.txt'), content: 'x'};
  const id = current(t, 'Write', input);
  const p = payload(t, t.write(), 'Write', input, id, {cwd: root});
  delete p.prompt_id;
  assert.equal(gate(p).deny, false, 'an older notification record');
});

test('a prompt that starts with the notification tag but came from a person, a schedule or the SDK starts a turn', () => {
  const root = makeRepo();
  // Review round 3's p5.mjs, W7 to W10.
  const NOTE = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>';
  assert.equal(edit(root, (t) => ready(t).prompt(`${NOTE}\nAlso, commit it.`, {origin: 'human'})).deny, true, 'typed');
  const pasted = (t) => {
    ready(t).prompt('x', {origin: 'human'});
    const r = JSON.parse(t.lines.pop());
    r.message.content = [{type: 'text', text: NOTE}, {type: 'text', text: 'commit now'}];
    return t.push(r);
  };
  assert.equal(edit(root, pasted).deny, true, 'pasted');
  assert.equal(edit(root, (t) => ready(t).prompt(`${NOTE}\ncommit`, {origin: 'scheduled'})).deny, true, 'scheduled');
  assert.equal(edit(root, (t) => ready(t).prompt(`  ${NOTE}`, {origin: 'sdk'})).deny, true, 'sdk');
  // An older record with neither field is told by its text, which must start with the tag.
  const t = new Transcript(root).oldPrompt();
  ready(t).oldPrompt(`Please read this: ${NOTE}`);
  const input = {file_path: join(root, 'x.txt'), content: 'x'};
  const id = current(t, 'Write', input);
  const p = payload(t, t.write(), 'Write', input, id, {cwd: root});
  delete p.prompt_id;
  assert.equal(gate(p).deny, true, 'an older prompt with the tag later in its text');
});

test('a compaction summary, a skill meta record and a sidechain record do not start a turn', () => {
  const root = makeRepo();
  assert.equal(edit(root, (t) => ready(t).compact()).deny, false, 'compaction');
  assert.equal(edit(root, (t) => ready(t).meta()).deny, false, 'meta');
  assert.equal(edit(root, (t) => ready(t).push(t.base('user', {isSidechain: true, promptId: 'side', turnPosition: {promptIndex: 9, turnIndex: 9}, message: {role: 'user', content: 'a subagent task'}}))).deny, false, 'sidechain user');
});

test('a sidechain line does not count', () => {
  const root = makeRepo();
  assert.equal(edit(root, (t) => t.lookup().newMessage().text(LINE, {sidechain: true})).deny, true);
});

test('a mid-paragraph or labelled line passes, and a quoted or backticked mention does not', () => {
  const root = makeRepo();
  const pass = ['I read the log. Lessons checked: none apply', '**Lessons checked:** none apply', '> Lessons checked: none', 'Done!\n\n- Lessons checked: "A title"', 'First line\n  Lessons checked: none', `First line${String.fromCharCode(0x2028)}Lessons checked: none`];
  const fail = ['There is no "Lessons checked:" line yet', 'I will write `Lessons checked:` next', 'the Lessons checked: line', "'Lessons checked: none'", 'lessons checked: none', 'Lessons checked none', 'Lessons checked (x) none', `Lessons checked (${'a'.repeat(300)}): none`, 'Lessons checked (a\nb): none', 'Lessons checked (a (b): none', 'see notes.Lessons checked: none', `Lessons checked (${'a'.repeat(201)}): none`];
  for (const text of pass) assert.equal(edit(root, (t) => t.lookup().newMessage().text(text)).deny, false, text);
  for (const text of fail) assert.equal(edit(root, (t) => t.lookup().newMessage().text(text)).deny, true, text);
});

test('a line with a label in parentheses or a heading mark passes', () => {
  const root = makeRepo();
  const long = `(${'a'.repeat(120)})`;
  for (const text of ['Lessons checked (push): none apply', '**Lessons checked (commit):** none apply', '### Lessons checked: none apply', 'Done. Lessons checked (step 4): none', '**Lessons checked**: none apply', `Lessons checked ${long}: none`, 'Lessons checked (see (a) and (b)): none', 'Done: Lessons checked: none', '**Lessons checked (push)**: none', '**Lessons checked** (push): none', `Lessons checked (${'a'.repeat(200)}): none`, '***Lessons checked***: none', '***Lessons checked*** (push): none'])
    assert.equal(edit(root, (t) => t.lookup().newMessage().text(text)).deny, false, text);
});

test('a line only in thinking or in a tool input does not count', () => {
  const root = makeRepo();
  assert.equal(edit(root, (t) => t.lookup().newMessage().thinking(LINE)).deny, true, 'thinking');
  assert.equal(edit(root, (t) => t.lookup().call('toolu_e', 'Bash', {command: `echo "${LINE}"`})).deny, true, 'tool input');
  assert.equal(edit(root, (t) => t.lookup().call('toolu_w', 'Write', {file_path: 'x', content: LINE})).deny, true, 'write content');
});

test('a commit after an earlier commit needs a fresh line, and the current call is left out', () => {
  const root = makeRepo();
  const commit = 'git add -A && git commit -q -m one';
  assert.equal(command(root, commit, ready).deny, false, 'the line and lookup before the current commit');
  assert.equal(command(root, commit, (t) => ready(t).call('toolu_c1', 'Bash', {command: commit})).deny, true, 'an earlier commit used them up');
  assert.equal(command(root, commit, (t) => ready(ready(t).call('toolu_c1', 'Bash', {command: commit}))).deny, false, 'a fresh line after it');
  assert.equal(edit(root, (t) => ready(t).call('toolu_p', 'PowerShell', {command: 'git push'})).deny, true, 'an edit after a push');
  // A commit this hook denied didn't happen, so it uses nothing up.
  const denied = (t) => ready(t).newMessage().use('toolu_d', 'Bash', {command: commit}).result('toolu_d', REASON_LOOKUP, true);
  assert.equal(command(root, commit, denied).deny, false, 'a denied commit');
});

test('a commit refused by any hook, rule or the user does not use up the line; a commit that ran does', () => {
  const root = makeRepo();
  const commit = 'git commit -m x';
  const refused = (t) => ready(t).newMessage().use('toolu_d', 'Bash', {command: commit}).result('toolu_d', 'PreToolUse:Bash hook error: another hook said no', true, {toolDenialKind: 'permission-rule'});
  assert.equal(edit(root, refused).deny, false, 'refused by another hook');
  const rejected = (t) => ready(t).newMessage().use('toolu_d', 'Bash', {command: commit}).result('toolu_d', '<tool_use_error>Blocked</tool_use_error>', true);
  assert.equal(edit(root, rejected).deny, false, 'rejected by the tool');
  const marked = (t) => ready(t).newMessage().use('toolu_c', 'Bash', {command: commit}).result('toolu_c', '[main 1a2b] Lessons check (PLAYBOOK.md tweak');
  assert.equal(edit(root, marked).deny, true, 'a commit that ran, whose output names the reason\'s start');
  const whole = (t) => ready(t).newMessage().use('toolu_c', 'Bash', {command: commit}).result('toolu_c', `[main 1a2b] Quote the reason\n${REASON_LINE}`);
  assert.equal(edit(root, whole).deny, true, 'a commit that ran, whose output holds the whole reason, not as an error');
  const blank = (t) => ready(t).newMessage().use('toolu_c', 'Bash', {command: commit}).result('toolu_c', '[main 1a2b] x', false, {toolDenialKind: ''});
  assert.equal(edit(root, blank).deny, true, 'an empty toolDenialKind is not a refusal');
  for (const [what, reason] of OLD_REASONS) {
    const old = (t) => ready(t).newMessage().use('toolu_d', 'Bash', {command: commit}).result('toolu_d', reason, true);
    assert.equal(edit(root, old).deny, false, `denied with an older copy's reason: ${what}`);
  }
  // This copy's own denies, in a record with no toolDenialKind, bare or as
  // Claude Code writes a hook's error.
  for (const [what, reason] of [['the lookup', REASON_LOOKUP], ['the line', REASON_LINE], ['out of time', REASON_LATE], ['not found in time', REASON_UNSEEN]]) {
    for (const text of [reason, `PreToolUse:Bash hook error: ${reason}`]) {
      const own = (t) => ready(t).newMessage().use('toolu_d', 'Bash', {command: commit}).result('toolu_d', text, true);
      assert.equal(edit(root, own).deny, false, `denied with this copy's reason: ${what}${text === reason ? '' : ', with the hook error prefix'}`);
    }
  }
});

test("the README quotes the gate's lookup deny as this file's REASON_LOOKUP", () => {
  // The fenced block after "The denial tells Claude what to do" in the
  // plugin's README. Other tests check the gate's deny against REASON_LOOKUP.
  const readme = readFileSync(join(PLUGIN, 'README.md'), 'utf8').split(/\r?\n/);
  const at = readme.findIndex((l) => l.includes('The denial tells Claude what to do'));
  assert.ok(at >= 0, 'the README names the denial');
  assert.deepEqual(readme.slice(at + 1, at + 3), ['', '```'], 'a fenced block follows');
  assert.equal(readme[at + 3], REASON_LOOKUP, 'the README quotes the lookup deny');
  assert.equal(readme[at + 4], '```', 'the block holds one line');
});

test('compound commands are judged by the repo each commit or push runs in', () => {
  const root = makeRepo();
  const plain = makeRepo({check: false});
  const cases = [
    `cd "${root}" && git add -A && git commit -m x`,
    `Set-Location -LiteralPath '${root}'\ngit commit -m x`,
    `Push-Location '${root}'; git commit -m x; Pop-Location`,
    `git -C "${root}" commit -m x`,
    `git -c user.name=a -C "${root}" push`,
    `GIT_TRACE=0 git --no-pager -C "${root}" commit -m x`,
    `& git -C '${root}' commit -m x`,
  ];
  for (const cmd of cases) assert.equal(command(plain, cmd, () => {}).deny, true, cmd);
  assert.equal(command(root, 'git -c k=v push', () => {}).deny, true, 'push in cwd');
  assert.equal(command(root, 'git status && git log -1', () => {}).deny, false, 'not a commit or push');
  assert.equal(command(root, 'npm test', () => {}).deny, false, 'no git');
  assert.equal(command(root, `git -C "${plain}" commit -m x`, () => {}).deny, false, 'a commit to a repo without the check');
  assert.equal(command(root, 'cd ~/no-such-folder-here && git commit -m x', () => {}).deny, false, 'a folder that does not exist');
});

test('a quoted value, an env prefix or a wrapper before git still finds the commit', () => {
  const root = makeRepo();
  const bash = [
    'GIT_AUTHOR_NAME="First Last" git commit -m x',
    'git -c user.name="A B" commit -m x',
    "git -c 'user.name=A B' -c core.x=1 commit -m x",
    'if true; then git commit -m x; fi',
    'for f in a; do git push; done',
    'sudo git commit -m x',
    'env GIT_X=1 git commit -m x',
    'command git commit -m x',
    'time git commit -m x',
    'echo m | xargs git commit -m',
    'bash -c "git commit -m x"',
    "sh -lc 'git commit -m x'",
    'pwsh -NoProfile -Command "git commit -m x"',
    'git status\ngit commit -m x',
    'git add . &&\n  git commit -m x',
  ];
  for (const cmd of bash) assert.equal(command(root, cmd, () => {}).deny, true, cmd);
  for (const cmd of ['git `\n  commit -m x', 'git commit -m "a ""quoted"" word"', "& git commit -m 'it''s'", 'cmd /c "git commit -m x"'])
    assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, cmd);
});

test('a folder given as a Git Bash path, a variable, ~, a substitution or an escaped space is followed', (t2) => {
  const root = makeRepo();
  const plain = makeRepo({check: false});
  const spaced = makeRepo({at: join(scratch(), 'Deep Belt')});
  mkdirSync(join(root, 'sub'));
  assert.equal(command(plain, `cd ${fwd(spaced).replace(' ', '\\ ')} && git commit -m x`, () => {}).deny, true, 'escaped space');
  assert.equal(command(plain, `git --git-dir="${fwd(root)}/.git" --work-tree="${fwd(root)}" commit -m x`, () => {}).deny, true, '--git-dir and --work-tree');
  assert.equal(command(plain, `git --work-tree=${fwd(root)} commit -m x`, () => {}).deny, true, '--work-tree=');
  assert.equal(command(plain, `git --git-dir="${fwd(root)}/.git" commit -m x`, () => {}).deny, true, '--git-dir alone');
  assert.equal(command(root, 'cd $SOMEWHERE && git commit -m x', () => {}).deny, true, 'a variable leaves the folder as it was');
  assert.equal(command(join(root, 'sub'), 'cd "$(git rev-parse --show-toplevel)" && git commit -m x', () => {}).deny, true, 'a substitution leaves the folder as it was');
  assert.equal(command(plain, `cd ${fwd(root)} & git commit -m x`, () => {}).deny, true, 'a single &');
  const home = {HOME: dirname(root), USERPROFILE: dirname(root)};
  assert.equal(command(plain, 'cd ~/repo && git commit -m x', () => {}, {env: home}).deny, true, '~');
  assert.equal(command(plain, 'cd && git commit -m x', () => {}, {env: {HOME: root, USERPROFILE: root}}).deny, true, 'cd alone goes home');
  assert.equal(command(root, `pushd "${fwd(plain)}" && popd && git commit -m x`, () => {}).deny, true, 'popd comes back');
  assert.equal(command(root, 'git --git-dir="$GD" commit -m x', () => {}).deny, true, 'a --git-dir that is a variable leaves the folder as it was');
  if (!WIN) return t2.diagnostic('Git Bash paths are a Windows thing: not tried here');
  const posix = `/${root[0].toLowerCase()}${fwd(root).slice(2)}`;
  assert.equal(command(plain, `cd ${posix} && git commit -m x`, () => {}).deny, true, posix);
  assert.equal(command(plain, `git -C ${posix} commit -m x`, () => {}).deny, true, `-C ${posix}`);
  assert.equal(edit(plain, () => {}, {file: `${posix}/src.txt`}).deny, true, 'an edit given a Git Bash path');
  const mnt = `/mnt${posix}`;
  assert.equal(command(plain, `cd ${mnt} && git commit -m x`, () => {}).deny, true, `a WSL path, ${mnt}`);
});

test('a here-doc or here-string body, a dry run and a quoted mention are not commits', () => {
  const root = makeRepo();
  assert.equal(command(root, "cat > notes.txt <<'EOF'\ngit push\ngit commit -m x\nEOF", () => {}).deny, false, 'here-doc');
  assert.equal(command(root, 'cat <<-END > n.txt\n\tgit push\n\tEND\necho ok', () => {}).deny, false, 'here-doc with <<-');
  assert.equal(command(root, "@'\ngit push\n'@ | Set-Content notes.txt", () => {}, {tool: 'PowerShell'}).deny, false, 'here-string');
  assert.equal(command(root, "@'\nit's done\ngit push\n'@ | Set-Content notes.txt", () => {}, {tool: 'PowerShell'}).deny, false, 'here-string with a quote in it');
  assert.equal(command(root, 'git commit --dry-run -m x', () => {}).deny, false, 'dry run');
  assert.equal(command(root, 'git push -n', () => {}).deny, false, 'push -n');
  assert.equal(command(root, 'echo "next: git commit -m x"', () => {}).deny, false, 'in quotes');
  assert.equal(command(root, "git commit -F - <<'EOF'\nmsg\nEOF", () => {}).deny, true, 'the command before a here-doc still counts');
  assert.equal(command(root, 'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"', () => {}).deny, true, 'a here-doc in the message');
});

test('a commit or push to a repo without the check does not use up the line', () => {
  const root = makeRepo();
  const plain = makeRepo({check: false});
  assert.equal(edit(root, (t) => ready(t).call('toolu_o', 'Bash', {command: `git -C "${plain}" commit -m x`})).deny, false);
  assert.equal(edit(root, (t) => ready(t).call('toolu_o', 'Bash', {command: `git -C "${root}" commit -m x`})).deny, true, 'one to this repo does');
  const other = makeRepo();
  assert.equal(edit(root, (t) => ready(t).call('toolu_o', 'Bash', {command: `git -C "${other}" commit -m x`})).deny, false, 'nor one to another repo with the check');
});

// Claude Code writes every tool call of a message before it runs the first,
// so a later call of the same message is on disk when an earlier one is judged.
test('a later call of the same message, already on disk, does not count for an earlier one', () => {
  const root = makeRepo();
  const t = new Transcript(root).prompt();
  ready(t).newMessage();
  const input = {file_path: join(root, 'x.txt'), old_string: 'a', new_string: 'b'};
  t.use('toolu_e', 'Edit', input).use('toolu_c', 'Bash', {command: 'git commit -m x'}).use('toolu_p', 'Bash', {command: 'git push'});
  const path = t.write();
  assert.equal(gate(payload(t, path, 'Edit', input, 'toolu_e', {cwd: root})).deny, false, 'the edit, with a later commit on disk');
  const commit = {command: 'git commit -m x'};
  assert.equal(gate(payload(t, path, 'Bash', commit, 'toolu_c', {cwd: root})).deny, false, 'the commit, with a later push on disk');
  assert.equal(gate(payload(t, path, 'Bash', {command: 'git push'}, 'toolu_p', {cwd: root})).deny, true, 'the push, after the commit before it');
  // One record holding both calls, as another writer might store the message:
  // the read stops at the end of the record, so judging must stop at the call.
  const one = ready(new Transcript(root).prompt()).newMessage();
  const block = (id, name, inp) => ({type: 'tool_use', id, name, input: inp, caller: {type: 'direct'}});
  one.push(one.base('assistant', {requestId: 'req-one', message: {id: 'msg-one', type: 'message', role: 'assistant', model: 'claude-test', content: [block('toolu_e1', 'Edit', input), block('toolu_c1', 'Bash', commit)], stop_reason: null}}));
  assert.equal(gate(payload(one, one.write(), 'Edit', input, 'toolu_e1', {cwd: root})).deny, false, 'the edit, with a later commit in its own record');
  // A prompt written after the call is not read: the turn is still the call's.
  const queued = new Transcript(root).prompt().newMessage().use('toolu_e2', 'Edit', input);
  const promptId = queued.promptId;
  queued.prompt('A later prompt.');
  const p = payload(queued, queued.write(), 'Edit', input, 'toolu_e2', {cwd: root, prompt_id: promptId});
  assert.equal(gate(p).deny, true, 'the edit without a line, with a later prompt on disk');
  // The line in the same record as the call, before it: the record is read.
  const same = new Transcript(root).prompt().lookup().newMessage();
  same.push(same.base('assistant', {requestId: 'req-same', message: {id: 'msg-same', type: 'message', role: 'assistant', model: 'claude-test', content: [{type: 'text', text: LINE}, block('toolu_e3', 'Edit', input)], stop_reason: null}}));
  assert.equal(gate(payload(same, same.write(), 'Edit', input, 'toolu_e3', {cwd: root})).deny, false, 'the line before the call in its own record');
});

test('a PowerShell assignment, script block or block comment before git still finds the commit', () => {
  const root = makeRepo();
  const cases = [
    '$c = git -C . commit -m x 2>&1',
    '$null = git push',
    '$out=git push',
    '$log += git commit -m x',
    'try { git push } catch { Write-Host no }',
    '1..2 | ForEach-Object { git commit -m "n $_" }',
    'Invoke-Command { git push }',
    'if ($x) { echo a } else { git commit -m x }',
    "<# don't push yet #> git commit -m x",
    '${env:X} = 1; git commit -m x',
    'git -C ${env:REPO} commit -m x',
  ];
  for (const cmd of cases) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, cmd);
  assert.equal(command(root, "<# git commit -m x #> git status", () => {}, {tool: 'PowerShell'}).deny, false, 'a commit only in a block comment');
});

test('a wrapper\'s option values, cmd //c, $\'..\', wsl and nested shells are read', () => {
  const root = makeRepo();
  const plain = makeRepo({check: false});
  const cases = [
    'nice -n 10 git commit -m x',
    'timeout -k 5 120 git push',
    'timeout -s KILL 5 git push',
    'stdbuf -o L git push',
    'sudo -u me git commit -m x',
    'cmd //c "git commit -m x"',
    "echo $'it\\'s' && git commit -m x",
    'wsl.exe bash -lc "git commit -m x"',
    'wsl -d Ubuntu -- git push',
    'echo "$(git commit -m x)"',
    'echo `git push`',
    'echo "`git push`"',
    'git commit -n -m x',
    `bash -c "pwsh -Command 'git commit -m x'"`,
  ];
  for (const cmd of cases) assert.equal(command(root, cmd, () => {}).deny, true, cmd);
  const from = [
    `cd "${fwd(root)}" && bash -c "git commit -m x"`,
    `env -C "${fwd(root)}" git commit -m x`,
    `cd "${fwd(root)}" && cd "${fwd(plain)}" && cd - && git commit -m x`,
  ];
  for (const cmd of from) assert.equal(command(plain, cmd, () => {}).deny, true, cmd);
  const home = {HOME: plain, USERPROFILE: plain};
  assert.equal(command(root, 'cd - && git commit -m x', () => {}, {env: home}).deny, true, 'cd - with no folder before it stays put');
  assert.equal(command(plain, `env -C "${fwd(root)}" true && git commit -m x`, () => {}).deny, false, 'env -C applies to its own command only');
});

test('doubled quotes in PowerShell, a quote and %VAR% in cmd, pwsh -co and four levels of nesting are read', () => {
  const root = makeRepo();
  // Each case turns on one rule: without it, a quote is left open or the
  // folder or shell is read wrong, and the commit is missed.
  const ps = [
    `cmd /c "echo it's & git commit -m x"`,
    'cmd /c "cd %X%\\..\\.. & git commit -m x"',
    'pwsh -co "git commit -m x"',
    `cmd /c "cd /d ${root} & git commit -m x"`,
  ];
  for (const cmd of ps) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, cmd);
  // A doubled quote in PowerShell is a quote mark in the word.
  const quoted = makeRepo({at: join(scratch(), "it's")});
  const plain = makeRepo({check: false});
  const into = `cd '${quoted.replace(/'/g, "''")}'; git commit -m x`;
  assert.equal(command(plain, into, () => {}, {tool: 'PowerShell'}).deny, true, into);
  assert.equal(command(root, 'git "com""mit" -m x', () => {}, {tool: 'PowerShell'}).deny, false, 'com"mit is not commit');
  const nest =(n) => 'echo $('.repeat(n) + 'git commit -m x' + ')'.repeat(n);
  assert.equal(command(root, nest(4), () => {}).deny, true, 'four levels of $( ) are read');
  assert.equal(command(root, nest(5), () => {}).deny, false, 'a fifth level is not read (the bound on work)');
});

test('<< inside quotes or $(( )) is not a here-doc; <<<, <<- and CRLF bodies are read right', () => {
  const root = makeRepo();
  const deny = [
    'echo $((1<<2))\ngit commit -m x',
    'echo "a <<b"\ngit commit -m x',
    "echo 'a <<b'\ngit commit -m x",
    'echo "a\n<<b" # <<c\ngit commit -m x',
    'cat <<< word\ngit commit -m x',
    'cat <<-END > n.txt\n\tbody\n\tEND\ngit commit -m x',
    'cat <<EOF > n.txt\r\nbody\r\nEOF\r\ngit commit -m x',
  ];
  for (const cmd of deny) assert.equal(command(root, cmd, () => {}).deny, true, JSON.stringify(cmd));
  assert.equal(command(root, '@"\ngit push\n"@ | Out-File n.txt', () => {}, {tool: 'PowerShell'}).deny, false, 'a body in @" "@');
  assert.equal(command(root, '@"\nbody\n"@ | Out-File n.txt\ngit commit -m x', () => {}, {tool: 'PowerShell'}).deny, true, 'the command after @" "@');
  assert.equal(command(root, '@"\nit is 5" long\ngit push\n"@ | Out-File n.txt', () => {}, {tool: 'PowerShell'}).deny, false, 'a body in @" "@ with a quote in it');
  assert.equal(command(root, "$m = @'\nmsg\n'@; git commit -m $m", () => {}, {tool: 'PowerShell'}).deny, true, 'a commit on the closing line');
  // Never closed: PowerShell refuses the whole command, so nothing in it runs.
  assert.equal(command(root, "@'\nnever closed\ngit commit -m x", () => {}, {tool: 'PowerShell'}).deny, false, 'a here-string never closed');
  // Review round 4 (phs-unclosed-dropped): pwsh 7 runs this commit. The @'
  // is in a string opened on the line before, which the opener check can't
  // see, so it opens a here-string never closed, and its lines are put back.
  assert.equal(command(root, 'Write-Host "start\nnote @\'\n"\ngit commit -m x', () => {}, {tool: 'PowerShell'}).deny, true, 'an @\' never closed, its lines put back');
  // Review round 4 (phs-opener-anywhere): only an @' at the line's end opens
  // one, so the push is in the body (pwsh 7 runs nothing here).
  assert.equal(command(root, "Write-Host \"x@'y\"; $b = @'\nit's\ngit push\n'@ # it's", () => {}, {tool: 'PowerShell'}).deny, false, "an @' in a string before the opener");
  // A closer is '@ or "@ (the opener's quote) at a line's start.
  assert.equal(command(root, '@\'\n"@ in the body\ngit push\n\'@ | Out-File n.txt', () => {}, {tool: 'PowerShell'}).deny, false, 'the other quote does not close it');
  assert.equal(command(root, "@'\nsee '@ here\ngit push\n'@ | Out-File n.txt", () => {}, {tool: 'PowerShell'}).deny, false, "'@ inside a line does not close it");
  // The same, with quotes in the line balanced, so no quote hides the push.
  assert.equal(command(root, "@'\nwrite '@' at the start of a line to close it\ngit push\n'@ | Out-File n.txt", () => {}, {tool: 'PowerShell'}).deny, false, "write '@' at the start of a line to close it");
  assert.equal(command(root, 'echo "$((1<<2))"\ngit commit -m x', () => {}).deny, true, '$(( )) inside double quotes');
  // An escaped < or quote in sh.
  assert.equal(command(root, 'echo \\<<EOF\ngit commit -m x', () => {}).deny, true, 'an escaped <');
  assert.equal(command(root, 'echo "a\\"<<b"\ngit commit -m x', () => {}).deny, true, 'an escaped quote in double quotes');
  assert.equal(command(root, 'x <<$y; echo "<<EOF"\ngit commit -m x', () => {}).deny, true, 'a << that opens nothing, then one in quotes');
});

test('a here-doc inside "$( )" is still read as one, and # after ; starts a comment', () => {
  const root = makeRepo();
  const plain = makeRepo({check: false});
  // Review round 3's fixcheck.mjs and p8.mjs: the commit runs in an ungated
  // repo, so only the push after the here-doc decides.
  const push = `git -C "${fwd(root)}" push`;
  const cases = [
    `git commit -m "$(cat <<'EOF'\nSubject\n\nDon't break it.\nEOF\n)" && ${push}`,
    `git commit -m "$(cat <<'EOF'\nSubject\n\nSee (1 of 2\nEOF\n)"\n${push}`,
    `gh pr create --title t --body "$(cat <<'EOF'\n## Summary\n- it's done\nEOF\n)"\n${push}`,
    `git commit -m "$(printf "%s" "use << here")"\n${push}`,
    `echo a;# note <<EOF\n${push}`,
    `x=$[1<<2]\n${push}`,
    // ( ) nested in "$( )", then quotes again inside it.
    `echo "$( (cd a); echo "<<EOF" )"\n${push}`,
    // Review round 4's surviving mutants: # after &, |, ( or ), or at a
    // line's start, starts a comment, so the << after it opens nothing.
    `echo a&# <<EOF\n${push}`,
    `echo a |# <<EOF\n${push}`,
    `(# <<EOF\n${push}\n)`,
    `(echo a)# <<EOF\n${push}`,
    `# <<EOF\n${push}`,
  ];
  for (const cmd of cases) assert.equal(command(plain, cmd, () => {}).deny, true, JSON.stringify(cmd));
  assert.equal(command(root, `echo "$(cat <<'EOF'\ngit push\nEOF\n)"`, () => {}).deny, false, 'the body is still not a command');
  assert.equal(command(root, 'echo "$(echo a)" <<EOF\ngit push\nEOF', () => {}).deny, false, 'a here-doc after a closed "$( )"');
});

test('long wrapper options, PowerShell target lists, comments before @\' and subshell folders are read', () => {
  const root = makeRepo();
  const plain = makeRepo({check: false});
  // Review round 3's p6.mjs, and a case for each wrapper the round names.
  const sh = [
    'timeout --kill-after 5 10 git push',
    'timeout --signal KILL 5 git push',
    'nice --adjustment 5 git push',
    'wsl --shell-type login git push',
    'sudo --user root git push',
    'doas -u root git push',
    'exec -a name git push',
    'xargs -0 git push',
    'xargs -I {} git push',
  ];
  for (const cmd of sh) assert.equal(command(root, cmd, () => {}).deny, true, cmd);
  const into = [
    `env --chdir "${fwd(root)}" git commit -m x`,
    `env --chdir="${fwd(root)}" git commit -m x`,
    `wsl --cd "${fwd(root)}" git push`,
    `env -C "${fwd(root)}" bash -c "git commit -m x"`,
    `env -C "${fwd(root)}" pwsh -c "git commit -m x"`,
    `env -C "${fwd(root)}" cmd /c "git commit -m x"`,
    `cd "${fwd(root)}"; (cd "${fwd(plain)}"); git commit -m x`,
    `(cd "${fwd(root)}" && git commit -m x)`,
  ];
  for (const cmd of into) assert.equal(command(plain, cmd, () => {}).deny, true, cmd);
  assert.equal(command(root, `(cd "${fwd(plain)}"; git commit -m x)`, () => {}).deny, false, 'a cd inside the subshell holds for the rest of it');
  // The subshell's cd leaves the folder cd - goes back to as it was too.
  assert.equal(command(root, `cd "${fwd(plain)}"; (cd "${fwd(root)}"); cd -; git commit -m x`, () => {}).deny, true, 'cd - after a subshell');
  // In sh, { inside a word is no separator.
  assert.equal(command(root, 'echo {git push}', () => {}).deny, false, 'echo {git push}');
  // The last two @' have a closer after them, so only where the @' stands decides.
  const ps = ['$a, $b = git push', '$a,$b = git push', '$x+=git commit -m x', '$a= git push', "# e.g. @'\ngit commit -m x\n'@", "Write-Host 'mail me @'\ngit commit -m x", "Write-Host 'mail me @'\ngit commit -m x\n'@ done'", "Write-Host x <# about @'\n#>\ngit commit -m x\n'@ y'"];
  for (const cmd of ps) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, cmd);
  // In PowerShell ( ) is no subshell: Set-Location inside it holds after it.
  assert.equal(command(plain, `(Set-Location "${root}"); git commit -m x`, () => {}, {tool: 'PowerShell'}).deny, true, 'Set-Location in ( )');
  // A lookup through env -C runs the script in that folder.
  const look = (t) => t.call('toolu_l', 'Bash', {command: `cd "${fwd(plain)}" && env -C "${fwd(root)}" ${LOOKUP}`}).newMessage().text(LINE);
  assert.equal(edit(root, look).deny, false, 'a lookup through env -C');
  // popd sets the folder cd - goes back to.
  assert.equal(command(plain, `pushd "${fwd(root)}" && popd && cd - && git commit -m x`, () => {}).deny, true, 'cd - after popd');
  // Review round 4's surviving mutants: each long option takes the next word.
  for (const cmd of ['stdbuf --output L git push', 'echo | xargs --max-args 1 git push', 'wsl --user root git push', 'wsl --distribution Ubuntu git push']) assert.equal(command(root, cmd, () => {}).deny, true, cmd);
});

// Review round 4: a case pattern's ) closed the subshell's folder scope, so a
// commit after it was judged in the folder outside the subshell. The inputs
// come from the review's p9.mjs, p10.mjs and probe4.mjs; each was run in Git
// Bash with a stub git that prints its folder.
test('a case pattern\'s ) closes no subshell', () => {
  const root = makeRepo();
  const plain = makeRepo({check: false});
  const into = [
    `(cd "${fwd(root)}"; case x in *) git commit -m x;; esac)`,
    `(cd "${fwd(root)}"; case "$1" in x) echo;; esac; git commit -m y)`,
    // After ;; a pattern comes next, and after ;& too.
    `(cd "${fwd(root)}"; case x in a) echo;; *) git commit -m x;; esac)`,
    `(cd "${fwd(root)}"; case x in a) echo;& *) git commit -m x;; esac)`,
    // A keyword before case, and a case that is only a word.
    `(cd "${fwd(root)}"; if true; then case x in *) echo;; esac; fi; git commit -m x)`,
    `echo case; for f in a; do (cd "${fwd(root)}"; git commit -m x); done`,
    // After a (, esac is a pattern, not the case's end.
    `(cd "${fwd(root)}"; case x in (esac) echo;; *) git commit -m x;; esac)`,
  ];
  for (const cmd of into) assert.equal(command(plain, cmd, () => {}).deny, true, cmd);
  assert.equal(command(root, `(cd "${fwd(plain)}"; case x in *) git commit -m x;; esac)`, () => {}).deny, false, 'the cd holds to the subshell\'s end');
  assert.equal(command(plain, `(cd "${fwd(root)}"; case x in (a) echo;; esac); git commit -m x`, () => {}).deny, false, 'a ( before a pattern opens no subshell');
  assert.equal(command(root, 'case $x in a) echo;; esac; git commit -m x', () => {}).deny, true, 'a case at the top level');
  // The $( ) ends at the pattern's ), so a ) with no subshell open follows.
  assert.equal(command(root, 'x=$(case a in a) echo;; esac); git commit -m x', () => {}).deny, true, 'a ) that closes nothing');
});

// A seeded byte source for the property tests (mulberry32, as in
// tests/property.test.mjs). Each run takes a new seed and prints it, and a
// failure's message names it: with GATE_SEED=<seed> set, `node --test` makes
// the same inputs. A GATE_SEED that is not a seed fails the test, so a typo
// can't run a different seed than the one asked for.
function seeded(t) {
  const given = process.env.GATE_SEED;
  if (given && !(/^\d{1,10}$/.test(given) && Number(given) <= 0xffffffff)) throw new Error(`GATE_SEED is ${JSON.stringify(given)}: a seed is a whole number from 0 to 4294967295`);
  const seed = given ? Number(given) : randomBytes(4).readUInt32LE(0);
  t.diagnostic(`GATE_SEED=${seed}`);
  let a = seed;
  const byte = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 24;
  };
  return {seed, byte};
}

// Random case statements inside a subshell that cds: the commit after esac
// runs in the subshell's folder. Built from pieces Git Bash runs.
test('property: a commit after a case statement in a subshell is judged in the subshell\'s folder', (t) => {
  const root = makeRepo();
  const plain = makeRepo({check: false});
  const {seed, byte} = seeded(t);
  const pick = (xs) => xs[byte() % xs.length];
  const build = (to, away) => {
    const n = 1 + (byte() % 3);
    let items = '';
    for (let k = 0; k < n; k++) {
      const list = Array.from({length: byte() % 3}, () => pick(['echo', 'echo "a)"', `(cd "${fwd(away)}")`, 'case y in q) echo;; esac', 'if true; then echo; fi', 'x=$(echo a)'])).join('; ');
      items += `${pick(['a', '*', 'a|b', '(a', '"x)"', '[ab]'])}) ${list}${k < n - 1 ? pick([';;', ';&', ';;&']) : pick([';;', '\n'])} `;
    }
    return `(cd "${fwd(to)}"; case x in ${items}esac; git commit -m x)`;
  };
  for (let i = 0; i < 8; i++) {
    const cmd = build(root, plain);
    assert.equal(command(plain, cmd, () => {}).deny, true, `${JSON.stringify(cmd)}, GATE_SEED=${seed}`);
    const back = build(plain, root);
    assert.equal(command(root, back, () => {}).deny, false, `${JSON.stringify(back)}, GATE_SEED=${seed}`);
  }
});

// Review round 4: inside PowerShell double quotes, $( ) is code, so its quotes
// don't end the string; the check for an @' opener read them as if they did.
// The first input is the review's p9.mjs and p10.mjs case; each was run in
// pwsh 7 with a stub git.
test('a $( ) inside PowerShell double quotes is code, so an @\' after it opens a here-string', () => {
  const root = makeRepo();
  const cases = [
    "$m = \"$($x -replace \"'\", '')\" + @'\nit's\n'@\ngit push",
    // ( ) nested in the $( ), with a quote after the inner ).
    "$m = \"$(($x) + \"'\")\" + @'\nit's\n'@\ngit push",
    // The $( ) closes at its ), and the string goes on.
    "$m = \"$($x)\" + @'\nit's\n'@\ngit push",
  ];
  for (const cmd of cases) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, JSON.stringify(cmd));
});

// Inside double quotes a $( ) can hold another double-quoted string, and that
// one another $( ). The scan for the ) that ends a $( ) skipped a $( inside a
// quoted string, so the inner string's quotes ended the outer one, a ' after
// them opened a quote, and the next line, git push included, was read as
// text. The first input is the one CI printed for the property test below
// (PR 20, macOS); each input was run in pwsh 7, or in Git Bash and WSL bash,
// with a stub git.
test('a double-quoted string inside $( ) inside double quotes nests, so the next line is read', () => {
  const root = makeRepo();
  const ps = [
    "$m = \"$(' b')$('b' + \"$(\"b'b\")'b\")\"\"\" + @'\nit's\n'@\ngit push",
    "$m = \"$('b' + \"$(\"b'b\")'b\")\" + @'\nit's\n'@\ngit push",
    "$m = \"$('b' + \"$(\"b'b\")'b\")\"\ngit push",
    // One level, which was read right, and a $( ) outside quotes.
    "$m = \"$(\"b'b\")'b\"\ngit push",
    "$m = $(\"$(\"b'b\")'b\")\ngit push",
    // A $ before anything but ( starts no $( ).
    "$m = \"$(\"$a\" + \"b'b\")\"\ngit push",
  ];
  for (const cmd of ps) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, JSON.stringify(cmd));
  const sh = [
    'x="$(echo "$(echo "b\'b")\'b")"\ngit push',
    'x="$(echo "$(echo "$(echo "c\'c")\'c")\'c")"\ngit push',
    'x="$(echo "b\'b")\'b"\ngit push',
    'x=$(echo "$(echo "b\'b")\'b")\ngit push',
    // Only a $( inside double quotes nests: in single quotes it is text, and
    // a $ before anything but ( starts no $( ).
    'x="$(echo \'$(\')"\ngit push',
    'x="$(echo "$a" "b\'b")"\ngit push',
  ];
  for (const cmd of sh) assert.equal(command(root, cmd, () => {}).deny, true, JSON.stringify(cmd));
  // A git push in the inner string is still text.
  assert.equal(command(root, 'x="$(echo "$(echo "it\'s git push")\'b")"', () => {}).deny, false, 'sh: git push as text');
  assert.equal(command(root, "$m = \"$('b' + \"$(\"it's git push\")'b\")\"", () => {}, {tool: 'PowerShell'}).deny, false, 'ps: git push as text');
});

// Q79's review round 1: once a $( ) inside double quotes nested, the scan had
// to read more of each shell's rules. In sh a # that starts a word is a
// comment to the end of its line, but not in $(( )), and $'...' has its own
// \ escapes. In PowerShell a # that starts a word, and <# #>, are comments
// in a $( ) outside quotes, and a $( ) inside double quotes ends at the )
// that balances its parentheses, counting no quotes, with each "" or `" in
// it one " (ScanSubExpression in pwsh 7.7's tokenizer.cs). The first three
// sh inputs and the first two PowerShell ones were denied before Q79's first
// fix and not after it. Each push input ran its git push in WSL bash or
// pwsh 7 with a stub git, or pwsh's own parser listed it as a command.
test('a $( ) is read by its shell\'s rules: comments and $\'...\' in sh, only parentheses inside PowerShell quotes', () => {
  const root = makeRepo();
  const sh = [
    'x="$(echo a # "$( "\n)"\ngit push',
    'x=$(echo "$(echo b #"$("\n)")\ngit push',
    "x=$(echo \"$(echo $'(\\'')\")\ngit push",
    "x=\"$(echo a # it's\n)\"\ngit push",
    "x=\"$(echo $'it\\'s')\"\ngit push",
    // A # inside a word is no comment, $' inside double quotes is text, and
    // a # right after $( is a comment.
    'x="$(echo a#"$(echo "b\'b")\'b")"\ngit push',
    'x="$(echo "$\'(\\\'")"\ngit push',
    "x=\"$(# it's\necho a)\"\ngit push",
    // A \ before a newline joins the lines, so a#b is one word and its # no
    // comment; the comment in the next $( ) holds a ) and a quote.
    'x="$(echo a\\\n#b)"; y=$( # )"\n)\ngit push\n# "',
  ];
  for (const cmd of sh) assert.equal(command(root, cmd, () => {}).deny, true, JSON.stringify(cmd));
  assert.equal(command(root, 'x="$(echo a # git push\n)"', () => {}).deny, false, 'sh: git push in a comment');
  // In $(( )) a # is no comment, so the string after it holds the git push:
  // bash ran no git in these.
  const arith = [
    'x="$(( 1 # 2 ))"; echo "\ngit push\n"',
    'x="$(echo $(( 1 # 2 )))"; echo "\ngit push\n"',
    'x="$(echo "$(( 1 # 2 ))")"; echo "\ngit push\n"',
  ];
  for (const cmd of arith) assert.equal(command(root, cmd, () => {}).deny, false, JSON.stringify(cmd));
  const ps = [
    "$m = \"$(\"$(\"\"it's\"\")\")\"\ngit push",
    "$m = \"$(\"$(`\"it's`\")\")\"\ngit push",
    "$m = \"$(\"\"it's\"\")\"\ngit push",
    "$m = \"$(\"\"it's\"\"; git push)\"",
    "$m = \"$(\"$(\"\"it's\"\")\")\" + @'\nit's\n'@\ngit push",
    // A $( ) outside quotes keeps its quotes, and a $( ) inside double quotes
    // in it ends at its balancing ).
    "$m = $(\")\")\ngit push",
    "$m = $(\"$(\"\"it's\"\")\")\necho ')\")'\ngit push\n# '",
    // The same with a " that main's reading takes for the string's end.
    "$m = $(\"$('\"' + \"\"it's\"\")\")\necho ')\")'\ngit push\n# '",
    // A `" in the code of a $( ) inside double quotes is one " too.
    "$m = \"$(`\"it's`\"; git push)\"",
    // Comments in a $( ) outside quotes, which main let through too: the )
    // or the quote in them is text.
    "$m = $( # )\"\n)\ngit push\n# \"",
    "$m = $(echo (1)# )\"\n)\ngit push\n# \"",
    "$m = $( <# )\" #> 'a')\ngit push\n# \"",
    "$m = $( <# \n) \" #> 1 )\ngit push\n# \"",
    // A ` before a newline joins the lines, so the # after it starts a word.
    "$m = $(echo a `\n# )\"\n)\ngit push\n# \"",
    // A here-string inside a $( ) inside double quotes, or a comment there
    // that ends in @', which main let through too: pwsh ends the $( ) by its
    // parentheses first.
    "$m = \"$(@'\n'\n'@)\"\ngit push\n# '",
    "$m = \"$( #@'\n)\"\ngit push",
  ];
  for (const cmd of ps) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, JSON.stringify(cmd));
});

// The hook judges each call twice: with $( ) read as above, and the legacy
// way, by its quotes only. In bash a # inside ${ } is no comment, but the
// first reading takes it for one, runs past the ) after it, and reads the
// git push as quoted text. The legacy reading ends the $( ) at that ) and
// finds the push. bash ran it.
test('a git push that one reading of $( ) misses is found by the other', () => {
  const root = makeRepo();
  const push = 'x="$(echo ${y:- #})\n"\ngit push\n# "';
  assert.equal(command(root, push, () => {}).deny, true, 'the current call');
  // Earlier calls are read both ways too: the push used the line up.
  assert.equal(edit(root, (t) => ready(t).call('toolu_p', 'Bash', {command: push})).deny, true, 'an earlier call');
  // The legacy reading reads a $( )'s body, and the script after pwsh -c, the
  // legacy way too. The first reading takes the # in backticks for a comment
  // (bash ran this push), and runs a PowerShell comment past a lone CR,
  // where pwsh ends it (pwsh ran the second push).
  assert.equal(command(root, 'z=$(y="$(echo `echo #`)"; git push; # "\n)', () => {}).deny, true, 'a $( ) body');
  assert.equal(command(root, "pwsh -c '$m = $(# x\r); git push'", () => {}).deny, true, 'pwsh -c');
  assert.equal(command(root, '$m = $(# x\r); git push', () => {}, {tool: 'PowerShell'}).deny, true, 'PowerShell');
  // In PowerShell double quotes the legacy reading ends a $( ) by its quotes,
  // and its here-string check skips one the same way, as main did. pwsh can't
  // parse these two, and main denied them, so the hook still does.
  assert.equal(command(root, "$m = \"$('(')\"\ngit push", () => {}, {tool: 'PowerShell'}).deny, true, 'legacy $( ) in quotes');
  assert.equal(command(root, "$m = \"$('(')\" + @'\nit's\n'@\ngit push", () => {}, {tool: 'PowerShell'}).deny, true, 'legacy here-string check');
});

// Q82: an escape before a newline. bash on Linux reads \ CR LF as an escaped
// CR, so the LF ends the command, and Git Bash joins the lines. pwsh reads `
// and a newline as a space where a token starts, after a quoted string or a
// $( ) too, and inside a word as an escaped CR (the LF ends the command) or
// LF (part of the word). The hook joined the lines everywhere, gluing the
// next line to the word before, so a git push there was read as the words of
// another command. Each push input ran its push in WSL bash 5.2 or Git Bash
// 5.3, or in pwsh 7.7, whose parser showed a NewLine or a LineContinuation
// there (scratch q82/probe*.mjs).
test('an escape before a newline is read as each shell reads it', () => {
  const root = makeRepo();
  const sh = [
    'echo \\\r\ngit push',
    'echo a\\\r\ngit push',
    "echo 'a'\\\r\ngit push",
    'x=$(echo a \\\r\ngit push)',
    'x="$(echo a \\\r\ngit push)"',
    "bash -c 'echo a\\\r\ngit push'",
    // The # after it starts a comment, so the quote in that is text (Bugbot
    // on PR 21).
    "echo a\\\r\n#b'\ngit push\n# '",
    // Git Bash joins: a#b is one word, and the push runs.
    'echo a\\\r\n#b; git push',
  ];
  for (const cmd of sh) assert.equal(command(root, cmd, () => {}).deny, true, JSON.stringify(cmd));
  const ps = [
    // Inside a word, an ${ } that ends in }, a <# #> inside a word, and
    // after U+FEFF, which pwsh reads as no space.
    'echo a`\r\ngit push',
    'echo $x`\r\ngit push',
    "echo a'b'`\r\ngit push",
    'echo ${a}`\r\ngit push',
    'echo a<#c#>`\r\ngit push',
    'echo a﻿`\r\ngit push',
    "echo a`\r\n#b'\ngit push\n# '",
    // Where a token starts pwsh joins, so git and push are one command; the
    // second line here joins and the first doesn't.
    'git `\r\npush',
    "echo a`\r\n#b'\ngit `\r\npush\n# '",
    // After a quoted string or a $( ) a token starts too, with LF or CR LF:
    // the word ends there, so git and push are one command, and the # after
    // it starts a comment.
    "& 'git'`\r\npush",
    "& 'git'`\npush",
    '& "git"`\npush',
    "git 'push'`\norigin",
    "echo 'a'`\n#b'\ngit push\n# '",
    "echo $(1)`\n#b'\ngit push\n# '",
    "pwsh -c 'echo a`\r\ngit push'",
    // After an index or a member, too, which this hook can't tell from a
    // word: the reading that ends each such word finds these.
    "echo $x[0]`\n#'\ngit push\n#'",
    "echo $x.y`\n#'\ngit push\n#'",
  ];
  for (const cmd of ps) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, JSON.stringify(cmd));
  // pwsh joins these, so git and push are echo's words, and inside a word
  // ` LF is part of it: it ran no git.
  assert.equal(command(root, 'echo `\r\ngit push', () => {}, {tool: 'PowerShell'}).deny, false, 'pwsh: after a space');
  assert.equal(command(root, 'echo a`\ngit push', () => {}, {tool: 'PowerShell'}).deny, false, 'pwsh: LF inside a word');
  // Earlier calls are read those ways too, though the current call holds no
  // CR and no newline.
  assert.equal(edit(root, (t) => ready(t).call('toolu_p', 'Bash', {command: 'echo \\\r\ngit push'})).deny, true, 'an earlier Bash call');
  assert.equal(edit(root, (t) => ready(t).call('toolu_p', 'PowerShell', {command: 'echo a`\r\ngit push'})).deny, true, 'an earlier PowerShell call');
  assert.equal(edit(root, (t) => ready(t).call('toolu_p', 'PowerShell', {command: "& 'git'`\npush"})).deny, true, 'an earlier PowerShell call with LF');
  // And so is the current call. The turn has the line and no lookup. Joined,
  // this command is a lookup alone, which counts; split, its push comes
  // first, and a lookup after the push doesn't count.
  assert.equal(command(root, `echo \\\r\ngit push; ${LOOKUP}`, (t) => t.newMessage().text(LINE)).reason, REASON_LOOKUP, 'the current call');
});

// Q82: a CR anywhere. pwsh reads one with no LF after it as a newline in
// code, but not in a string or a <# #>; Git Bash and cmd drop each one, in
// quotes too; bash on Linux reads it as part of a word. The hook read it as a
// space everywhere, and skipped a command whose text held no "git". Each push
// input ran its push in pwsh 7.7, Git Bash 5.3 or cmd (scratch
// q82/probe7.mjs to probe12.mjs), and each other input ran none.
test('a CR is read as each shell reads it', () => {
  const root = makeRepo();
  const GB = 'C:/Program Files/Git/bin/bash.exe';
  const ps = [
    'echo a\rgit push',
    'echo a \rgit push',
    // It ends a comment, and after a quoted string an escape before it is
    // a space; after an escaped ` it is a newline.
    'echo a # c\rgit push',
    "& 'git'`\rpush",
    'echo a``\rgit push',
    'echo a |\rgit push',
    "$x = @'\rgit push\r'@\rgit push",
    "$x = @'\r'\r'@\rgit push",
    '& { echo a\rgit push }',
    'echo $(echo a\rgit push)',
    // It ends a comment inside a $( ) too: at the depth limit the $( ) isn't
    // read, so where it ends matters.
    '$($($($(echo $(echo a # c\r)\rgit push))))',
    // A CR in a string is the inner shell's: Git Bash and cmd drop it.
    `echo a\`\r\n& '${GB}' -c "git pu\rsh"`,
    'cmd /d /c "git pu\rsh"',
    // A quoted string's or a $( )'s escape before a LF ends the word, so the
    // # after it starts a comment, while the next line's escape is inside a
    // word, so its LF ends the command. One reading of each is not enough.
    // Inside a $( ) it is the same, and so for a word the hook can't place.
    "echo 'x'`\n#'\necho a`\r\ngit push\n#'",
    "echo \"x\"`\n#'\necho a`\r\ngit push\n#'",
    "echo $(1)`\n#'\necho a`\r\ngit push\n#'",
    "$x = $(echo $x[0]`\n#)'\ngit push\n#'\n)",
    "$x = $(echo 'a'`\n#)'\ngit push\n#'\n)",
    "$x = $(echo 'a'`\n#)'\necho b`\r\ngit push\n#'\n)",
  ];
  for (const cmd of ps) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, JSON.stringify(cmd));
  const psNone = ['echo a`\rgit push', 'echo "a\rgit push"', "echo 'a\rgit push'", 'echo a <# c\rgit push #>', "$x = @'\r\ngit push\r\n'@\r\necho b"];
  for (const cmd of psNone) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, false, JSON.stringify(cmd));
  // Git Bash drops the CR, in pwsh's path too, and pwsh reads ` LF after
  // "git" as a space (run with pwsh's full path).
  const sh = ['git pu\rsh', 'g\rit push', 'x=$(git pu\rsh)', "'/c/Program Files/PowerShell/7/pw\rsh.exe' -NoProfile -Command '& \"git\"`\npush'"];
  for (const cmd of sh) assert.equal(command(root, cmd, () => {}).deny, true, JSON.stringify(cmd));
  // bash on Linux reads a\rgit as one word, and Git Bash echo agit.
  assert.equal(command(root, 'echo a\rgit push', () => {}).deny, false, 'sh: a CR inside a word');
  // An earlier call whose text holds no "git" but for a CR is read too.
  assert.equal(edit(root, (t) => ready(t).call('toolu_p', 'Bash', {command: 'g\rit push'})).deny, true, 'an earlier Bash call');
  assert.equal(edit(root, (t) => ready(t).call('toolu_p', 'PowerShell', {command: 'echo a\rgit push'})).deny, true, 'an earlier PowerShell call');
});

// Q82: a shell inside a shell is read each sh way with each PowerShell way.
// bash on Linux ends the command at \ CR LF and runs pwsh, which ends it at
// ` CR LF inside a word, or reads ` LF after $x[0] as a space; Git Bash drops
// the CR in pwsh's name. WSL bash ran pwsh (a stub) with the inner script,
// and pwsh 7.7 ran each inner script's push; Git Bash ran pwsh, which ran it
// (scratch q82/probe13.mjs).
test('each sh way is read with each PowerShell way', () => {
  const root = makeRepo();
  const inner = "echo $x[0]`\n#\"\ngit push\n#\"";
  const cases = [
    ["echo a\\\r\npwsh -c 'echo a`\r\ngit push'", 'linux, in'],
    [`echo a\\\r\npwsh -c '${inner}'`, 'linux, start'],
    [`'/c/Program Files/PowerShell/7/pw\rsh.exe' -NoProfile -Command '${inner}'`, 'git, start'],
  ];
  for (const [cmd, name] of cases) assert.equal(command(root, cmd, () => {}).deny, true, name);
});

// Q82: a split reading the current call doesn't need is the one that stands
// for it, not the plain one. The earlier Bash call is a lookup only in bash on
// Linux (Git Bash drops the CR and joins the lines), and the current call
// pushes before its own lookup only as pwsh reads a quoted string's escape. As
// Git Bash and pwsh read the two, no lookup comes before the push.
test('a split reading the current call needs no other way is its partner', () => {
  const root = makeRepo();
  const early = `echo a\\\r\n${LOOKUP}`;
  const cmd = `echo 'x'\`\n#'\ngit push\n#'\n${LOOKUP}`;
  const r = command(root, cmd, (t) => t.newMessage().text(LINE).call('toolu_e', 'Bash', {command: early}, '-- 0 shown; 0 lessons'), {tool: 'PowerShell'});
  assert.equal(r.deny, true, 'git, in: its linux partner');
  assert.equal(r.reason, REASON_LOOKUP);
  // The other way: the earlier PowerShell call is a lookup only where $x[0]
  // is read as one the escape is inside, and the current call, with no `,
  // pushes before its lookup only in bash on Linux. Where $x[0] ends at the
  // escape, as pwsh reads it, no lookup comes before the push.
  const earlyPs = `echo $x[0]\`\n#'\n'\n${LOOKUP}`;
  const sh = `echo a\\\r\ngit push; ${LOOKUP}`;
  const s = command(root, sh, (t) => t.newMessage().text(LINE).call('toolu_e', 'PowerShell', {command: earlyPs}, '-- 0 shown; 0 lessons'));
  assert.equal(s.deny, true, 'linux, start: its in partner');
  assert.equal(s.reason, REASON_LOOKUP);
});

// Q82: each command of the turn is walked once for each way it reads, and
// that reading is its own: the same text as another call's in another tool,
// or another folder, is read again. pwsh reads a lone CR as a newline, and no
// bash does, and a push in a folder with no gated repo uses nothing up.
test('a command read once is read in its own tool and folder', () => {
  const root = makeRepo();
  const other = scratch();
  const cr = 'echo a\rgit push';
  assert.equal(edit(root, (t) => ready(t).call('toolu_b', 'Bash', {command: cr})).deny, false, 'in Bash, no push');
  assert.equal(edit(root, (t) => ready(t).call('toolu_b', 'Bash', {command: cr}).call('toolu_p', 'PowerShell', {command: cr})).deny, true, 'then in PowerShell, a push');
  const away = (t) => {
    ready(t);
    t.cwd = other;
    t.call('toolu_o', 'Bash', {command: 'git push'});
    t.cwd = root;
    return t;
  };
  assert.equal(edit(root, away).deny, false, 'a push with no gated repo');
  assert.equal(edit(root, (t) => away(t).call('toolu_r', 'Bash', {command: 'git push'})).deny, true, 'then one in the repo');
});

// Each command is read in its own stand-in, so a pair of ways no one command
// needs still pairs two commands' partners: on Windows, a Bash call read the
// Git Bash way and a PowerShell call read the `start` way (Bugbot on PR 22).
// Git Bash 5.3 drops A's CR and joins the lines, so its lookup is quoted text
// (WSL bash runs it). pwsh 7.7 reads B's backtick after $x[0] as a space, so
// the push runs and the lookup after it is a comment (read `in`, the lookup
// runs and the push is quoted).
test('a turn is read with each pair of ways, though no one command needs that pair', () => {
  const root = makeRepo();
  const a = `echo a\\\r\n#b'\n${LOOKUP}\n# '`;
  const b = `echo $x[0]\`\n#'\ngit push\n#'; ${LOOKUP}`;
  const r = command(root, b, (t) => t.newMessage().text(LINE).call('toolu_a', 'Bash', {command: a}), {tool: 'PowerShell'});
  assert.equal(r.reason, REASON_LOOKUP);
  assert.equal(command(root, b, (t) => ready(t).call('toolu_a', 'Bash', {command: a}), {tool: 'PowerShell'}).deny, false, 'with a lookup before it');
});

// Claude Code ends a hook at its timeout and then runs the call: in 2.1.332 a
// gate that took past 10 s left a `hook_cancelled` record with timedOut, and
// the `git push` it would have denied ran (dev/release-state.md, Q82). So the
// gate stops reading at its own deadline, well inside that timeout, and
// denies. LESSONS_GATE_DEADLINE_MS lowers the deadline; at 1 ms it has passed
// before the gate reads its first command.
test('a gate out of time denies the call, and a call it never reads still passes', () => {
  const root = makeRepo();
  const late = {LESSONS_GATE_DEADLINE_MS: '1'};
  const turn = (t) => ready(t).call('toolu_s', 'Bash', {command: `git -C "${root}" status`});
  assert.equal(edit(root, turn).deny, false, 'an edit in time');
  assert.equal(edit(root, turn, {env: late}).reason, REASON_LATE, 'an edit out of time');
  assert.equal(command(root, 'git push', ready).deny, false, 'a push in time');
  assert.equal(command(root, 'git push', ready, {env: late}).reason, REASON_LATE, 'a push out of time');
  assert.equal(command(root, 'ls -la', () => {}, {env: late}).deny, false, 'no git: not read');
  assert.equal(edit(makeRepo({check: false}), () => {}, {env: late}).deny, false, 'an edit in a repo without the check');
  // It only lowers the deadline: a value past it, or not a number, is the deadline.
  for (const v of ['', 'x', '-1', '600000']) assert.equal(edit(root, turn, {env: {LESSONS_GATE_DEADLINE_MS: v}}).deny, false, JSON.stringify(v));
});

test('a call the gate denied for lack of time never ran', () => {
  const root = makeRepo();
  const denied = (t) => ready(t).newMessage().use('toolu_p', 'Bash', {command: 'git push'}).result('toolu_p', `PreToolUse:Bash hook error: ${REASON_LATE}`, true);
  assert.equal(edit(root, denied).deny, false);
});

// Claude Code ends the hook at hooks.json's timeout, and so may Codex. The
// deadline leaves 3 seconds of it for Node's start (behind a shell, in Codex)
// and for the last piece of work before the gate looks at the clock.
test('the gate\'s deadline is well inside the timeout hooks.json gives it, in both copies', () => {
  const m = /^const DEADLINE = (\d+);/m.exec(readFileSync(GATE, 'utf8'));
  assert.ok(m, 'const DEADLINE = <ms>; in the gate');
  for (const dir of [PLUGIN, join(ROOT, 'plugins/lessons-learned-codex')]) {
    const hooks = JSON.parse(readFileSync(join(dir, 'hooks/hooks.json'), 'utf8'));
    const gates = hooks.hooks.PreToolUse.flatMap((x) => x.hooks);
    assert.ok(gates.length > 0, dir);
    for (const h of gates) assert.ok(h.timeout * 1000 - Number(m[1]) >= 3000, `${dir}: timeout ${h.timeout} s, deadline ${m[1]} ms`);
  }
});

// bash on Linux reads a CR inside a word as part of it, so `a<CR>b` is one
// folder, which Windows can't name. The push ran in WSL bash 5.2.
test('a CR inside a folder name is part of it', {skip: process.platform === 'win32' && 'no CR in a Windows file name'}, () => {
  const root = makeRepo();
  mkdirSync(join(root, 'a\rb'));
  assert.equal(command(root, 'git -C a\rb push', () => {}).deny, true, 'git -C');
  assert.equal(command(root, 'cd a\rb && git push', () => {}).deny, true, 'cd');
});

// Q83: the gate read a call only when its text held "git". The shells drop
// quotes and escapes, join lines at an escape and decode $'\x67' or `u{67},
// bash reads $"git" as "git", and Windows and macOS find GIT too. Each push
// ran in WSL bash 5.2 with a stub git, in Git Bash 5.3 (real git, outside a
// repo), or in pwsh 7.7's parser (scratch q83/probe-sh.mjs, probe-ps.mjs).
test('git spelled with quotes, escapes, a line join or capitals is read', () => {
  const root = makeRepo();
  const sh = ["g'i't push", 'g""it push', 'gi\\\nt push', 'GIT push', "g$'i't push", "g$'\\x69't push", "$'\\147\\151\\164' push", "$'\\u0067'it push", '$"git" push', 'g\\it push'];
  for (const cmd of sh) assert.equal(command(root, cmd, () => {}).deny, true, JSON.stringify(cmd));
  const ps = ["g'i't push", 'Git push', '& "g`u{69}t" push'];
  for (const cmd of ps) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, JSON.stringify(cmd));
  // An earlier call is read too: its push uses up the line.
  assert.equal(edit(root, (t) => ready(t).call('toolu_p', 'Bash', {command: "g'i't push"})).deny, true, 'an earlier call with quotes');
  assert.equal(edit(root, (t) => ready(t).call('toolu_p', 'Bash', {command: 'gi\\\nt push'})).deny, true, 'an earlier line join');
  assert.equal(edit(root, (t) => ready(t).call('toolu_p', 'PowerShell', {command: 'GIT push'})).deny, true, 'an earlier GIT');
});

// Q83: bash reads a here-doc's tag as a word: quotes and escapes come off, and
// any other character is kept, a CR too in bash on Linux. The gate's tag ended
// at the first character outside [A-Za-z0-9_.-], so the body ended at another
// line, or no here-doc opened and a quote in its body hid the push. Each push
// ran in WSL bash 5.2 (scratch q83/probe-sh.mjs).
test('a here-doc tag is read as bash reads the word', () => {
  const root = makeRepo();
  const sh = [
    'cat <<E+F\nx\nE+F\ngit push\nE\n',
    "cat <<E'F'\nx\nEF\ngit push\nE\n",
    'cat <<E\\F\nx\nEF\ngit push\nE\n',
    'cat <<"E"F\nx\nEF\ngit push\nE\n',
    "cat <<$x\nit's\n$x\ngit push\n# '\n",
    "cat <<E$'\\x2b'F\nx\nE+F\ngit push\nE\n",
    // bash on Linux keeps the CR, so only a line ending in one ends the body.
    "cat <<EOF\r\nEOF\nit's\nEOF\r\ngit push\n",
  ];
  for (const cmd of sh) assert.equal(command(root, cmd, () => {}).deny, true, JSON.stringify(cmd));
  // The body is still text.
  assert.equal(command(root, 'cat <<E+F\ngit push\nE+F\n', () => {}).deny, false, 'a body');
});

// Q83: pwsh reads U+0085, U+00A0, U+2028, U+3000 and the other Unicode spaces
// as a space, and U+FEFF, U+180E and U+200B as part of a word. bash reads only
// a space or a tab. The gate read JavaScript's \s, so a # after U+FEFF, or in
// bash after U+00A0, started a comment, and pwsh's git, U+0085, push was one
// word. Each push ran in pwsh 7.7's parser or WSL bash 5.2 (scratch
// q83/probe-ps.mjs, probe-sh.mjs).
test('a space is what each shell reads as one', () => {
  const root = makeRepo();
  const ps = ['echo a\ufeff#b; git push', 'git\u0085push', 'git\u2028push', 'echo a\ufeff#b <# x #>; git push'];
  // A # after U+0085 starts a comment, so the @' after it opens no
  // here-string (scratch q83/probe-codeat.mjs).
  ps.push("echo a\u0085#b @'\ngit push\n'@'");
  // And in a $( ), so its ) is no end (scratch q83/verify-more.mjs).
  ps.push("$m = $(echo a\u0085#)'\ngit push\n)#'");
  // U+2000 to U+200A and U+2028 are spaces too. The legacy reading reads
  // them so as well, so each follows a git only the other readings decode.
  ps.push('g`u{69}t\u2002push', 'g`u{69}t\u2028push');
  for (const cmd of ps) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, JSON.stringify(cmd));
  const sh = ['echo a\u00a0#b; git push', 'echo a\u000b#b; git push', 'echo a\u000c#b; git push', 'echo a\ufeff#b; git push', 'echo a\u2028#b; git push', 'echo a\u0085#b; git push', 'echo a\u3000#b; git push'];
  // A # after U+00A0 is no comment, so the << after it opens a here-doc.
  sh.push("echo a\u00a0#b <<E\nit's\nE\ngit push\n");
  for (const cmd of sh) assert.equal(command(root, cmd, () => {}).deny, true, JSON.stringify(cmd));
  // pwsh reads U+00A0 as a space, so the # starts a comment there.
  assert.equal(command(root, 'echo a\u00a0#b; git push', () => {}, {tool: 'PowerShell'}).deny, false, 'pwsh: U+00A0 is a space');
});

// Q83: pwsh reads `n, `r, `t, `0, `a, `b, `e, `f, `v and `u{..} in a bareword
// and in double quotes, and keeps a newline after ` in double quotes. The gate
// read the letter, so a script given to pwsh -Command that way was one line.
// Each inner push ran in pwsh 7.7 with a stub git (scratch
// q83/probe-ps-run.mjs).
test('a PowerShell escape is read as pwsh reads it', () => {
  const root = makeRepo();
  const ps = [
    'pwsh -Command "echo a`ngit push"',
    'pwsh -Command echo a`ngit push',
    'pwsh -Command "echo a`rgit push"',
    'pwsh -Command "echo a`u{a}git push"',
    'pwsh -Command "echo a`u{0D}git push"',
    'pwsh -Command "echo a`\ngit push"',
  ];
  for (const cmd of ps) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, JSON.stringify(cmd));
  // In a word, `n is a line feed inside it: echo's word, no push.
  assert.equal(command(root, 'echo a`ngit push', () => {}, {tool: 'PowerShell'}).deny, false, 'a line feed in a word');
});

// Q83: bash's $'..' reads \n, \r, \t, octal, \x, \u, \U, \c and the rest, and
// an escape it doesn't know keeps its backslash. The gate read the letter
// alone, so a script given to bash -c that way was one line. Each push ran in
// WSL bash 5.2 (scratch q83/probe-sh.mjs).
test("a bash $'..' escape is read as bash reads it", () => {
  const root = makeRepo();
  const sh = [
    "bash -c $'echo a\\ngit push'",
    "bash -c $'echo a\\012git push'",
    "bash -c $'echo a\\x0agit push'",
    "bash -c $'echo a\\cJgit push'",
    "bash -c $'echo a\\u000agit push'",
    "bash -c $'echo a\\U0000000Agit push'",
    // Git Bash drops the CR the outer bash makes.
    "bash -c $'git pu\\rsh'",
  ];
  for (const cmd of sh) assert.equal(command(root, cmd, () => {}).deny, true, JSON.stringify(cmd));
  // A NUL ends the string: bash runs echo a.
  assert.equal(command(root, "bash -c $'echo a\\0\\ngit push'", () => {}).deny, false, 'a NUL');
});

// Q83: pwsh decides how it reads ` and a newline by the word before it
// (scratch q83/probe-ps.mjs, probe-ps2.mjs). Inside a plain word the newline
// is part of it, or with CR LF the CR is and the LF ends the command. After an
// index or a member ($x[0], $x.y, "a".Length) it is a space. After a
// parameter (-a, :a, or a letter past ASCII) the ` is part of it and the
// newline ends the command. The gate read each word it couldn't place one way
// in a reading, so a command with two kinds was misread in each. And a quoted
// string or a $( ) that starts an argument ends it, unless an index or a
// member follows: git "push"x runs git push x (scratch q83/probe-after*.ps1).
// Each push ran in pwsh 7.7, its parser or with a stub git.
test('a PowerShell escape before a newline is read by the word before it', () => {
  const root = makeRepo();
  const ps = [
    "echo $x[0]`\n#'\necho a`\r\ngit push\n#'",
    "echo -a`\n#'\necho a`\r\ngit push\n#'",
    "echo \"a\".Length`\n#'\necho a`\r\ngit push\n#'",
    "echo $x.y-z`\n#'\necho a`\r\ngit push\n#'",
    "echo :a`\n#'\necho a`\r\ngit push\n#'",
    "echo -\u00e9`\n#'\necho a`\r\ngit push\n#'",
    "echo 'a'.Length`\n#'\necho a`\r\ngit push\n#'",
    "echo $(1).x`\n#'\necho a`\r\ngit push\n#'",
    "echo $x.y(1)`\n#'\necho a`\r\ngit push\n#'",
    // A word right after a ) goes on with the value before it, so these end
    // in an expression, where a(1) is a and (1).
    "echo $x.y(1).z`\n#'\necho a`\r\ngit push\n#'",
    "echo $x.y(1)[0]`\n#'\necho a`\r\ngit push\n#'",
    "echo (1).z`\n#'\necho a`\r\ngit push\n#'",
    "echo a(1).z`\n#'\necho a`\r\ngit push\n#'",
    "$m = $(echo $x.y(1).z`\n#'\necho a`\n#'\n)\n'\n)\ngit push",
    // Inside a $( ), too.
    "$m = $(echo $x[0]`\n#)'\necho a`\r\ngit push\n#'\n)",
    // There after a plain word the LF is part of it, so its # is text and
    // its quote holds the first ).
    "$m = $(echo $x[0]`\n#'\necho a`\n#'\n)\n'\n)\ngit push",
    // After a $( ) inside a word in a $( ), the word goes on, so the # is
    // text and the quote holds the first ). The #" after "a" is a comment.
    "$m = $(echo x$(echo a)#'\n)\n'\n)\necho \"a\"#\"\ngit push",
    // A # after a quoted string that starts a word starts a comment, so the
    // ) after it is not the $( )'s end, and the quote after that no quote.
    "$m = $(echo \"a\"#)'\ngit push\n)#'",
    // The gate keeps its place in a word from one escape to the next, so
    // these go on past an escape inside the word: in an index two deep, in
    // the first of two indexes, and in a ${ } name (scratch q83/mut2.mjs,
    // verify-q83f.mjs).
    "echo $x[$y[`\n0]]`\n#'\necho a`\r\ngit push\n#'",
    "echo $x[`\n0][`\n0]`\n#'\necho a`\r\ngit push\n#'",
    "echo ${a`\nb}.c`\n#'\necho a`\r\ngit push\n#'",
    'git "push"x',
    "git 'push'x",
    '& "git"push',
  ];
  for (const cmd of ps) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, JSON.stringify(cmd));
  // A plain word after an index is a new word: its newline is part of it, so
  // the # is text and the quote hides the push from pwsh too. The gate leaves
  // a word after an index to each reading (the next test), so it denies this
  // call, as main did.
  assert.equal(command(root, "echo $x[0]a`\n#'\ngit push\n#'", () => {}, {tool: 'PowerShell'}).deny, true, 'a word after an index');
  // The same after a ( ), in a $( ) or not (scratch q83/verify-q83d.mjs). In
  // the $( ) the gate can't place the word either, so it denies, as main did.
  assert.equal(command(root, "echo (1)z`\n#'\necho a`\r\ngit push\n#'", () => {}, {tool: 'PowerShell'}).deny, false, 'a word after a ( )');
  assert.equal(command(root, "$m = $(echo (1)z`\n#'\n)\ngit push\n#'\n)", () => {}, {tool: 'PowerShell'}).deny, true, 'a word after a ( ) in a $( )');
  assert.equal(command(root, 'git a"push"', () => {}, {tool: 'PowerShell'}).deny, false, 'a quote inside a word');
  // After -a: they are a space, so git is -a's value; and a # after a $( )
  // inside a word is part of the word, so the ) ends the $( ) and the quote
  // after it is a quote (scratch q83/verify-more.mjs).
  assert.equal(command(root, 'echo -a:`\ngit push', () => {}, {tool: 'PowerShell'}).deny, false, 'after -a:');
  // The same after a dash pwsh reads as - (PS_DASH): git is the value, and
  // after git -c, push is git's (pwsh passes git -c, U+2013 a:, push). Q83
  // review round 2: these fail on a mutant that reads only - there
  // (scratch q83/review2-code/mut/colon.mjs), and the second on round 1's
  // reviewed gate.
  assert.equal(command(root, 'echo –a:`\ngit push', () => {}, {tool: 'PowerShell'}).deny, false, 'after U+2013 a:');
  assert.equal(command(root, 'git -c –a:`\npush', () => {}, {tool: 'PowerShell'}).deny, true, 'git -c U+2013 a: push');
  assert.equal(command(root, "echo $(echo x$(echo a)#) '\ngit push\n'", () => {}, {tool: 'PowerShell'}).deny, false, 'a # after a $( ) in a word');
});

// After a parameter, a ` and a carriage return with no line feed after it end
// the line too, as pwsh reads a lone CR as a line end (Q82). Each push ran in
// pwsh 7.7 with a stub git, at a statement's start, after echo and in a script
// block; main let each through (Q83 review round 2, scratch
// q83/verify/r2/fd3.json).
test('a PowerShell parameter before a backtick and a lone carriage return ends the line', () => {
  const root = makeRepo();
  for (const cmd of ['-a$x`\rgit push', 'echo -a$x`\rgit push', 'echo –a$x`\rgit push', '& { -a$x`\rgit push\r}']) {
    assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, JSON.stringify(cmd));
  }
});

// Q83 review round 1: where the gate couldn't place the word before a ` and a
// newline, it read the newline as part of the word in both PowerShell
// readings, so neither found the push pwsh runs on the next line, and main
// did. Such a word is now left to each reading. And pwsh reads an en dash, an
// em dash or a horizontal bar as a parameter's dash. Each push ran in pwsh 7.7
// with a stub git (scratch q83/verify/r1-cases.mjs, dash.mjs).
test('a PowerShell word the gate cannot place before an escape is read each way', () => {
  const root = makeRepo();
  const T = '`';
  const tail = `${T}\n#'\ngit push\n#'`;
  const ps = [
    `echo a,-a${tail}`,
    `$m = $x${tail}`,
    `$x+$y${tail}`,
    `echo $x[']']${tail}`,
    `$x["["]${tail}`,
    `(1)[']']${tail}`,
    `$h = @{'a"b'='v'}; echo $h."a${T}"b"${tail}`,
    `echo $('a', ')')[0]${tail}`,
    `echo $x[(1)]${tail}`,
    `echo $x.$(1)${tail}`,
    `echo @{a=1}.y${tail}`,
    `echo -a:$x.y${tail}`,
    `echo $(echo $x[']']${T}\n#)'\ngit push\n)`,
    `echo $(echo (1).y$((2))${T}\n#)'\ngit push\n)`,
    `$x=@{']'='.'}; git -C $x[']']${T}\npush`,
    `& –a${T}\ngit push`,
    `echo —a${T}\ngit push`,
    `―a${T}\ngit push`,
    `echo a,–a${tail}`,
  ];
  for (const cmd of ps) assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, JSON.stringify(cmd));
});

// A random PowerShell expression from `byte`: quotes, ( ), $( ) inside double
// quotes, and comments in a $( ) outside them, nested. A <# #> is on one line,
// as the check for an @' opener reads one line at a time (SECURITY.md, known
// limits). Built from pieces pwsh 7 runs. pwsh counts only parentheses in a
// $( ) inside double quotes, and reads each "" or `" there as one ", so it
// refuses an empty string, or one holding ( ) # or `, in a $( )
// inside double quotes, so those come only in a string at the top. The code
// of such a $( ) is written with bare quotes, or with each " as "" or `"
// (bare only where the character before is no " or `, which would join it).
function psExpr(byte) {
  const pick = (xs) => xs[byte() % xs.length];
  const p = (s) => () => s;
  const escape = (code) => {
    let out = '';
    for (const c of code) out += c !== '"' ? c : pick(/["`]$/.test(out) ? ['""', '`"'] : ['"', '""', '`"']);
    return out;
  };
  const expr = (d) => Array.from({length: 1 + (byte() % 2)}, () => atom(d)).join(' + ');
  const atom = (d) => {
    const top = (piece) => (d === 0 ? piece : 'b');
    const many = (pieces) => Array.from({length: d === 0 ? byte() % 4 : 1 + (byte() % 3)}, () => pick(pieces)()).join('');
    const inString = () => (d < 2 ? `$(${pick([(c) => c, escape, escape])(expr(d + 1))})` : 'b');
    const comment = () => pick([` # ${many(['a', ' ', '(', ')', '"', "'", '$(', '#'].map(p))}\n`, ` <# ${many(['a', ' ', '(', ')', '"', "'", '$(', '#'].map(p))} #>`]);
    return pick([
      () => '$x',
      () => `'${many(['a', '"', ' ', top('('), top(')'), top('$('), top('`'), top('#'), top("''")].map(p))}'`,
      () => `"${many([...['a', "'", ' ', '$x', top('('), top(')'), top('#'), top('`"'), top('""')].map(p), inString, inString, inString])}"`,
      () => (d < 2 ? `(${expr(d + 1)})` : '$x'),
      () => (d === 0 ? `$(${expr(1)}${comment()})` : '$x'),
      () => (d === 0 ? `"$(${escape(`${expr(1)} + "${pick(['a', "'", ' '])}"`)})"` : '$x'),
    ])();
  };
  return expr(0);
}

// Random PowerShell expressions before an @' opener. Each input from seeds 1
// to 10 ran its git push in pwsh 7 with a stub git, twice.
test('property: an @\' after any balanced PowerShell expression opens a here-string', (t) => {
  const root = makeRepo();
  const {seed, byte} = seeded(t);
  for (let i = 0; i < 10; i++) {
    const cmd = `$m = ${psExpr(byte)} + @'\nit's\n'@\ngit push`;
    assert.equal(command(root, cmd, () => {}, {tool: 'PowerShell'}).deny, true, `${JSON.stringify(cmd)}, GATE_SEED=${seed}`);
  }
});

// A random sh word from `byte`, three levels deep at most: double quotes
// holding $( ) that holds more words, single quotes holding $( and other
// text, $'...' with its \ escapes, comments in a $( ) holding a ) or a quote,
// and a # inside a word, which starts no comment. Built from pieces Git Bash
// and WSL bash run.
function shWord(byte) {
  const pick = (xs) => xs[byte() % xs.length];
  const many = (pieces) => Array.from({length: byte() % 4}, () => pick(pieces)()).join('');
  const p = (s) => () => s;
  const comment = () => pick(['', ` #${many(['a', ' ', '(', ')', '"', "'", '$(', '`', '#'].map(p))}\n`]);
  const sub = (d) => (d < 3 ? `$(echo ${word(d + 1)}${comment()})` : 'b');
  const word = (d) => pick([
    () => `'${many(['a', '"', ' ', '(', ')', '$(', '`', '#', '\\'].map(p))}'`,
    () => `"${many([...['a', "'", ' ', '(', ')', '#', '\\"', '$x', "$'", '$((1+(2)))'].map(p), () => sub(d)])}"`,
    () => sub(d),
    () => `$'${many(['a', '"', ' ', '(', ')', '$(', '`', '#', "\\'", '\\\\'].map(p))}'`,
    () => `a#${pick(["')'", '")"', "$')'", 'b'])}`,
    // A \ before a newline joins the lines, so the # is inside the word.
    () => `a\\\n#${pick(["')'", 'b'])}`,
  ])();
  return word(0);
}

// Random sh words before a git push on the next line. Each input from seeds
// 1 to 10 ran its git push in Git Bash and WSL bash, twice.
test('property: a git push after any balanced sh word with nested quotes is read', (t) => {
  const root = makeRepo();
  const {seed, byte} = seeded(t);
  for (let i = 0; i < 10; i++) {
    const cmd = `x=${shWord(byte)}\ngit push`;
    assert.equal(command(root, cmd, () => {}).deny, true, `${JSON.stringify(cmd)}, GATE_SEED=${seed}`);
  }
});

// A random PowerShell word from `byte` that pwsh reads as one word up to its
// end: it starts with a letter, and each piece after it stays inside the
// word, an ${ }, a $( ) and a quoted string included. Not a <# #>: pwsh
// reads one inside a word as part of it, and the gate as a comment, a known
// limit (SECURITY.md).
function psWord(byte) {
  const pick = (xs) => xs[byte() % xs.length];
  return `a${Array.from({length: byte() % 4}, () => pick(['a', '-', '.', '$x', "'b'", '"b"', '$(1)', '${a}', '#'])).join('')}`;
}

// Random words before an escape and CR LF, then a git push on the next line.
// bash on Linux, and pwsh at the end of a word, read an escaped CR there, so
// the LF ends the command (Q82). Each input from seeds 1 to 10 ran its git
// push in WSL bash, or in pwsh 7, twice.
test('property: a git push after a word that ends in an escape and CR LF is read', (t) => {
  const root = makeRepo();
  const {seed, byte} = seeded(t);
  for (let i = 0; i < 10; i++) {
    const sh = `x=${shWord(byte)}\\\r\ngit push`;
    assert.equal(command(root, sh, () => {}).deny, true, `${JSON.stringify(sh)}, GATE_SEED=${seed}`);
    const ps = `echo ${psWord(byte)}\`\r\ngit push`;
    assert.equal(command(root, ps, () => {}, {tool: 'PowerShell'}).deny, true, `${JSON.stringify(ps)}, GATE_SEED=${seed}`);
  }
});

// Q83's generators: each takes `byte` and returns the text of one call that
// runs a git push in its shell. Each input from seeds 1 to 5 ran its push in
// WSL bash and Git Bash, or in pwsh 7 (scratch q83/gen-verify.mjs), twice.
const ch = (n) => String.fromCharCode(n);
const BS = ch(92);

// git and push, each letter written as bash or pwsh reads it as itself.
function spellSh(byte) {
  const pick = (xs) => xs[byte() % xs.length];
  const oct = (c) => c.charCodeAt(0).toString(8);
  const hex = (c) => c.charCodeAt(0).toString(16);
  const letter = (c) => pick([c, `'${c}'`, `"${c}"`, `${BS}${c}`, `$'${c}'`, `$"${c}"`, `$'${BS}x${hex(c)}'`, `$'${BS}${oct(c)}'`]);
  const join = () => pick(['', '', "''", '""', `${BS}\n`]);
  const word = (w) => [...w].map((c) => letter(c)).join(join());
  return `${word('git')} ${word('push')}`;
}
function spellPs(byte) {
  const pick = (xs) => xs[byte() % xs.length];
  // pwsh ends a word at a quote that starts it, and reads '' or "" inside
  // one as a quote, so a word starts bare and no two quotes of a kind meet.
  // A ` before a letter of no escape stands for it (not t, a tab, or u).
  // pwsh finds git in any case, but push is git's own word.
  const word = (w, caps) => {
    let out = '';
    for (const c of w) {
      const forms = [c, `'${c}'`, `"${c}"`, `"\`u{${c.charCodeAt(0).toString(16)}}"`];
      if (caps) forms.push(c.toUpperCase());
      if (c !== 't' && c !== 'u') forms.push(`\`${c}`);
      out += pick(forms.filter((f) => !`'"`.includes(f[0]) || (out !== '' && f[0] !== out.at(-1))));
    }
    return out;
  };
  const git = word('git', true);
  return `${git[0] === '`' ? '& ' : ''}${git} ${word('push', false)}`;
}

// A here-doc tag with quotes and characters past a name's, its body, the line
// that ends it as bash reads the tag, then the push.
function hereTag(byte) {
  const pick = (xs) => xs[byte() % xs.length];
  const pieces = [
    ['E', 'E'], ['F', 'F'], ['+', '+'], ['.', '.'], ['-', '-'], [':', ':'], ['@', '@'], ['%', '%'], [',', ','], ['=', '='], ['#', '#'],
    ["'+'", '+'], ['"F+"', 'F+'], [`${BS}+`, '+'], [`${BS}E`, 'E'], [`$'${BS}x2b'`, '+'], ["$'F'", 'F'], ['$"F"', 'F'],
  ];
  let raw = 'E';
  let tag = 'E';
  for (let k = 1 + (byte() % 4); k > 0; k--) {
    const [r, t] = pick(pieces);
    raw += r;
    tag += t;
  }
  return `cat <<${raw}\nx\n${tag}\ngit push\n`;
}

// A # after a character one shell reads as part of a word, where the other
// reads a space (bash: none but a space and a tab; pwsh: not U+FEFF, U+180E
// or U+200B), so the push after it runs; and a # after each character pwsh
// reads as a space, a comment that hides an @' opener.
const SH_NOT_SPACE = [0x0b, 0x0c, 0x0d, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
const PS_NOT_SPACE = [0xfeff, 0x180e, 0x200b];
const PS_SPACE = [0x09, 0x0b, 0x0c, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2006, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
function hashSh(byte) {
  const pick = (xs) => xs[byte() % xs.length];
  return `echo a${ch(pick(SH_NOT_SPACE))}#b; git push`;
}
function hashPs(byte) {
  const pick = (xs) => xs[byte() % xs.length];
  return byte() % 2 ? `echo a${ch(pick(PS_NOT_SPACE))}#b; git push` : `echo a${ch(pick(PS_SPACE))}#b @'\ngit push\n'@'`;
}

// An escape that makes a line end in an inner shell's script: bash's $'...'
// and pwsh's ` escapes.
function lineSh(byte) {
  const pick = (xs) => xs[byte() % xs.length];
  const lf = pick([`${BS}n`, `${BS}012`, `${BS}12`, `${BS}x0a`, `${BS}xA`, `${BS}cJ`, `${BS}cj`, `${BS}u000a`, `${BS}u0A`, `${BS}U0000000a`]);
  return `bash -c $'echo ${pick(['a', 'a b', "a\\'b\\'"])}${lf}git push'`;
}
function linePs(byte) {
  const pick = (xs) => xs[byte() % xs.length];
  const nl = pick(['`n', '`r', '`u{a}', '`u{0A}', '`u{00000a}', '`u{d}', '`u{D}']);
  return pick([`pwsh -NoProfile -Command "echo a${nl}git push"`, `pwsh -NoProfile -Command echo a${nl}git push`]);
}

// A pwsh word, then a ` and a LF: an expression, where they are a space, or a
// parameter, where the line ends. Then a #' and a line whose word is a plain
// one, where an escaped CR is part of it and the LF ends the command.
function psLeadWord(byte) {
  const pick = (xs) => xs[byte() % xs.length];
  const head = pick(['$x', '"a"', "'a'", '$(1)', '(1)', 'a(1)', '@(1)', '$x.y(1)', '$env:x']);
  const n = (head === '$x' || head === '$env:x' ? 1 : 0) + (byte() % 3);
  let w = head;
  for (let k = 0; k < n; k++) w += pick(['.y', '[0]', '::y', '."y"', '.y(1)', '[1][2]']);
  const word = pick([w, w, w, pick(['-a', '-ab', ':a', '-a$x'])]);
  return `echo ${word}\`\n#'\necho a\`\r\ngit push\n#'`;
}

test('property: git spelled any way a shell reads it is read', (t) => {
  const root = makeRepo();
  const {seed, byte} = seeded(t);
  for (let i = 0; i < 10; i++) {
    const sh = spellSh(byte);
    assert.equal(command(root, sh, () => {}).deny, true, `${JSON.stringify(sh)}, GATE_SEED=${seed}`);
    const ps = spellPs(byte);
    assert.equal(command(root, ps, () => {}, {tool: 'PowerShell'}).deny, true, `${JSON.stringify(ps)}, GATE_SEED=${seed}`);
  }
});

test('property: a here-doc tag with any characters bash reads is read', (t) => {
  const root = makeRepo();
  const {seed, byte} = seeded(t);
  for (let i = 0; i < 10; i++) {
    const sh = hereTag(byte);
    assert.equal(command(root, sh, () => {}).deny, true, `${JSON.stringify(sh)}, GATE_SEED=${seed}`);
  }
});

test('property: a # starts a comment only after what the shell reads as a space', (t) => {
  const root = makeRepo();
  const {seed, byte} = seeded(t);
  for (let i = 0; i < 10; i++) {
    const sh = hashSh(byte);
    assert.equal(command(root, sh, () => {}).deny, true, `${JSON.stringify(sh)}, GATE_SEED=${seed}`);
    const ps = hashPs(byte);
    assert.equal(command(root, ps, () => {}, {tool: 'PowerShell'}).deny, true, `${JSON.stringify(ps)}, GATE_SEED=${seed}`);
  }
});

test('property: an escape that makes a line end in an inner shell is read', (t) => {
  const root = makeRepo();
  const {seed, byte} = seeded(t);
  for (let i = 0; i < 10; i++) {
    const sh = lineSh(byte);
    assert.equal(command(root, sh, () => {}).deny, true, `${JSON.stringify(sh)}, GATE_SEED=${seed}`);
    const ps = linePs(byte);
    assert.equal(command(root, ps, () => {}, {tool: 'PowerShell'}).deny, true, `${JSON.stringify(ps)}, GATE_SEED=${seed}`);
  }
});

test('property: a ` and a newline after any pwsh expression or parameter are read by it', (t) => {
  const root = makeRepo();
  const {seed, byte} = seeded(t);
  for (let i = 0; i < 10; i++) {
    const ps = psLeadWord(byte);
    assert.equal(command(root, ps, () => {}, {tool: 'PowerShell'}).deny, true, `${JSON.stringify(ps)}, GATE_SEED=${seed}`);
  }
});

test('an edit in another gated repo asks only for the line, though the session repo has the script', () => {
  const root = makeRepo();
  const other = makeRepo();
  assert.equal(edit(root, (t) => t.newMessage().text(LINE), {file: join(other, 'x.txt')}).deny, false);
});

test('JSON with spaces after its colons still finds the turn start', () => {
  const root = makeRepo();
  assert.equal(edit(root, (t) => ready(t).prompt('Next.'), {respace: true}).deny, true, 'the line was in the turn before');
});

test('a settings file named with a trailing dot or a stream is gated', (t2) => {
  const root = makeRepo();
  mkdirSync(join(root, '.claude'));
  assert.equal(edit(root, () => {}, {file: join(root, '.claude', 'settings.json.')}).deny, true, 'trailing dot');
  if (!WIN) return t2.diagnostic('streams are an NTFS thing: not tried here');
  assert.equal(edit(root, () => {}, {file: join(root, '.claude', 'settings.local.json::$DATA')}).deny, true, '::$DATA');
  assert.equal(edit(root, () => {}, {file: join(root, '.claude', 'settings.json:x')}).deny, true, ':x');
});

test('a lookup counts only when it runs the session repo\'s own dev/lessons.mjs', () => {
  const root = makeRepo();
  const other = makeRepo({check: false});
  const evil = join(scratch(), 'lessons.mjs');
  writeFileSync(evil, TEMPLATE);
  const cases = {
    'another repo\'s script': `cd "${other}" && node dev/lessons.mjs hook test`,
    'a script outside any repo': `node "${evil}" hook test`,
    'echo of a lookup': 'echo node dev/lessons.mjs hook test',
    'the script given to another program': 'echo dev/lessons.mjs hook test',
  };
  for (const [name, cmd] of Object.entries(cases)) {
    const r = edit(root, (t) => t.newMessage().text(LINE).call('toolu_l', 'Bash', {command: cmd}));
    assert.equal(r.reason, REASON_LOOKUP, name);
  }
  assert.equal(edit(root, (t) => t.newMessage().text(LINE).call('toolu_l', 'Bash', {command: `cd "${join(root, 'dev')}" && node lessons.mjs hook`})).deny, false, 'its own script from another folder');
});

test('an edit in a gated repo from a session in another folder asks only for the line', () => {
  const gated = makeRepo();
  const plain = makeRepo({check: false});
  const file = join(gated, 'x.txt');
  assert.equal(edit(plain, () => {}, {file}).reason, REASON_LINE);
  assert.equal(edit(plain, (t) => t.newMessage().text(LINE), {file}).deny, false);
});

test('a past command runs in the folder its record names, not the payload\'s', () => {
  const gated = makeRepo();
  const plain = makeRepo({check: false});
  // The records were written in the gated repo; the session has since moved.
  const t = new Transcript(gated).prompt().newMessage().text(LINE);
  t.call('toolu_past', 'Bash', {command: 'git commit -m x'});
  const input = {file_path: join(gated, 'x.txt'), content: 'x'};
  const id = current(t, 'Write', input);
  assert.equal(gate(payload(t, t.write(), 'Write', input, id, {cwd: plain})).reason, REASON_LINE, 'the commit used up the line');
});

test('a lookup in the same command before its commit counts; one after it does not', () => {
  const root = makeRepo();
  const line = (t) => t.newMessage().text(LINE);
  assert.equal(command(root, 'node dev/lessons.mjs commit && git commit -m x', line).deny, false);
  assert.equal(command(root, 'git commit -m x && node dev/lessons.mjs commit', line).reason, REASON_LOOKUP);
});

test('an edit to another repo that has the check is gated, and one in a repo without it passes', () => {
  const gated = makeRepo();
  const plain = makeRepo({check: false});
  assert.equal(edit(plain, () => {}, {file: join(gated, 'a', 'new', 'file.txt')}).deny, true, 'a new file in new folders');
  assert.equal(edit(gated, () => {}, {file: join(plain, 'x.txt')}).deny, false);
  assert.equal(edit(gated, () => {}, {file: join(scratch(), 'no-repo.txt')}).deny, false, 'outside any repo');
});

test('a .git in a parent folder does not take over a repo below it', () => {
  const outer = makeRepo();
  const inner = makeRepo({check: false, at: join(outer, 'inner')});
  assert.equal(edit(outer, () => {}, {file: join(inner, 'x.txt')}).deny, false);
});

test('a worktree .git file marks the repo', () => {
  const root = makeRepo({worktree: true});
  assert.equal(edit(root, () => {}).deny, true);
});

test('NotebookEdit and MultiEdit are gated', () => {
  const root = makeRepo();
  assert.equal(edit(root, () => {}, {tool: 'NotebookEdit', file: join(root, 'a.ipynb')}).deny, true);
  assert.equal(edit(root, () => {}, {tool: 'MultiEdit'}).deny, true);
});

test('LESSONS.md, .git and .claude pass; PLAYBOOK.md, LESSONS.md:x and a nested LESSONS.md do not', () => {
  const root = makeRepo();
  writeFileSync(join(root, 'LESSONS.md'), '# LESSONS\n');
  assert.equal(edit(root, () => {}, {file: join(root, 'LESSONS.md')}).deny, false);
  assert.equal(edit(root, () => {}, {file: join(root, '.git', 'config')}).deny, false);
  assert.equal(edit(root, () => {}, {file: join(root, '.claude', 'memory', 'notes.md')}).deny, false);
  assert.equal(edit(root, () => {}, {file: join(root, 'PLAYBOOK.md')}).deny, true);
  assert.equal(edit(root, () => {}, {file: join(root, 'LESSONS.md:x')}).deny, true);
  assert.equal(edit(root, () => {}, {file: join(root, 'docs', 'LESSONS.md')}).deny, true);
  assert.equal(edit(root, () => {}, {file: join(root, 'LESSONS.md.bak')}).deny, true);
  const folded = edit(root, () => {}, {file: join(root, 'lessons.md')});
  assert.equal(folded.deny, !/^(win32|darwin)$/.test(process.platform), 'ASCII case is ignored only on Windows and macOS');
});

test('the settings files in .claude, which can turn the hook off, are gated', () => {
  const root = makeRepo();
  for (const name of ['settings.json', 'settings.local.json', 'Settings.Local.json'])
    assert.equal(edit(root, () => {}, {file: join(root, '.claude', name)}).deny, true, name);
  assert.equal(edit(root, () => {}, {file: join(root, '.claude', 'skills', 'settings.json')}).deny, false, 'a settings.json deeper down is not a settings file');
});

test('LESSONS.md given by its 8.3 short name is not exempt', (t) => {
  if (process.platform !== 'win32') return t.skip('8.3 names are a Windows thing');
  const root = makeRepo();
  const file = join(root, 'LESSONS.md');
  writeFileSync(file, '# LESSONS\n');
  const r = spawnSync('cmd', ['/d', '/s', '/c', `"for %I in ("${file}") do @echo %~sI"`], {encoding: 'utf8', windowsVerbatimArguments: true});
  const short = (r.stdout || '').trim();
  if (!short || short.toUpperCase().endsWith('LESSONS.MD')) return t.skip('this volume makes no 8.3 names');
  assert.equal(edit(root, () => {}, {file: short}).deny, true, short);
});

test('a LESSONS.md with a second hard link is not exempt', (t) => {
  if (!can.hardLink) return t.skip(NO_HARD_LINKS);
  const root = makeRepo();
  writeFileSync(join(root, 'notes.md'), 'x\n');
  linkSync(join(root, 'notes.md'), join(root, 'LESSONS.md'));
  assert.equal(edit(root, () => {}, {file: join(root, 'LESSONS.md')}).deny, true);
});

test('PLAYBOOK.md with a second hard link is not read, so the repo is not gated', (t) => {
  if (!can.hardLink) return t.skip(NO_HARD_LINKS);
  const root = makeRepo();
  const keep = join(scratch(), 'PLAYBOOK.md');
  linkSync(join(root, 'PLAYBOOK.md'), keep);
  assert.equal(edit(root, () => {}).deny, false);
});

test('the heading must be a line of its own: a BOM before it is fine, a deeper heading or a longer one is not', () => {
  assert.equal(edit(makeRepo({playbook: '\uFEFF## The lessons check\n\n1. Run it.\n'}), () => {}).deny, true, 'a BOM before the heading');
  assert.equal(edit(makeRepo({playbook: '# P\n\n### The lessons check\n'}), () => {}).deny, false, '###');
  assert.equal(edit(makeRepo({playbook: '# P\n\n## The lessons checklist\n'}), () => {}).deny, false, 'checklist');
});

// A junction to a volume path (\\?\Volume{GUID}\...), which lstat reports as a
// plain folder. Returns false where none can be made (as in stale.test.mjs).
function volumeJunction(at, target) {
  if (process.platform !== 'win32') return false;
  const drive = target.slice(0, 3);
  const vol = spawnSync('mountvol', [drive, '/L'], {encoding: 'utf8'}).stdout?.trim();
  if (!/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i.test(vol ?? '')) return false;
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', at, vol + target.slice(drive.length)], {encoding: 'utf8'});
  if (r.status !== 0) return false;
  folders.unshift(at);
  return !lstatSync(at).isSymbolicLink();
}

test('a dev folder that is a junction to a volume path is not read for the fingerprint', (t) => {
  const root = makeRepo({script: null});
  const outside = scratch();
  writeFileSync(join(outside, 'lessons.mjs'), TEMPLATE);
  if (!volumeJunction(join(root, 'dev'), outside)) return t.skip('no junction to a volume path can be made here');
  assert.equal(edit(root, () => {}).reason, REASON_LINE);
});

test('a fingerprint mismatch drops the lookup and changes the reason; line endings are ignored', () => {
  const other = makeRepo({script: 'other'});
  assert.equal(edit(other, () => {}).reason, REASON_LINE);
  assert.equal(edit(other, (t) => t.newMessage().text(LINE)).deny, false);
  const none = makeRepo({script: null});
  assert.equal(edit(none, () => {}).reason, REASON_LINE);
  const crlf = makeRepo({script: 'crlf'});
  assert.equal(edit(crlf, (t) => t.newMessage().text(LINE)).reason, REASON_LOOKUP);
});

// Each release's script, from its tag. A clone without the tags (CI checks out
// one commit) has none, and the tests that need them skip.
const RELEASES = ['v0.2.0', 'v0.2.1', 'v0.3.0', 'v0.3.1', 'v0.4.0'];
// The release tags in this clone (vX.Y.Z), or none where git can't list them.
function releaseTags() {
  try {
    return execFileSync('git', ['tag', '--list', 'v*'], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})
      .split('\n').map((s) => s.trim()).filter((s) => /^v\d+\.\d+\.\d+$/.test(s));
  } catch {
    return [];
  }
}
function releaseScript(tag) {
  try {
    return execFileSync('git', ['show', `${tag}:plugins/lessons-learned/templates/lessons.mjs`], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  } catch {
    return null;
  }
}

test('a repo with an earlier release\'s script still needs a lookup', (t) => {
  const found = RELEASES.map((tag) => [tag, releaseScript(tag)]).filter(([, text]) => text !== null);
  if (!found.length) return t.skip('no release tags in this clone');
  for (const [tag, text] of found) {
    const root = makeRepo({script: {text}});
    assert.equal(edit(root, (s) => s.newMessage().text(LINE)).reason, REASON_LOOKUP, `${tag}: a line alone`);
    assert.equal(edit(root, ready).deny, false, `${tag}: a lookup and a line`);
  }
});

test('the released fingerprints are those of the release tags\' scripts', (t) => {
  const src = readFileSync(GATE, 'utf8');
  const listed = [...src.matchAll(/^ {2}'([0-9a-f]{64})', \/\/ (v\S+)$/gm)].map((m) => [m[2], m[1]]);
  assert.deepEqual(listed.map(([tag]) => tag), RELEASES, 'the gate lists each release once, in order');
  assert.deepEqual(releaseTags().filter((tag) => !RELEASES.includes(tag)), [], 'a release tag in this clone that the gate does not list');
  const found = RELEASES.map((tag) => [tag, releaseScript(tag)]).filter(([, text]) => text !== null);
  if (!found.length) return t.skip('no release tags in this clone');
  for (const [tag, text] of found)
    assert.equal(listed.find(([v]) => v === tag)[1], createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'), tag);
});

test('a subagent passes, and so does LESSONS_GATE=off', () => {
  const root = makeRepo();
  assert.equal(edit(root, () => {}, {extra: {agent_id: 'a2c972b76cfa3cbbd', agent_type: 'general-purpose'}}).deny, false);
  assert.equal(edit(root, () => {}, {env: {LESSONS_GATE: 'off'}}).deny, false);
  assert.equal(edit(root, () => {}, {env: {LESSONS_GATE: 'on'}}).deny, true, 'only "off" turns it off');
});

test('only PreToolUse is judged, and a UNC or device path is not looked at', () => {
  const root = makeRepo();
  assert.equal(edit(root, () => {}, {extra: {hook_event_name: 'PostToolUse'}}).deny, false, 'PostToolUse');
  const device = WIN ? `\\\\?\\${join(root, 'src.txt')}` : `/${join(root, 'src.txt')}`;
  assert.equal(edit(root, () => {}, {file: device}).deny, false, device);
});

test('a path too long or too deep to walk passes at once', () => {
  const root = makeRepo();
  const deep = (n) => join(root, ...Array(n).fill('a'), 'x.txt');
  assert.equal(edit(root, () => {}, {file: deep(400)}).deny, true, '400 names is walked');
  const r = edit(root, () => {}, {file: deep(600)});
  assert.equal(r.deny, false, '600 names is not');
  assert.equal(edit(root, () => {}, {file: join(root, 'b'.repeat(4200))}).deny, false, 'over 4096 characters');
  assert.equal(command(root, `cd ${'a/../'.repeat(1000)} && git commit -m x`, () => {}).deny, false, 'a cd over 4096 characters, though it resolves short');
  // A cd under 4096 characters that resolves over them leaves the folder
  // unknown for the rest of the command, even after a cd back.
  assert.equal(command(root, `cd ${'aaaaaaaaa/'.repeat(408)} && cd ${'../'.repeat(408)} && git commit -m x`, () => {}).deny, false, 'a cd back from a folder over 4096 characters');
  assert.equal(command(join(root, ...Array(600).fill('a')), `cd "${fwd(root)}" && git commit -m x`, () => {}).deny, false, 'a session folder of 600 names');
});

test('JSON written with spaces after its colons is read the same', () => {
  const root = makeRepo();
  assert.equal(edit(root, ready, {respace: true}).deny, false, 'the line and the lookup are found');
  assert.equal(edit(root, () => {}, {respace: true}).deny, true, 'and their absence too');
  assert.equal(edit(root, (t) => ready(t).call('toolu_c', 'Bash', {command: 'git commit -m x'}), {respace: true}).deny, true, 'a commit after them');
});

test('a Write whose record is over 1 MB is found and judged', () => {
  const root = makeRepo();
  const big = 'y'.repeat(1.5 * 1024 * 1024);
  assert.equal(edit(root, () => {}, {content: big}).deny, true);
  assert.equal(edit(root, ready, {content: big}).deny, false);
  // The id after the big input, and a later record after it: the first look
  // finds the id in a cut line and must read further back.
  const t = new Transcript(root).prompt().newMessage();
  const input = {file_path: join(root, 'x.txt'), content: big};
  t.assistant({type: 'tool_use', name: 'Write', input, id: 'toolu_late_id', caller: {type: 'direct'}});
  t.use('toolu_after', 'Bash', {command: 'echo later'});
  assert.equal(gate(payload(t, t.write(), 'Write', input, 'toolu_late_id', {cwd: root})).deny, true, 'an id in a cut first line');
});

// More than a chunk (1 MB) of whole records after the call's own, as when
// earlier calls of the same message have large results. Each look reads the
// last chunk; the last look reads the whole window, so the call is found and
// judged. Before this, 0.4.0 let it through unread, and 1f68aba denied it as
// not found.
test('a call with over 1 MB of later records after its own is found and judged', {timeout: 60_000}, () => {
  const root = makeRepo();
  const input = {file_path: join(root, 'x.txt'), content: 'x'};
  const build = (t) => {
    const id = current(t, 'Write', input);
    for (let i = 0; i < 12; i++) t.result(`toolu_big${i}`, 'y'.repeat(100 * 1024));
    return id;
  };
  const t = new Transcript(root).prompt();
  t.lookup();
  const id = build(t);
  assert.equal(gate(payload(t, t.write(), 'Write', input, id, {cwd: root})).reason, REASON_LOOKUP, 'judged: no line');
  const t2 = new Transcript(root).prompt();
  ready(t2);
  const id2 = build(t2);
  assert.equal(gate(payload(t2, t2.write(), 'Write', input, id2, {cwd: root})).deny, false, 'judged: the turn is ready');
});

test('a malformed transcript, a cut first line, invalid UTF-8 and an unknown format fail open', () => {
  const root = makeRepo();
  const file = join(root, 'src.txt');
  const input = {file_path: file, content: 'x'};
  const base = {session_id: 's', cwd: root, prompt_id: 'prompt-1', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: input, tool_use_id: 'toolu_x'};
  const dir = scratch();
  const garbage = join(dir, 'garbage.jsonl');
  writeFileSync(garbage, 'not json\n{"type":"assistant",\n\u0000\u0001 toolu_x\n');
  assert.equal(gate({...base, transcript_path: garbage}).deny, false, 'garbage');
  const bytes = join(dir, 'bytes.jsonl');
  writeFileSync(bytes, Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x0a, 0x80, 0x81]));
  assert.equal(gate({...base, transcript_path: bytes}).deny, false, 'invalid UTF-8 only');
  // The call in a shape this hook doesn't know: content as a string.
  const odd = join(dir, 'odd.jsonl');
  writeFileSync(odd, `${JSON.stringify({type: 'assistant', message: {id: 'm', content: 'toolu_x'}})}\n`);
  assert.equal(gate({...base, transcript_path: odd}).deny, false, 'unknown shape');
  // The call's tool_use block in a record that is not an assistant's.
  const notAssistant = join(dir, 'user.jsonl');
  writeFileSync(notAssistant, `${JSON.stringify({type: 'user', message: {role: 'user', content: [{type: 'tool_use', id: 'toolu_x', name: 'Write', input}]}})}\n`);
  assert.equal(gate({...base, transcript_path: notAssistant}).deny, false, 'a tool_use block in a user record');
  assert.equal(gate({...base, transcript_path: join(dir, 'missing.jsonl')}).deny, false, 'no transcript');
  assert.equal(gate({...base, transcript_path: 'relative.jsonl'}).deny, false, 'a relative path');
  const r = spawnSync(process.execPath, [GATE], {input: '{not json', encoding: 'utf8'});
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  // A cut first line and invalid UTF-8 inside a record: the rest is judged.
  const t = new Transcript(root).prompt();
  t.lookup();
  const id = current(t, 'Write', input);
  const cut = join(dir, 'cut.jsonl');
  writeFileSync(cut, Buffer.concat([Buffer.from('"tail of a cut line"}\n'), Buffer.from(`${t.lines.join('\n')}\n`)]));
  assert.equal(gate({...base, transcript_path: cut, tool_use_id: id}).deny, true, 'judged: no line');
  const t2 = new Transcript(root).prompt();
  t2.lookup().newMessage().text('Lessons checked: X\uFFFDY');
  const id2 = current(t2, 'Write', input);
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, Buffer.from(`${t2.lines.join('\n')}\n`.replace('\uFFFD', '@@'), 'utf8'));
  const raw = readFileSync(bad);
  const at = raw.indexOf('@@');
  raw[at] = 0xc3;
  raw[at + 1] = 0x28;
  writeFileSync(bad, raw);
  assert.equal(gate({...base, transcript_path: bad, tool_use_id: id2}).deny, false, 'judged: the line is there');
});

test('without a turn start in the 32 MB window, the whole window is the turn', () => {
  const root = makeRepo();
  const t = new Transcript(root).prompt();
  t.newMessage().text(LINE).lookup();
  const pad = 'p'.repeat(60_000);
  while (t.lines.reduce((n, l) => n + l.length + 1, 0) < 33 * 1024 * 1024) t.newMessage().text(pad);
  const input = {file_path: join(root, 'x.txt'), content: 'x'};
  const id = current(t, 'Write', input);
  const path = t.write();
  assert.equal(gate(payload(t, path, 'Write', input, id, {cwd: root})).deny, true, 'the line is past the window');
  const t2 = new Transcript(root);
  for (let i = 0; i < 560; i++) t2.newMessage().text(pad);
  t2.newMessage().text(LINE).lookup();
  const id2 = current(t2, 'Write', input);
  const path2 = t2.write();
  assert.equal(gate(payload(t2, path2, 'Write', input, id2, {cwd: root, prompt_id: 'prompt-9'})).deny, false, 'no turn start: the window counts');
});

test('a turn start for another prompt_id fails open, and without prompt_id an older prompt starts the turn', () => {
  const root = makeRepo();
  assert.equal(edit(root, () => {}, {extra: {prompt_id: 'some-other-prompt'}}).deny, false);
  const t = new Transcript(root).oldPrompt();
  ready(t).oldPrompt('Next.');
  const input = {file_path: join(root, 'x.txt'), content: 'x'};
  const id = current(t, 'Write', input);
  const path = t.write();
  const p = payload(t, path, 'Write', input, id, {cwd: root});
  delete p.prompt_id;
  assert.equal(gate(p).deny, true, 'the line was in the turn before');
  // Meta, interrupt and slash-command records after the line: none starts a
  // turn, so the line still counts.
  const t2 = new Transcript(root).oldPrompt();
  ready(t2).meta().interrupt().push(t2.base('user', {message: {role: 'user', content: '<command-name>/x</command-name>'}}));
  const id2 = current(t2, 'Write', input);
  const p2 = payload(t2, t2.write(), 'Write', input, id2, {cwd: root});
  delete p2.prompt_id;
  assert.equal(gate(p2).deny, false, 'meta, interrupt and slash-command records are not turn starts');
});

// Runs the hook with a preload that reports, on stderr, when the hook first
// reads the transcript, so the test can act after that read whatever Node's
// start cost, and, as the hook exits, how long it ran after that read, timed
// inside the hook so the exit itself isn't counted. Returns {done, looked,
// waited}: looked resolves at that first read, or with null if the hook exits
// without one; waited() is the time the hook reported, or null.
function watched(p, extra = {}) {
  const dir = scratch();
  const preload = join(dir, 'signal.mjs');
  writeFileSync(
    preload,
    [
      "import fs from 'node:fs';",
      "import {syncBuiltinESMExports} from 'node:module';",
      'const want = process.env.GATE_TRANSCRIPT;',
      'const open = fs.openSync;',
      'const read = fs.readSync;',
      'let fd = null;',
      'let told = null;',
      'fs.openSync = function (p, ...rest) { const f = open.call(this, p, ...rest); if (String(p) === want) fd = f; return f; };',
      "fs.readSync = function (f, ...rest) { const n = read.call(this, f, ...rest); if (f === fd && told === null) { told = performance.now(); process.stderr.write('looked\\n'); } return n; };",
      "process.on('exit', () => { if (told !== null) process.stderr.write(`waited ${performance.now() - told}\\n`); });",
      'syncBuiltinESMExports();',
      '',
    ].join('\n'),
  );
  const env = {...process.env, ...extra, GATE_TRANSCRIPT: p.transcript_path};
  delete env.LESSONS_GATE;
  const {child, done} = spawn(process.execPath, ['--import', pathToFileURL(preload).href, GATE], {env});
  let err = '';
  const looked = new Promise((ok) => {
    child.stderr.on('data', (d) => {
      err += d;
      if (err.includes('looked\n')) ok(performance.now());
    });
    child.on('close', () => ok(null));
  });
  child.stdin.end(JSON.stringify(p));
  const waited = () => {
    const m = /waited ([\d.]+)/.exec(err);
    return m ? Number(m[1]) : null;
  };
  return {done, looked, waited};
}

const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
const reasonOf = (stdout) => (stdout.trim() ? JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason : null);
// The record of a Write call `id`, to append to a transcript after `t`'s.
function lateCall(t, root, id, input) {
  const late = new Transcript(root);
  late.n = t.n;
  late.msg = 99;
  late.use(id, 'Write', input);
  return `${late.lines[0]}\n`;
}

// Claude Code can write the current call's record after its hook starts: in
// Q92's tests, up to 5.9 s after the record's own time. The hook waits 1.3 s
// for it (before this change it waited 300 ms, then let the call through).
test('the hook waits for the current call to reach the transcript, then judges it, and denies a call that never comes', {timeout: 120_000}, async () => {
  const root = makeRepo();
  const t = new Transcript(root).prompt();
  t.lookup();
  const path = t.write();
  const input = {file_path: join(root, 'x.txt'), content: 'x'};
  // The call is appended only after the hook's first look found nothing.
  const one = watched(payload(t, path, 'Write', input, 'toolu_late', {cwd: root}));
  assert.notEqual(await one.looked, null, 'the hook exited without reading the transcript');
  appendFileSync(path, lateCall(t, root, 'toolu_late', input));
  assert.equal(reasonOf((await one.done).stdout), REASON_LOOKUP, 'the call came after the first look and was judged');
  // Appended 700 ms after the first look: past the old 300 ms wait.
  const two = watched(payload(t, path, 'Write', input, 'toolu_later', {cwd: root}));
  assert.notEqual(await two.looked, null, 'the hook exited without reading the transcript');
  await pause(700);
  appendFileSync(path, lateCall(t, root, 'toolu_later', input));
  assert.equal(reasonOf((await two.done).stdout), REASON_LOOKUP, 'the call came 700 ms after the first look and was judged');
  // Never written: denied, and only after the wait.
  const three = watched(payload(t, path, 'Write', input, 'toolu_never', {cwd: root}));
  assert.notEqual(await three.looked, null, 'the hook exited without reading the transcript');
  assert.equal(reasonOf((await three.done).stdout), REASON_UNSEEN, 'a call never written is denied');
  const waited = three.waited();
  assert.ok(waited !== null && waited >= 1280, `denied ${Math.round(waited)} ms after its first look, before the 1.3 s wait was over`);
});

test('a lowered deadline also ends the wait for the current call, which is then denied as late', {timeout: 60_000}, async () => {
  // No lookup is needed and the turn holds only the line, so judging the
  // turn reads no command: found in time, the call would pass.
  const root = makeRepo({script: null});
  const t = new Transcript(root).prompt();
  t.newMessage().text(LINE);
  const path = t.write();
  const input = {file_path: join(root, 'x.txt'), content: 'x'};
  // The deadline is 600 ms after Node's start. The call reaches the
  // transcript 900 ms after the hook's first look: inside the 1.3 s wait,
  // past the deadline. The gate is out of time then, so it denies the call
  // as late, in this session's transcript and in another session's, where a
  // call it can't find would pass.
  for (const [session, where] of [['sess-1', "this session's transcript"], ['sess-2', "another session's transcript"]]) {
    const id = `toolu_slow_${session}`;
    const one = watched(payload(t, path, 'Write', input, id, {cwd: root, session_id: session}), {LESSONS_GATE_DEADLINE_MS: '600'});
    assert.notEqual(await one.looked, null, 'the hook exited without reading the transcript');
    await pause(900);
    appendFileSync(path, lateCall(t, root, id, input));
    assert.equal(reasonOf((await one.done).stdout), REASON_LATE, `the wait ended at the deadline, in ${where}`);
  }
});

// A call never written is denied only where the gate can tie the transcript
// to the session; any other transcript lets it through, as before.
test('a call never written is denied only in a transcript that holds a user or assistant record of this session', {timeout: 60_000}, () => {
  const root = makeRepo();
  const input = {file_path: join(root, 'x.txt'), content: 'x'};
  const t = new Transcript(root).prompt();
  ready(t);
  const p = (file, extra = {}) => payload(t, file, 'Write', input, 'toolu_never', {cwd: root, ...extra});
  const path = t.write();
  assert.equal(gate(p(path)).reason, REASON_UNSEEN, "this session's records");
  assert.equal(gate(p(t.write(undefined, {respace: true}))).reason, REASON_UNSEEN, "this session's records, written with spaces");
  assert.equal(gate(p(path, {session_id: 'sess-2'})).deny, false, "another session's records");
  const named = new Transcript(root).prompt().text('sess-9');
  ready(named);
  assert.equal(gate(p(named.write(), {session_id: 'sess-9'})).deny, false, "another session's records, one naming this session in its text");
  assert.equal(gate(p(path, {session_id: ''})).deny, false, 'no session in the payload');
  const noise = new Transcript(root).attachment().attachment();
  assert.equal(gate(p(noise.write())).deny, false, 'only records that carry the session but are not user or assistant records');
});

// In this session's transcript, an assistant record that holds the call's id
// outside a tool_use block is the call, on disk in a shape the gate doesn't
// read, so it passes as such a record does (review round 1, F1: the probe's
// unknownShape). The call's id anywhere else is no sign it is on disk:
// Claude Code writes data-flow-records lines that name a call's id before
// the call's own record. Those, and a tool_use block in a user record, are
// denied as unseen. The turn has no line, so a call judged would be denied
// for the lookup.
test("in this session's transcript, a call's id in an assistant record outside a tool_use block passes, and elsewhere is denied", {timeout: 60_000}, () => {
  const root = makeRepo();
  const input = {file_path: join(root, 'x.txt'), content: 'x'};
  const id = 'toolu_odd';
  const run = (record) => {
    const t = new Transcript(root).prompt();
    t.lookup().newMessage();
    t.push(record(t));
    return gate(payload(t, t.write(), 'Write', input, id, {cwd: root}));
  };
  const asst = (content) => (t) => t.base('assistant', {message: {id: 'msg-odd', type: 'message', role: 'assistant', content}});
  assert.equal(run(asst(id)).deny, false, 'content as a string');
  assert.equal(run(asst([{type: 'tool_call', id, name: 'Write', input}])).deny, false, 'a block of another type');
  assert.equal(run((t) => t.base('user', {message: {role: 'user', content: [{type: 'tool_use', id, name: 'Write', input}]}})).reason, REASON_UNSEEN, 'a tool_use block in a user record');
  assert.equal(run(() => ({type: 'data-flow-records', sessionId: 'sess-1', v: 1, records: [{toolUseId: id}]})).reason, REASON_UNSEEN, 'a data-flow-records line');
});

// The look for this session's records checks the deadline too. A 33 MB
// transcript of short lines that pass its quick text test and fail to parse
// takes it seconds (3.5 s on the PC this was written on). With the deadline
// 2.5 s after Node's start, the 1.3 s wait ends before it, and the look stops
// there and denies. It fails on 1f68aba, which read all 32 MB and let the
// call through.
test("the look for this session's records stops at the deadline", {timeout: 60_000}, () => {
  const root = makeRepo();
  const input = {file_path: join(root, 'x.txt'), content: 'x'};
  const path = join(scratch(), 'transcript.jsonl');
  const line = '"sessionId" "sess-1" x\n';
  const block = line.repeat(Math.floor((1 << 20) / line.length));
  // A user record of the session first, past the 32 MB window.
  writeFileSync(path, `${JSON.stringify({sessionId: 'sess-1', type: 'user', message: {role: 'user', content: 'x'}})}\n`);
  for (let n = 0; n < 33; n++) appendFileSync(path, block);
  const p = {session_id: 'sess-1', transcript_path: path, cwd: root, prompt_id: 'prompt-1', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: input, tool_use_id: 'toolu_never'};
  assert.equal(gate(p, {LESSONS_GATE_DEADLINE_MS: '2500'}).reason, REASON_LATE);
});

test('the hook imports only fs, path and crypto, and calls no write, spawn or network function', () => {
  const src = readFileSync(GATE, 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['node:crypto', 'node:fs', 'node:path']);
  assert.doesNotMatch(src, /\brequire\s*\(|\bimport\s*\(/, 'no other way to load a module');
  for (const word of ['child_process', 'node:net', 'node:http', 'node:https', 'dgram', 'worker_threads', 'process.binding', 'writeSync', 'writeFileSync', 'appendFileSync', 'createWriteStream', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'linkSync', 'symlinkSync', 'truncate', 'chmod', 'O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_APPEND', 'O_TRUNC'])
    assert.ok(!src.includes(word), `the hook mentions ${word}`);
  const opens = [...src.matchAll(/openSync\(([^)]*)\)/g)].map((m) => m[1]);
  for (const o of opens) assert.match(o, /OPEN|O_RDONLY/, `an open that may not be read-only: ${o}`);
  const fsNames = src.match(/^import \{([^}]+)\} from 'node:fs';$/m)[1].split(',').map((s) => s.trim());
  assert.deepEqual(fsNames.sort(), ['closeSync', 'constants', 'fstatSync', 'lstatSync', 'openSync', 'readFileSync', 'readSync', 'realpathSync']);
});

test('the hook\'s fingerprint is the shipped script\'s, and hooks.json starts it in exec form', () => {
  const src = readFileSync(GATE, 'utf8');
  const named = src.match(/^const FINGERPRINT = '([0-9a-f]{64})';$/m);
  assert.ok(named, 'the hook names no fingerprint in the form the test expects');
  const actual = createHash('sha256').update(TEMPLATE.replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(named[1], actual, 'templates/lessons.mjs changed: update FINGERPRINT in hooks/lessons-gate.mjs');
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks/hooks.json'), 'utf8'));
  const entries = hooks.hooks.PreToolUse;
  assert.deepEqual(entries.map((e) => e.matcher), ['Edit|Write|MultiEdit|NotebookEdit', 'Bash', 'PowerShell']);
  for (const e of entries) {
    assert.equal(e.hooks.length, 1);
    const h = e.hooks[0];
    assert.deepEqual({type: h.type, command: h.command, args: h.args, if: h.if, onFailure: h.onFailure}, {type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/lessons-gate.mjs'], if: undefined, onFailure: undefined});
  }
  // The Codex copy ships the same file; tests/gate-codex.test.mjs checks its hooks.json.
  assert.ok(readFileSync(join(ROOT, 'plugins/lessons-learned-codex/hooks/lessons-gate.mjs')).equals(readFileSync(join(PLUGIN, 'hooks/lessons-gate.mjs'))), 'the two copies of the hook differ');
});

test('the hook holds no non-ASCII character and no unicode escape', () => {
  const src = readFileSync(GATE, 'utf8');
  assert.doesNotMatch(src, /[^\x00-\x7F]/);
  assert.doesNotMatch(src, /\\u[0-9a-fA-F{]/);
});

test('setup writes the line before it builds, and the setup e2e runs with this plugin\'s hook on', () => {
  for (const skill of ['plugins/lessons-learned/skills/setup/SKILL.md', 'plugins/lessons-learned-codex/skills/lessons-setup/SKILL.md']) {
    const text = readFileSync(join(ROOT, skill), 'utf8');
    const build = text.slice(text.indexOf('### 4. Build'), text.indexOf('### 5. Verify'));
    assert.match(build, /`Lessons checked: [^`]+`/, `${skill}: step 4 names the line to write`);
  }
  const runSetup = readFileSync(join(ROOT, 'dev/e2e/run-setup.ps1'), 'utf8');
  assert.doesNotMatch(runSetup, /disableAllHooks/, 'run-setup.ps1 turns every hook off, the gate included');
});

// Random text around the line: any text, then the line on a line of its own,
// passes; the same text with the line in quotes or backticks, or with no line,
// is denied. One transcript per case, so this costs a process each, and the
// cases are few.
test('property: the line on its own line passes after any text, and a quoted one never does', (ctx) => {
  const root = makeRepo({script: 'other'});
  const pieces = ['a', ' ', '\n', '.', '!', '?', '"', '`', '*', '>', '-', '_', '#', '(', ')', 'Lessons', ' checked', ':', String.fromCodePoint(0x2028), '\t', String.fromCodePoint(0xe9), String.fromCodePoint(0x1f600), 'L'];
  const {seed, byte} = seeded(ctx);
  for (let i = 0; i < 8; i++) {
    let text = '';
    const n = byte() % 40;
    for (let k = 0; k < n; k++) text += pieces[byte() % pieces.length];
    const clean = text.replace(/Lessons checked/g, 'Lessons_checked');
    assert.equal(edit(root, (t) => t.newMessage().text(`${clean}\nLessons checked: x\n${clean}`)).deny, false, `${JSON.stringify(clean)}, GATE_SEED=${seed}`);
    const flat = [...clean].map((c) => ('.!?\n'.includes(c) || c.codePointAt(0) === 0x2028 ? ' ' : c)).join('');
    for (const q of ['"', '`', "'"]) assert.equal(edit(root, (t) => t.newMessage().text(`${flat} ${q}Lessons checked: x${q}`)).deny, true, `${JSON.stringify(clean + q)}, GATE_SEED=${seed}`);
  }
});

// Timing tests compare growth, not seconds (dev/TESTING.md): each times the
// full input and a quarter of it, and fails when the full run takes more than
// 8 times as long. What is compared is the time past the fixed cost of the
// path it measures (Node's start, loading the hook, reading its payload,
// finding the repo, reading its script), which would otherwise hide the
// growth: `fixed` is the same call on the smallest input. A quarter that
// takes less than FLOOR ms past it counts as FLOOR. The best of three runs is
// taken for each. Each test names the slow version it fails on; PLAYBOOK
// "Writing a timing test" says how that was checked.
const best = (f) => Math.min(f(), f(), f());
const FLOOR = 20;
const growth = (small, full, fixed) => {
  const base = best(fixed);
  const a = best(small);
  const b = best(full);
  const ratio = Math.max(0, b - base) / Math.max(FLOOR, a - base);
  return {ratio, shown: `quarter ${Math.round(a)} ms, full ${Math.round(b)} ms, fixed cost ${Math.round(base)} ms, ratio past it ${ratio.toFixed(1)}`};
};

// Fails on round 2's reviewed gate, whose here-string regex ran from every
// unclosed @' to the end of the command.
test('time: a PowerShell command full of unclosed here-strings is read in linear time', (t2) => {
  const root = makeRepo();
  const run = (n) => () => command(root, `${"@'\n".repeat(n)}git commit -m x`, () => {}, {tool: 'PowerShell'}).ms;
  const g = growth(run(5_000), run(20_000), run(1));
  t2.diagnostic(g.shown);
  assert.ok(g.ratio < 8, g.shown);
});

// Fails on round 2's reviewed gate, whose cd chain kept a path growing past
// the length it looks at.
test('time: a long chain of cd is read in linear time', (t2) => {
  const root = makeRepo();
  const run = (n) => () => command(root, `${'cd a && '.repeat(n)}git commit -m x`, () => {}).ms;
  const g = growth(run(2_500), run(10_000), run(1));
  t2.diagnostic(g.shown);
  assert.ok(g.ratio < 8, g.shown);
});

// Fails on review round 3's reviewed gate, which took off one joined
// assignment ($a=$a=...) at a time, copying the rest of the word each time.
test('time: joined PowerShell assignments are read in linear time', (t2) => {
  const root = makeRepo();
  const run = (n) => () => command(root, `${'$a='.repeat(n)}git commit -m x`, () => {}, {tool: 'PowerShell'}).ms;
  const g = growth(run(20_000), run(80_000), run(1));
  t2.diagnostic(g.shown);
  assert.ok(g.ratio < 8, g.shown);
});

// Fails on the here-doc-shift mutant (round 3's scratch slow.mjs), which
// takes each closed here-doc off the front of the queue with shift.
test('time: many here-docs opened on one line are read in linear time', (t2) => {
  const root = makeRepo();
  const run = (n) => () => command(root, `git commit -m x; cat ${'<<a '.repeat(n)}\n${'a\n'.repeat(n)}`, () => {}).ms;
  const g = growth(run(40_000), run(160_000), run(1));
  t2.diagnostic(g.shown);
  assert.ok(g.ratio < 8, g.shown);
});

// Fails on Q83's first psKind (scratch q83/v1-gate.mjs), whose cache read
// the last expression of a word again from its start at each ` and newline
// when it had stopped at a ., a [ or a :, so a long member chain, quoted
// string, $( ) or variable name was read once for each escape after it. Each
// word here is such a head, then n escapes the word goes on through.
test('time: a PowerShell word with many escapes after an expression is read in linear time', (t2) => {
  const root = makeRepo();
  const esc = (n, piece) => `\`\n${piece}`.repeat(n);
  const words = {
    'a member chain': (n) => `$x${'.a'.repeat(n)}.${esc(n, 'a.')}`,
    'a chain after a ( )': (n) => `(1)${'.a'.repeat(n)}.${esc(n, 'a.')}`,
    'a chain before an open [': (n) => `$x${'.a'.repeat(n)}[${esc(n, 'a')}`,
    'an open index': (n) => `$x[${'a'.repeat(2 * n)}${esc(n, 'a')}`,
    'a double-quoted string': (n) => `"${'a'.repeat(2 * n)}".${esc(n, 'a.')}`,
    'a $( )': (n) => `$(${'a'.repeat(2 * n)}).${esc(n, 'a.')}`,
    'a variable name': (n) => `$${'a'.repeat(2 * n)}.${esc(n, 'a.')}`,
  };
  for (const [name, word] of Object.entries(words)) {
    const run = (n) => () => command(root, `echo ${word(n)}\ngit commit -m x`, () => {}, {tool: 'PowerShell'}).ms;
    const g = growth(run(2_000), run(8_000), run(1));
    t2.diagnostic(`${name}: ${g.shown}`);
    assert.ok(g.ratio < 8, `${name}: ${g.shown}`);
  }
});

// Fails on Q83 review round 1's reviewed gate (scratch q83/review1-state),
// whose psKind started its cache afresh at each $( ) in a word and read the
// word again from its start at each ), so a word holding many $( ) was read
// once for each.
test('time: a PowerShell word holding many $( ) is read in linear time', (t2) => {
  const root = makeRepo();
  const run = (n) => () => command(root, `echo $(echo $x[${'$(c`\n)`\n'.repeat(n)}])\ngit commit -m x`, () => {}, {tool: 'PowerShell'}).ms;
  const g = growth(run(3_000), run(12_000), run(1));
  t2.diagnostic(g.shown);
  assert.ok(g.ratio < 8, g.shown);
});

// Fails on Q83 review round 2's reviewed gate (scratch q83/review2-state),
// whose psHead found the end of a $( ) that starts a word by counting
// parentheses to the end of the command, so a quoted ( in it made each such
// word's head a scan to the end, once for each word.
test('time: PowerShell words that start with a $( ) holding a quoted ( are read in linear time', (t2) => {
  const root = makeRepo();
  const word = "$(echo '(').y`\n ";
  const shapes = {
    'at the top': (n) => `echo ${word.repeat(n)}\ngit commit -m x`,
    'in a $( )': (n) => `echo $(echo ${word.repeat(n)})\ngit commit -m x`,
  };
  for (const [name, cmd] of Object.entries(shapes)) {
    const run = (n) => () => command(root, cmd(n), () => {}, {tool: 'PowerShell'}).ms;
    const g = growth(run(2_000), run(8_000), run(1));
    t2.diagnostic(`${name}: ${g.shown}`);
    assert.ok(g.ratio < 8, `${name}: ${g.shown}`);
  }
});

// Fails on Q83 review round 1's reviewed gate, which looked for the end of a
// here-doc tag whose $( ) or ${ } isn't closed to the line's end, once for
// each <<, and on round 2's, which denied such a call as out of time past a
// budget instead of reading it. A } is looked for with indexOf, fast enough
// that it takes a longer line to show (scratch q83/verify/r2/growth5-old.txt).
// The last three fail on round 3's reviewed gate (scratch q83/review3-state,
// q83/verify/r3). Nested tags looked for a } again from each tag's ${, which
// was before the last search's start; one U+2013 keeps that text two bytes a
// character, where the search is slower. And a tag whose word failed at the
// line's end was read again, as far, from each << inside it: inside closed
// ${ }, or between $( and ${ pairs that end in an unclosed quote.
test('time: here-doc tags that never close are read in linear time', (t2) => {
  const root = makeRepo();
  const shapes = [
    ['<<$(', 2_000, (n) => `echo ${'<<$('.repeat(n)}`],
    ['<<${', 40_000, (n) => `echo ${'<<${'.repeat(n)}`],
    ['nested', 15_000, (n) => 'echo ' + '<<$('.repeat(n) + 'x' + ')${'.repeat(n) + 'a'.repeat(8 * n) + String.fromCharCode(0x2013)],
    ['in ${ }', 3_000, (n) => 'echo <<' + '${<<}'.repeat(n) + '${'],
    ['pairs', 10_000, (n) => 'echo ' + '<<$(<<${'.repeat(n) + "}'" + ')${'.repeat(n)],
  ];
  for (const [name, quarter, line] of shapes) {
    const cmd = (n) => `git push\n${line(n)}`;
    const run = (n) => () => command(root, cmd(n), () => {}).ms;
    const g = growth(run(quarter), run(4 * quarter), run(1));
    t2.diagnostic(`${name}: ${g.shown}`);
    assert.ok(g.ratio < 8, `${name}: ${g.shown}`);
    assert.equal(command(root, cmd(4 * quarter), () => {}).reason, REASON_LOOKUP, `${name}: denied for its push`);
  }
});

// Q83 review round 2: round 2's budget for such tags denied the call outside
// a gated repo, and every later call of the turn (scratch
// q83/review2-code/turn-late.mjs). Both fail on round 2's reviewed gate.
const neverClosed = `echo ${'<<$('.repeat(2_000)}`;
test('here-doc tags that never close deny nothing outside a gated repo', () => {
  const plain = makeRepo({check: false});
  assert.equal(command(plain, `git push\n${neverClosed}`, () => {}).deny, false);
});
test('here-doc tags that never close in an earlier call deny no later call', () => {
  const root = makeRepo();
  const after = edit(root, (t) => {
    ready(t);
    t.call('toolu_tags', 'Bash', {command: neverClosed, description: 'Run it'});
  });
  assert.equal(after.deny, false);
});

test('time: finding the line grows linearly with the text before a mention in backticks', (t2) => {
  const root = makeRepo({script: 'other'});
  // Fails on round 1's reviewed gate, whose line regex scanned the text
  // before each mention.
  for (const lead of ['\n', ' ']) {
    const run = (n) => () => edit(root, (t) => t.newMessage().text(`.${lead.repeat(n)}\`Lessons checked:\``)).ms;
    const g = growth(run(20_000), run(80_000), run(1));
    t2.diagnostic(`${JSON.stringify(lead)}: ${g.shown}`);
    assert.ok(g.ratio < 8, g.shown);
  }
  // Many mentions: fails on round 2's hasLine-quadratic mutant (scratch
  // mutants2.mjs), which scans the text before each mention again.
  const many = (n) => () => edit(root, (t) => t.newMessage().text('`Lessons checked:` '.repeat(n))).ms;
  const g = growth(many(2500), many(10_000), many(1));
  t2.diagnostic(`many mentions: ${g.shown}`);
  assert.ok(g.ratio < 8, g.shown);
});

// Every other call failed, so the records of calls that never ran are read
// too. Fails on the judge-quadratic mutant (round 2's scratch
// mutants-time.mjs), which works out the calls that never ran again for each
// call.
test('time: reading a commit-heavy turn grows linearly', (t2) => {
  const root = makeRepo();
  const run = (n) => () => {
    const t = new Transcript(root).prompt();
    t.newMessage().text(LINE).lookup();
    for (let i = 0; i < n; i++) {
      const failed = i % 2 === 1;
      t.newMessage().use(`toolu_g${i}`, 'Bash', {command: `git -C "${root}" status && cd "${root}" && git log -1 -- src/${i}`});
      t.result(`toolu_g${i}`, failed ? '<tool_use_error>Error: no such path</tool_use_error>' : 'o'.repeat(300), failed);
    }
    const input = {file_path: join(root, 'x.txt'), content: 'x'};
    const id = current(t, 'Write', input);
    const r = gate(payload(t, t.write(), 'Write', input, id, {cwd: root}));
    assert.equal(r.deny, false);
    return r.ms;
  };
  const g = growth(run(2_000), run(8_000), run(1));
  t2.diagnostic(g.shown);
  assert.ok(g.ratio < 8, g.shown);
});

// The budget, on a 31 MB transcript whose turn started 30 MB back (near the
// 32 MB window, so the slow version rereads the most), with tool
// calls and results like a real session's, each call a git command so that
// every one is parsed. Checked as growth against a quarter of that; the time
// past Node's own start is printed beside it (medians of 9 runs), and
// dev/release-state.md records it per release from runs on Windows and WSL.
// Fails on the readTurn-reread mutant (round 2's scratch mutants-time.mjs),
// which reads the whole rest of the turn again for each chunk. The fixed cost
// is a gated call on a transcript of one turn, so the repo and script checks
// every gated call makes don't hide the growth.
test('time: a gated call on a 31 MB transcript grows linearly from a quarter of it', (t2) => {
  const root = makeRepo();
  const plain = makeRepo({check: false});
  const build = (total, back) => {
    const t = new Transcript(root);
    const out = 'o'.repeat(1500);
    const fill = (bytes) => {
      const goal = t.lines.reduce((n, l) => n + l.length + 1, 0) + bytes;
      let size = goal - bytes;
      for (let i = 0; size < goal; i++) {
        const before = t.lines.length;
        t.newMessage().thinking('t'.repeat(800)).text('Working on it.').use(`toolu_f${i}`, 'Bash', {command: `git status --short -- src/${i}`}).result(`toolu_f${i}`, out).attachment(400);
        for (let k = before; k < t.lines.length; k++) size += t.lines[k].length + 1;
      }
    };
    t.prompt('the session start');
    fill(total - back);
    t.prompt();
    t.newMessage().text(LINE).lookup();
    fill(back);
    const input = {file_path: join(root, 'x.txt'), content: 'x'};
    const id = current(t, 'Write', input);
    return {t, path: t.write(), input, id};
  };
  const MB = 1024 * 1024;
  const full = build(31 * MB, 30 * MB);
  const quarter = build(7.75 * MB, 7.5 * MB);
  const run = (b) => () => {
    const r = gate(payload(b.t, b.path, 'Write', b.input, b.id, {cwd: root}));
    assert.equal(r.deny, false);
    return r.ms;
  };
  const tiny = (() => {
    const t = ready(new Transcript(root).prompt());
    const input = {file_path: join(root, 'x.txt'), content: 'x'};
    const id = current(t, 'Write', input);
    return {t, path: t.write(), input, id};
  })();
  const g = growth(run(quarter), run(full), run(tiny));
  const median = (f) => {
    const xs = Array.from({length: 9}, f).sort((a, b) => a - b);
    return xs[4];
  };
  const start = median(() => {
    const s = performance.now();
    spawnSync(process.execPath, ['-e', '0'], {input: '', encoding: 'utf8'});
    return performance.now() - s;
  });
  const gated = median(run(full));
  const ungated = median(() => gate(payload(full.t, full.path, 'Write', {file_path: join(plain, 'x.txt')}, full.id, {cwd: plain})).ms);
  t2.diagnostic(`${g.shown}; medians: Node's start ${Math.round(start)} ms, gated ${Math.round(gated)} ms (${Math.round(gated - start)} past it), ungated ${Math.round(ungated)} ms (${Math.round(ungated - start)} past it)`);
  assert.ok(g.ratio < 8, g.shown);
});
