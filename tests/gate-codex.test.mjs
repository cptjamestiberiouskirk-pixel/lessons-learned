// Tests for the lessons gate in Codex: plugins/lessons-learned-codex/hooks/
// lessons-gate.mjs (the same file as the Claude Code copy) and its hooks.json.
// Each test builds a repo and a rollout file in a temp folder and runs the
// hook as Codex does: the payload on stdin, a deny on stdout. The records are
// synthetic, in the shapes of Codex 0.171's rollouts and hook payloads (read
// from local rollouts and from Trailmark's log of payload shapes, and from
// Codex's source at rust-v0.171.0: dev/release-state.md, RS-H-codexhook).
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from './child.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugins/lessons-learned-codex');
const GATE = process.env.LESSONS_GATE_SCRIPT || join(PLUGIN, 'hooks/lessons-gate.mjs');
const TEMPLATE = readFileSync(join(PLUGIN, 'templates/lessons.mjs'), 'utf8');
const PLAYBOOK = readFileSync(join(PLUGIN, 'templates/PLAYBOOK.md'), 'utf8');
const OFF = ' To turn this check off: LESSONS_GATE=off (see the lessons-learned README).';
const REASON_LOOKUP = "Lessons check (PLAYBOOK.md, 'The lessons check'): run `node dev/lessons.mjs <2-4 topic words>` from the repo's top folder, then write a short `Lessons checked:` line on its own line in your reply's text just before the call (a line in thinking or a quoted mention doesn't count), then retry. A commit or push uses both up. If this deny comes back with no commit or push since both, check that the lookup ran from the repo's top folder and that the line reached your reply's text." + OFF;
const REASON_LINE = "Lessons check (PLAYBOOK.md, 'The lessons check'): write a short `Lessons checked:` line naming the lessons that apply, on its own line in your reply's text just before the call (a line in thinking or a quoted mention doesn't count), then retry. A commit or push uses the line up. If this deny comes back with no commit or push since your new line, that line didn't reach your reply's text: write it again." + OFF;
const REASON_LATE = "Lessons check (PLAYBOOK.md, 'The lessons check'): this turn holds more commands than the gate can read in time, so it denies the call rather than let it through unread. Retry it in the next turn." + OFF;
const LINE = 'Lessons checked: none apply';
const LOOKUP = 'node dev/lessons.mjs hook test';
const WIN = process.platform === 'win32';
const PWSH_EXE = 'C:\\Program Files\\WindowsApps\\OpenAI.CodexPrimaryRuntime_x64\\dependencies\\native\\powershell\\pwsh.exe';

const folders = [];
after(() => folders.forEach((f) => rmSync(f, {recursive: true, force: true})));
function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'lessons-gate-codex-'));
  folders.push(d);
  return realpathSync.native(d);
}

function makeRepo({check = true, script = 'match'} = {}) {
  const root = join(scratch(), 'repo');
  mkdirSync(join(root, '.git'), {recursive: true});
  writeFileSync(join(root, 'PLAYBOOK.md'), check ? PLAYBOOK : PLAYBOOK.replace('## The lessons check', '## Some other section'));
  if (script) {
    mkdirSync(join(root, 'dev'));
    writeFileSync(join(root, 'dev/lessons.mjs'), script === 'match' ? TEMPLATE : `${TEMPLATE}// changed\n`);
  }
  return root;
}

// A rollout in Codex 0.171's shape: session_meta first, then per turn a
// task_started event, the turn's context, the user's message, and the
// agent's messages, reasoning, exec calls and completed items.
class Rollout {
  constructor(cwd) {
    this.cwd = cwd;
    this.thread = randomUUID();
    this.lines = [];
    this.n = 0;
    this.turn = null;
    this.push('session_meta', {id: this.thread, session_id: this.thread, cwd, originator: 'Codex Desktop', cli_version: '0.171.0', source: 'vscode'});
  }
  push(type, payload) {
    this.lines.push(JSON.stringify({timestamp: new Date(Date.UTC(2026, 10, 22, 12, 0, 0, this.n)).toISOString(), ordinal: this.n++, type, payload}));
    return this;
  }
  event(payload) {
    return this.push('event_msg', payload);
  }
  item(item, turn = this.turn) {
    return this.event({type: 'item_completed', thread_id: this.thread, turn_id: turn, item, started_at_ms: 1795400000000 + this.n, completed_at_ms: 1795400000100 + this.n});
  }
  // A turn start: a person's prompt in the composer.
  prompt(text = 'Do the task.', {turn = randomUUID(), trigger = 'composer'} = {}) {
    this.turn = turn;
    this.event({type: 'task_started', turn_attribution: {turn_id: turn, turn_trigger: trigger, parent_turn_id: null, initiating_agent_path: null, root_turn_id: turn}, turn_id: turn, root_turn_id: turn, started_at: 1795400000, model_context_window: 258400, collaboration_mode_kind: 'default'});
    this.push('turn_context', {turn_id: turn, root_turn_id: turn, cwd: this.cwd, approval_policy: 'on-request', model: 'gpt-5.5'});
    this.push('response_item', {type: 'message', role: 'user', content: [{type: 'input_text', text}]});
    return this.item({type: 'UserMessage', id: randomUUID(), content: [{type: 'text', text, text_elements: []}]});
  }
  // A visible message, written as Codex does: the item, then the response item.
  say(text, {phase = 'commentary', only, turn} = {}) {
    const id = `msg_${randomUUID().replace(/-/g, '')}`;
    if (only !== 'response') this.item({type: 'AgentMessage', id, content: [{type: 'Text', text}]}, turn);
    if (only !== 'item') this.push('response_item', {type: 'message', status: 'completed', id, role: 'assistant', content: [{type: 'output_text', text}], phase});
    return this;
  }
  reason(text) {
    const id = `rs_${randomUUID().replace(/-/g, '')}`;
    this.item({type: 'Reasoning', id, summary_text: [text], raw_content: []});
    return this.push('response_item', {type: 'reasoning', id, summary: [{type: 'summary_text', text}], encrypted_content: 'gAAAA'});
  }
  // A command that ran: the exec call whose JavaScript ran it, the completed
  // CommandExecution item, and the call's output. With only: 'item', the item
  // alone, for a timing test that needs many commands in the read window.
  ran(script, {cwd = this.cwd, argv, status = 'completed', exitCode = 0, output = 'ok', turn, only} = {}) {
    const call = `call_${randomUUID().replace(/-/g, '')}`;
    if (only !== 'item') this.push('response_item', {type: 'custom_tool_call', status: 'completed', call_id: call, name: 'exec', input: `text(await tools.exec_command({cmd:${JSON.stringify(script)}}))`});
    const command = argv ?? (WIN ? [PWSH_EXE, '-NoProfile', '-Command', script] : ['/bin/bash', '-lc', script]);
    this.item({type: 'CommandExecution', id: `exec-${randomUUID()}`, process_id: '4242', command, cwd: typeof cwd === 'string' && cwd.startsWith('file:') ? cwd : pathToFileURL(cwd).href, parsed_cmd: [{type: 'unknown', cmd: script}], source: 'unified_exec_startup', status, aggregated_output: output, exit_code: exitCode, duration: {secs: 0, nanos: 5000000}}, turn);
    if (only === 'item') return this;
    return this.push('response_item', {type: 'custom_tool_call_output', call_id: call, output: [{type: 'input_text', text: output}]});
  }
  lookup() {
    return this.ran(LOOKUP, {output: '-- 0 shown; 0 lessons'});
  }
  // The exec call of the current command: on disk before the hook runs.
  calling(js) {
    return this.push('response_item', {type: 'custom_tool_call', status: 'in_progress', call_id: `call_${randomUUID().replace(/-/g, '')}`, name: 'exec', input: js});
  }
  write(path = join(scratch(), 'rollout.jsonl')) {
    writeFileSync(path, `${this.lines.join('\n')}\n`);
    return path;
  }
}

function gate(payload, {env = {}, cwd} = {}) {
  const e = {...process.env, ...env};
  if (!('LESSONS_GATE' in env)) delete e.LESSONS_GATE;
  const started = performance.now();
  const r = spawnSync(process.execPath, [GATE], {input: JSON.stringify(payload), encoding: 'utf8', env: e, ...(cwd ? {cwd} : {})});
  const ms = performance.now() - started;
  const out = r.stdout.trim();
  const reason = out ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason : null;
  return {status: r.status, out, reason, deny: reason !== null, ms, stderr: r.stderr};
}
// A PreToolUse payload as Codex 0.171 builds it.
function payload(r, path, tool, command, extra = {}) {
  return {session_id: r.thread, turn_id: r.turn, transcript_path: path, cwd: r.cwd, hook_event_name: 'PreToolUse', model: 'gpt-5.5', permission_mode: 'default', tool_name: tool, tool_input: {command}, tool_use_id: `exec-${randomUUID()}`, ...extra};
}
const patchOf = (...files) => `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n-old\n+new\n`).join('')}*** End Patch`;
// An apply_patch call after the records `build` adds to a fresh turn.
function patch(root, build, {text, cwd = root, extra = {}, env, spawnCwd} = {}) {
  const r = new Rollout(cwd).prompt();
  build(r);
  const p = text ?? patchOf(join(root, 'src.txt'));
  r.calling(`text(await tools.apply_patch(${JSON.stringify(p)}))`);
  return gate(payload(r, r.write(), 'apply_patch', p, extra), {env, cwd: spawnCwd});
}
// A Bash call (any shell command) after the records `build` adds.
function command(cwd, cmd, build, {extra = {}, env} = {}) {
  const r = new Rollout(cwd).prompt();
  build(r);
  r.calling(`text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}))`);
  return gate(payload(r, r.write(), 'Bash', cmd, extra), {env});
}
const ready = (r) => r.say(LINE).lookup();

test('codex: an apply_patch edit is denied without the line and a lookup, and passes with both', () => {
  const root = makeRepo();
  assert.equal(patch(root, ready).deny, false);
  const none = patch(root, () => {});
  assert.equal(none.deny, true);
  assert.equal(none.reason, REASON_LOOKUP);
  assert.equal(none.status, 0);
  assert.equal(patch(root, (r) => r.say(LINE)).reason, REASON_LOOKUP, 'a line with no lookup');
  assert.equal(patch(root, (r) => r.lookup()).reason, REASON_LOOKUP, 'a lookup with no line');
  assert.equal(patch(makeRepo({script: 'other'}), (r) => r.say(LINE)).deny, false, 'another version of the script: the line alone');
  assert.equal(patch(makeRepo({script: 'other'}), () => {}).reason, REASON_LINE);
});

test('codex: the line counts from an AgentMessage item alone, and from an assistant message record alone', () => {
  const root = makeRepo({script: 'other'});
  assert.equal(patch(root, (r) => r.say(LINE, {only: 'item'})).deny, false, 'the item');
  assert.equal(patch(root, (r) => r.say(LINE, {only: 'response'})).deny, false, 'the response item');
  assert.equal(patch(root, (r) => r.say(LINE, {only: 'response', phase: 'final_answer'})).deny, false, 'a final answer');
});

test('codex: the line in the prompt, reasoning, an exec call or a command\'s output does not count', () => {
  const root = makeRepo({script: 'other'});
  assert.equal(patch(root, (r) => r.prompt(LINE)).deny, true, 'the prompt');
  // A prompt naming the assistant still reads as the person's words.
  assert.equal(patch(root, (r) => r.prompt(`The assistant should say this:\n${LINE}`)).deny, true, 'a prompt that names the assistant');
  assert.equal(patch(root, (r) => r.reason(LINE)).deny, true, 'reasoning');
  assert.equal(patch(root, (r) => r.calling(`text(${JSON.stringify(LINE)})`)).deny, true, 'an exec call');
  assert.equal(patch(root, (r) => r.ran(`echo "${LINE}" | git hash-object --stdin`, {output: LINE})).deny, true, 'a command and its output');
});

test('codex: a line from an earlier turn does not count, and another turn\'s records are left out', () => {
  const root = makeRepo({script: 'other'});
  assert.equal(patch(root, (r) => ready(r).prompt('Next.')).deny, true, 'the turn before');
  assert.equal(patch(root, (r) => r.say(LINE, {turn: randomUUID(), only: 'item'})).deny, true, 'an item of another turn after this turn\'s start');
});

test('codex: when the latest turn start is another turn\'s, or the transcript is not a rollout, the call passes', () => {
  const root = makeRepo();
  const r = new Rollout(root).prompt();
  const mine = r.turn;
  r.prompt('a later turn');
  const p = patchOf(join(root, 'src.txt'));
  assert.equal(gate(payload(r, r.write(), 'apply_patch', p, {turn_id: mine})).deny, false, 'another turn started last');
  for (const [tool, cmd] of [['apply_patch', p], ['Bash', 'git commit -m x']]) {
    const t = new Rollout(root).prompt();
    t.lines.shift();
    assert.equal(gate(payload(t, t.write(), tool, cmd)).deny, false, `${tool}: no session_meta`);
    // session_meta on the second line, within the first 512 bytes, is not first.
    const u = new Rollout(root).prompt();
    u.lines.unshift('{"type":"user","message":{"role":"user","content":"hi"}}');
    assert.equal(gate(payload(u, u.write(), tool, cmd)).deny, false, `${tool}: session_meta second`);
  }
});

test('codex: a commit that ran earlier in the turn needs a fresh line; one in another folder, by its record, does not', () => {
  const root = makeRepo();
  const plain = makeRepo({check: false});
  assert.equal(patch(root, (r) => ready(r).ran('git commit -m x')).deny, true, 'a commit after the line');
  assert.equal(patch(root, (r) => ready(r).ran('git commit -m x').say(LINE).lookup()).deny, false, 'a fresh line and lookup after it');
  assert.equal(patch(root, (r) => ready(r).ran('git commit -m x', {cwd: plain})).deny, false, 'a commit in a repo without the check, by its file URL');
  assert.equal(patch(root, (r) => ready(r).ran('git commit -m x', {cwd: `file:///${plain.replace(/\\/g, '/').replace(/^\//, '')}`.replace(/ /g, '%20')})).deny, false, 'a file URL written by hand');
  assert.equal(patch(root, (r) => ready(r).ran('git push', {cwd: 'file://server/share/repo'})).deny, true, 'a URL with a host: the payload\'s folder');
  assert.equal(patch(root, (r) => ready(r).ran('git commit -m x', {status: 'failed', exitCode: 1})).deny, true, 'a commit that failed still ran');
  assert.equal(patch(root, (r) => ready(r).ran('git commit -m x', {status: 'declined'})).deny, false, 'a command that never ran');
  assert.equal(patch(root, (r) => ready(r).ran('git commit --dry-run -m x')).deny, false, 'a dry run');
});

test('codex: a command that ran is read from its argv', () => {
  const root = makeRepo({script: 'other'});
  const cases = [
    [[PWSH_EXE, '-NoProfile', '-Command', '$out = git commit -m x'], true],
    [['powershell.exe', '-Command', 'git', 'push'], true],
    [['/bin/bash', '-lc', 'git commit -m "x y" && echo done'], true],
    [['/usr/bin/zsh', '-c', 'git push origin main'], true],
    [['C:\\Windows\\System32\\cmd.exe', '/c', 'git commit -m x'], true],
    [['git', 'commit', '-m', "it's done; really"], true],
    [['git', 'status'], false],
    [['/bin/bash', '-lc', "echo 'git commit'"], false],
    // One word holding quotes and a separator stays one word.
    [['echo', "a' ; git commit -m 'b"], false],
    // A double-quoted string inside $( ) inside double quotes nests, so the
    // commit on the next line is read (tests/gate.test.mjs has more cases).
    [['/bin/bash', '-lc', 'x="$(echo "$(echo "b\'b")\'b")"\ngit commit -m x'], true],
    [[PWSH_EXE, '-NoProfile', '-Command', "$m = \"$('b' + \"$(\"b'b\")'b\")\"\ngit commit -m x"], true],
    // A # inside ${ } is no comment. The gate's reading of $( ) takes it for
    // one, and the legacy reading, which it also runs, finds the commit
    // (tests/gate.test.mjs, "one reading of $( ) misses").
    [['/bin/bash', '-lc', 'x="$(echo ${y:- #})\n"\ngit commit -m x\n# "'], true],
    // An escape before CR LF: bash on Linux and pwsh inside a word end the
    // command at the LF (tests/gate.test.mjs, "an escape before CR LF").
    [['/bin/bash', '-lc', 'echo a\\\r\ngit commit -m x'], true],
    [[PWSH_EXE, '-NoProfile', '-Command', 'echo a`\r\ngit commit -m x'], true],
    // A CR: Git Bash and cmd drop it, and pwsh reads one with no LF after it
    // as a newline (tests/gate.test.mjs, "a CR is read"). The first and last
    // hold no "git" but for the CR.
    [['/bin/bash', '-lc', 'g\rit commit -m x'], true],
    [[PWSH_EXE, '-NoProfile', '-Command', 'echo a\rgit commit -m x'], true],
    [['C:\\Windows\\System32\\cmd.exe', '/c', 'gi\rt commit -m x'], true],
  ];
  for (const [argv, resets] of cases) assert.equal(patch(root, (r) => r.say(LINE).ran(argv.at(-1), {argv})).deny, resets, JSON.stringify(argv));
});

test('codex: a lookup that ran earlier counts, and one in the current command before its commit counts', () => {
  const root = makeRepo();
  assert.equal(command(root, 'git commit -m x', ready).deny, false);
  assert.equal(command(root, 'git commit -m x', (r) => r.say(LINE)).reason, REASON_LOOKUP);
  assert.equal(command(root, `${LOOKUP}; git commit -m x`, (r) => r.say(LINE)).deny, false, 'a lookup before the commit');
  assert.equal(command(root, `git commit -m x; ${LOOKUP}`, (r) => r.say(LINE)).deny, true, 'a lookup after it');
  assert.equal(command(root, 'git status', () => {}).deny, false, 'not a commit or push');
  assert.equal(command(makeRepo({check: false}), 'git push', () => {}).deny, false, 'a repo without the check');
});

// Q83: the hook read a call only when its text held "git" (tests/gate.test.mjs,
// "git spelled with quotes"): the payload's command, and a command that ran.
test('codex: git spelled with quotes or capitals is read', () => {
  const root = makeRepo();
  assert.equal(command(root, "g'i't push", () => {}).deny, true, 'quotes in the payload');
  assert.equal(command(root, 'GIT push', () => {}).deny, true, 'capitals in the payload');
  assert.equal(patch(root, (r) => ready(r).ran("g'i't commit -m x", {argv: ['/bin/bash', '-lc', "g'i't commit -m x"]})).deny, true, 'quotes in one that ran');
  assert.equal(patch(root, (r) => ready(r).ran('GIT commit -m x', {argv: ['GIT', 'commit', '-m', 'x']})).deny, true, 'capitals in one that ran');
  // The rollout writes the line feed as JSON's \n, so the text holds git
  // only once that is dropped. (A Claude Code record always holds git, in
  // its gitBranch field.)
  assert.equal(patch(root, (r) => ready(r).ran('gi\\\nt commit -m x', {argv: ['/bin/bash', '-lc', 'gi\\\nt commit -m x']})).deny, true, 'a line join in one that ran');
  // JSON's escapes are read from the left, so in g\r\\it the \\ is one escape
  // and the i a letter: Git's sh.exe drops the CR and runs git push. And a \
  // before a line join (Q83 review round 1, scratch q83/review1-code/codex-probe.mjs).
  assert.equal(patch(root, (r) => ready(r).ran("sh -c 'g\r\\it push'", {argv: [PWSH_EXE, '-NoProfile', '-Command', "sh -c 'g\r\\it push'"]})).deny, true, 'a CR and an escape in one that ran');
  assert.equal(patch(root, (r) => ready(r).ran('g\\i\\\nt push', {argv: ['/bin/bash', '-lc', 'g\\i\\\nt push']})).deny, true, 'an escape and a line join in one that ran');
});

test('codex: the payload\'s command is read as PowerShell on Windows and as sh elsewhere', () => {
  const root = makeRepo({script: 'other'});
  // PowerShell skips an assignment before git; sh reads `$out` as the program.
  assert.equal(command(root, '$out = git commit -m x', () => {}).deny, WIN, 'a PowerShell assignment');
  // sh runs a backtick substitution; PowerShell reads a backtick as an escape.
  assert.equal(command(root, 'echo `git commit -m x`', () => {}).deny, !WIN, 'a backtick substitution');
  // In either shell, a double-quoted string inside $( ) inside double quotes
  // nests, so the push on the next line is read.
  const nested = WIN ? "$m = \"$('b' + \"$(\"b'b\")'b\")\"\ngit push" : 'x="$(echo "$(echo "b\'b")\'b")"\ngit push';
  assert.equal(command(root, nested, () => {}).deny, true, 'a nested double-quoted $( )');
  // And an escape before CR LF inside a word ends the command at the LF.
  assert.equal(command(root, WIN ? 'echo a`\r\ngit push' : 'echo a\\\r\ngit push', () => {}).deny, true, 'an escape before CR LF');
  // And a CR as each shell reads it.
  assert.equal(command(root, WIN ? 'echo a\rgit push' : 'g\rit push', () => {}).deny, true, 'a CR');
});

test('codex: the payload\'s folder is where the command runs', () => {
  const root = makeRepo({script: 'other'});
  const plain = makeRepo({check: false});
  const r = new Rollout(plain).prompt();
  r.calling('x');
  assert.equal(gate(payload(r, r.write(), 'Bash', 'git commit -m x', {cwd: root})).deny, true, 'a workdir in the gated repo');
  assert.equal(gate(payload(r, r.write(), 'Bash', 'git commit -m x', {cwd: plain})).deny, false);
});

test('codex: each file a patch adds, updates, deletes or moves to is looked at', () => {
  const root = makeRepo({script: 'other'});
  const plain = makeRepo({check: false});
  const P = (body) => `*** Begin Patch\n${body}\n*** End Patch`;
  const cases = [
    [P(`*** Add File: ${join(root, 'new.txt')}\n+x`), true, 'add'],
    [P(`*** Delete File: ${join(root, 'src.txt')}`), true, 'delete'],
    [P(`*** Update File: ${join(plain, 'a.txt')}\n*** Move to: ${join(root, 'a.txt')}\n@@\n-a\n+b`), true, 'a move into the gated repo'],
    [P(`*** Update File: ${join(plain, 'a.txt')}\n@@\n-a\n+b\n*** Add File: ${join(root, 'b.txt')}\n+b`), true, 'the second file of two'],
    [P(`*** Update File: ${join(plain, 'a.txt')}\n@@\n-a\n+b`), false, 'only a file in a repo without the check'],
    [P(`*** Update File: ${join(root, 'LESSONS.md')}\n@@\n-a\n+b`), false, 'LESSONS.md'],
    [P(`*** Update File: ${join(root, '.git', 'config')}\n@@\n-a\n+b`), false, '.git'],
    [P(`*** Update File: ${join(root, 'PLAYBOOK.md')}\n@@\n-a\n+b`), true, 'PLAYBOOK.md'],
    [P(`*** Update File: ${join(root, `a${String.fromCharCode(0x2028)}b.txt`)}\n@@\n-a\n+b`), true, 'a name holding U+2028'],
    [P(`*** Update File: ${join(root, 'src.txt')}\n@@\n-a\n+b`).replace(/\n/g, '\r\n'), true, 'CRLF lines'],
    [P(`*** Update File: ${join(root, 'LESSONS.md')}\n@@\n-a\n+b`).replace(/\n/g, '\r\n'), false, 'LESSONS.md in CRLF lines'],
    [P(`+*** Update File: ${join(root, 'src.txt')}`), false, 'a header inside a hunk body'],
    // Codex trims a line before it looks for a header.
    [P(`  *** Update File: ${join(root, 'src.txt')}\n@@\n-a\n+b`), true, 'a header after spaces'],
    [P(`\t*** Add File: ${join(root, 'new.txt')}\n+x`), true, 'a header after a tab'],
    ['not a patch', false, 'no file named'],
  ];
  for (const [text, denied, name] of cases) assert.equal(patch(root, () => {}, {text}).deny, denied, name);
});

test('codex: a relative path in a patch is read from the payload\'s folder', () => {
  const root = makeRepo({script: 'other'});
  const plain = makeRepo({check: false});
  const text = patchOf('src.txt');
  // The hook runs in the gated repo, so a path read from its own folder would be gated.
  assert.equal(patch(root, () => {}, {text, cwd: plain, spawnCwd: root}).deny, false, 'from a folder without the check');
  assert.equal(patch(root, () => {}, {text, cwd: root, spawnCwd: plain}).deny, true, 'from the gated repo');
});

test('codex: a patch naming more than 512 files passes without a look', () => {
  const root = makeRepo({script: 'other'});
  const names = Array.from({length: 513}, (_, i) => join(root, `f${i}.txt`));
  assert.equal(patch(root, () => {}, {text: patchOf(...names)}).deny, false, '513 files');
  assert.equal(patch(root, () => {}, {text: patchOf(...names.slice(0, 512))}).deny, true, '512 files');
});

// Each name in a path costs a look on disk, so a patch of deep paths gets one
// budget of 16,384 names in all. Fails on a gate without it, which looks at
// 512 paths of 500 names each, about 30 s on Windows, past Codex's 10 s.
test('codex: a patch whose paths hold more than 16,384 names in all passes without a look', () => {
  const root = makeRepo({script: 'other'});
  const depth = (n) => Array.from({length: n}, () => 'd');
  const parts = (f) => f.split(/[\\/]/).length;
  const deep = (i) => join(root, ...depth(400), `f${i}.txt`);
  const per = parts(deep(0));
  const over = Math.floor(16_384 / per) + 1;
  const names = Array.from({length: over}, (_, i) => deep(i));
  assert.ok(names.reduce((a, f) => a + parts(f), 0) > 16_384);
  assert.ok(names.slice(0, -1).reduce((a, f) => a + parts(f), 0) <= 16_384);
  assert.equal(patch(root, () => {}, {text: patchOf(...names)}).deny, false, `${over} paths of ${per} names`);
  assert.equal(patch(root, () => {}, {text: patchOf(...names.slice(0, -1))}).deny, true, `${over - 1} paths of ${per} names`);
});

test('codex: a subagent, LESSONS_GATE=off, another event and another tool pass', () => {
  const root = makeRepo();
  assert.equal(patch(root, () => {}, {extra: {agent_id: 'agent-1', agent_type: 'worker'}}).deny, false, 'a subagent');
  assert.equal(patch(root, () => {}, {env: {LESSONS_GATE: 'off'}}).deny, false, 'LESSONS_GATE=off');
  assert.equal(patch(root, () => {}, {extra: {hook_event_name: 'PostToolUse'}}).deny, false, 'PostToolUse');
  const r = new Rollout(root).prompt();
  assert.equal(gate(payload(r, r.write(), 'PowerShell', 'git commit -m x')).deny, false, 'a tool Codex doesn\'t name');
  assert.equal(gate(payload(r, r.write(), 'mcp__fs__write_file', 'git commit -m x')).deny, false, 'an MCP tool');
  assert.equal(gate(payload(r, r.write(), 'apply_patch', patchOf(join(root, 'x')), {transcript_path: null})).deny, false, 'no transcript');
});

// Codex runs a hook's command through the session's shell: `<pwsh> -NoProfile
// -Command <command>`, `<cmd> /c "<command>"` or `<sh> -c <command>`
// (core/src/shell.rs, derive_exec_args). With no session shell it falls back
// to `%COMSPEC% /C "<command>"` on Windows and `$SHELL -lc <command>`
// elsewhere (hooks/src/engine/command_runner.rs), all at rust-v0.171.0, with
// PLUGIN_ROOT set to the plugin's folder. Each shell here is one Codex may
// use; pwsh is tried where it is installed.
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], {encoding: 'utf8'}).status === 0;
const LAUNCHERS = [
  ...(WIN
    ? [['cmd', (c) => [process.env.COMSPEC || 'cmd.exe', ['/c', `"${c}"`], {windowsVerbatimArguments: true}]]]
    : [['$SHELL -lc', (c) => [process.env.SHELL || '/bin/sh', ['-lc', c], {}]], ['/bin/sh -c', (c) => ['/bin/sh', ['-c', c], {}]]]),
  ...(hasPwsh ? [['pwsh', (c) => ['pwsh', ['-NoProfile', '-Command', c], {}]]] : []),
];
// The opt-out that stops cmd looking in the current folder is taken off, so
// a run shows what the command itself does.
function launch(how, command, env, input, cwd) {
  const e = {...process.env, ...env};
  delete e.LESSONS_GATE;
  if (!('PLUGIN_ROOT' in env)) delete e.PLUGIN_ROOT;
  for (const k of Object.keys(e)) if (k.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete e[k];
  const [exe, args, extra] = how(command);
  return spawnSync(exe, args, {input, encoding: 'utf8', env: e, ...(cwd ? {cwd} : {}), ...extra});
}
// Codex reads a hook's whole stdout as one JSON answer, so nothing else may be on it.
const onlyJson = (run, what) => {
  assert.equal(run.status, 0, `${what}: ${run.stderr}`);
  assert.equal(run.stdout.trim().split(/\r?\n/).length, 1, `${what}: one line on stdout, got ${JSON.stringify(run.stdout)}`);
  return JSON.parse(run.stdout.trim()).hookSpecificOutput.permissionDecisionReason;
};

// The gate stops at its own deadline and denies, as Codex, like Claude Code,
// runs a call once the hook's timeout ends it (0.172.0, in a live run; see
// tests/gate.test.mjs for Claude Code). At 1 ms the
// deadline has passed before the gate reads its first command.
test('codex: a gate out of time denies the call', () => {
  const root = makeRepo();
  const late = {LESSONS_GATE_DEADLINE_MS: '1'};
  assert.equal(command(root, 'git push', ready).deny, false, 'a push in time');
  assert.equal(command(root, 'git push', ready, {env: late}).reason, REASON_LATE, 'a push out of time');
  assert.equal(patch(root, ready).deny, false, 'an edit in time');
  assert.equal(patch(root, ready, {env: late}).reason, REASON_LATE, 'an edit out of time');
  assert.equal(command(root, 'ls -la', () => {}, {env: late}).deny, false, 'no git: not read');
});

test('codex: hooks.json matches Bash and apply_patch, and its command runs the hook from PLUGIN_ROOT in each shell Codex may use', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks/hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks), ['PreToolUse', 'PostToolUse']);
  const [entry] = hooks.hooks.PreToolUse;
  assert.equal(hooks.hooks.PreToolUse.length, 1);
  const re = new RegExp(entry.matcher);
  for (const name of ['Bash', 'apply_patch']) assert.ok(re.test(name), name);
  for (const name of ['Edit', 'Write', 'mcp__fs__write', 'BashX', 'xapply_patch']) assert.ok(!re.test(name), name);
  assert.equal(entry.hooks.length, 1);
  const h = entry.hooks[0];
  assert.equal(h.type, 'command');
  assert.equal(h.timeout, 10);
  assert.doesNotMatch(h.command, /[$%`]/, 'nothing cmd or sh would expand');
  const root = makeRepo();
  const r = new Rollout(root).prompt();
  const p = patchOf(join(root, 'src.txt'));
  const input = JSON.stringify(payload(r, r.write(), 'apply_patch', p));
  // Codex runs the hook in the session's folder, where cmd looks for `node`
  // first. The command's first step turns that off, so a node.cmd planted in
  // the repo doesn't run; pwsh and sh don't look there.
  const planted = join(scratch(), 'planted');
  mkdirSync(planted);
  writeFileSync(join(planted, 'node.cmd'), '@echo PLANTED node.cmd ran\r\n');
  writeFileSync(join(planted, 'node.bat'), '@echo PLANTED node.bat ran\r\n');
  writeFileSync(join(planted, 'node.ps1'), "Write-Output 'PLANTED node.ps1 ran'\n");
  writeFileSync(join(planted, 'node'), '#!/bin/sh\necho PLANTED node ran\n', {mode: 0o755});
  for (const [name, how] of LAUNCHERS) {
    assert.equal(onlyJson(launch(how, h.command, {PLUGIN_ROOT: PLUGIN}, input), name), REASON_LOOKUP, name);
    const run = launch(how, h.command, {PLUGIN_ROOT: PLUGIN}, input, planted);
    assert.doesNotMatch(run.stdout, /PLANTED/, `${name}: a planted node ran`);
    assert.equal(onlyJson(run, `${name}, planted`), REASON_LOOKUP, `${name}, planted`);
    for (const env of [{}, {PLUGIN_ROOT: 'plugins/lessons-learned-codex'}, {PLUGIN_ROOT: '\\\\server\\share\\plugin'}]) {
      const quiet = launch(how, h.command, env, input);
      assert.equal(quiet.status, 0, `${name} ${JSON.stringify(env)}: ${quiet.stderr}`);
      assert.equal(quiet.stdout.trim(), '', `${name} ${JSON.stringify(env)}`);
    }
  }
});

// The lint hook (hooks/lessons-lint.mjs) is started by the same command as
// the gate, with only the file name changed, so it gets the same checks: each
// shell Codex may use, a planted node, and a PLUGIN_ROOT that isn't a full
// local path.
test('codex: hooks.json starts the lint hook after apply_patch, from PLUGIN_ROOT, in each shell Codex may use', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks/hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.PostToolUse.length, 1);
  const [entry] = hooks.hooks.PostToolUse;
  const re = new RegExp(entry.matcher);
  assert.ok(re.test('apply_patch'));
  for (const name of ['Bash', 'Edit', 'Write', 'xapply_patch', 'apply_patchx']) assert.ok(!re.test(name), name);
  assert.equal(entry.hooks.length, 1);
  const h = entry.hooks[0];
  assert.equal(h.type, 'command');
  assert.equal(h.timeout, 10);
  const gate = hooks.hooks.PreToolUse[0].hooks[0].command;
  assert.equal(h.command, gate.replace("'lessons-gate.mjs'", "'lessons-lint.mjs'"), 'the same command as the gate\'s, but the file');
  assert.notEqual(h.command, gate);
  const root = makeRepo();
  writeFileSync(join(root, 'LESSONS.md'), '# LESSONS\n\n## 2026-01-03: A lesson with no rule\n\n- What went wrong: it broke.\n- Why: a cause.\n- Evidence: a run.\n- Status: open\n');
  const input = JSON.stringify({session_id: 's', turn_id: 't1', transcript_path: join(root, 'rollout.jsonl'), cwd: root, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: {command: patchOf('LESSONS.md')}, tool_response: 'ok', tool_use_id: 'call_1'});
  const context = (run, what) => {
    assert.equal(run.status, 0, `${what}: ${run.stderr}`);
    assert.equal(run.stdout.trim().split(/\r?\n/).length, 1, `${what}: one line on stdout, got ${JSON.stringify(run.stdout)}`);
    const out = JSON.parse(run.stdout.trim()).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PostToolUse', what);
    return out.additionalContext;
  };
  const planted = join(scratch(), 'planted');
  mkdirSync(planted);
  writeFileSync(join(planted, 'node.cmd'), '@echo PLANTED node.cmd ran\r\n');
  writeFileSync(join(planted, 'node.bat'), '@echo PLANTED node.bat ran\r\n');
  writeFileSync(join(planted, 'node.ps1'), "Write-Output 'PLANTED node.ps1 ran'\n");
  writeFileSync(join(planted, 'node'), '#!/bin/sh\necho PLANTED node ran\n', {mode: 0o755});
  for (const [name, how] of LAUNCHERS) {
    assert.match(context(launch(how, h.command, {PLUGIN_ROOT: PLUGIN}, input), name), /^ERROR format LESSONS\.md:3 /m, name);
    const run = launch(how, h.command, {PLUGIN_ROOT: PLUGIN}, input, planted);
    assert.doesNotMatch(run.stdout, /PLANTED/, `${name}: a planted node ran`);
    assert.match(context(run, `${name}, planted`), /^ERROR format LESSONS\.md:3 /m, `${name}, planted`);
    for (const env of [{}, {PLUGIN_ROOT: 'plugins/lessons-learned-codex'}, {PLUGIN_ROOT: '\\\\server\\share\\plugin'}]) {
      const quiet = launch(how, h.command, env, input);
      assert.equal(quiet.status, 0, `${name} ${JSON.stringify(env)}: ${quiet.stderr}`);
      assert.equal(quiet.stdout.trim(), '', `${name} ${JSON.stringify(env)}`);
    }
  }
});

// Timing tests compare growth, not seconds (PLAYBOOK "Writing a timing
// test"): the full input against a quarter of it, past the fixed cost of the
// same call on the smallest input, best of three each; fail past 8 times.
const best = (f) => Math.min(f(), f(), f());
const FLOOR = 20;
const growth = (small, full, fixed) => {
  const base = best(fixed);
  const a = best(small);
  const b = best(full);
  const ratio = Math.max(0, b - base) / Math.max(FLOOR, a - base);
  return {ratio, shown: `quarter ${Math.round(a)} ms, full ${Math.round(b)} ms, fixed cost ${Math.round(base)} ms, ratio past it ${ratio.toFixed(1)}`};
};

// Every command in the turn is a git command in the gated repo, so each one
// is read. Fails on the codex-judge-quadratic mutant (dev/release-state.md),
// which walks every earlier command of the turn again for each command.
test('time: a Codex turn of many commands is read in linear time', (t2) => {
  const root = makeRepo();
  const run = (n) => {
    const r = new Rollout(root).prompt();
    ready(r);
    // Each one runs in the payload's folder, the gated repo.
    for (let i = 0; i < n; i++) r.ran(`git status --short -- src/${i}`, {output: 'o', only: 'item'});
    const p = patchOf(join(root, 'x.txt'));
    r.calling('x');
    const path = r.write();
    sizes.push(statSync(path).size);
    return () => {
      const g = gate(payload(r, path, 'apply_patch', p));
      assert.equal(g.deny, false);
      return g.ms;
    };
  };
  const sizes = [];
  const g = growth(run(400), run(1_600), run(1));
  // The full size must stay inside the 32 MB the hook reads back.
  t2.diagnostic(`${g.shown}; rollout bytes ${sizes.join(', ')}`);
  assert.ok(sizes[1] < 32 * 1024 * 1024, `${sizes[1]} bytes`);
  assert.ok(g.ratio < 8, g.shown);
});

// Many messages that mention the words without being the line, so each one
// is parsed and kept. Fails on the codex-unshift mutant (dev/release-state.md),
// which puts each record at the front of the list as it is read.
test('time: a Codex turn of many messages is read in linear time', (t2) => {
  const root = makeRepo({script: 'other'});
  const run = (n) => {
    const r = new Rollout(root).prompt();
    r.say(LINE);
    for (let i = 0; i < n; i++) r.say(`See \`Lessons checked:\` ${i}`, {only: 'item'});
    const p = patchOf(join(root, 'x.txt'));
    r.calling('x');
    const path = r.write();
    return () => {
      const g = gate(payload(r, path, 'apply_patch', p));
      assert.equal(g.deny, false);
      return g.ms;
    };
  };
  // About 21 MB at the full size, inside the 32 MB the hook reads back.
  const g = growth(run(16_000), run(64_000), run(1));
  t2.diagnostic(g.shown);
  assert.ok(g.ratio < 8, g.shown);
});

test('codex: the hook is the same file in both copies, and names the shipped script\'s fingerprint', () => {
  const claude = readFileSync(join(ROOT, 'plugins/lessons-learned/hooks/lessons-gate.mjs'));
  assert.ok(readFileSync(join(PLUGIN, 'hooks/lessons-gate.mjs')).equals(claude), 'the two copies of the hook differ');
  const named = claude.toString('utf8').match(/^const FINGERPRINT = '([0-9a-f]{64})';$/m);
  assert.equal(named?.[1], createHash('sha256').update(TEMPLATE.replace(/\r\n/g, '\n')).digest('hex'));
});
