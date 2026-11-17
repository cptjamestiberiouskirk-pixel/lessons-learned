// Tests for the Codex copy (plugins/lessons-learned-codex) and for what it
// must share with the Claude Code copy (plugins/lessons-learned).
// Run with: node --test
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE = join(REPO, 'plugins', 'lessons-learned');
const CODEX = join(REPO, 'plugins', 'lessons-learned-codex');
const URL = 'https://github.com/cptjamestiberiouskirk-pixel/lessons-learned';
const read = (...p) => readFileSync(join(...p), 'utf8');
const claudeSkill = read(CLAUDE, 'skills', 'setup', 'SKILL.md');
const codexSkill = read(CODEX, 'skills', 'lessons-setup', 'SKILL.md');

const folders = [];
after(() => folders.forEach((f) => rmSync(f, {recursive: true, force: true})));
function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-codex-'));
  folders.push(dir);
  return dir;
}

// The code of the first `node -e "..."` command in a skill whose code holds `marker`.
function nodeCommand(skill, marker) {
  const m = [...skill.matchAll(/^node -e "([^"]+)"(.*)$/gm)].find((x) => x[1].includes(marker));
  assert.ok(m, `no node -e command holding ${marker}`);
  return {code: m[1], rest: m[2].trim()};
}
const runNode = (code, args, cwd) => spawnSync(process.execPath, ['-e', code, ...args], {cwd, encoding: 'utf8'});

test('the Codex copy has one skill, lessons-setup, with only a name and a description', () => {
  assert.deepEqual(readdirSync(join(CODEX, 'skills')), ['lessons-setup']);
  const front = codexSkill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(front, 'no frontmatter');
  assert.deepEqual(front[1].split('\n').map((l) => l.split(':')[0]), ['name', 'description']);
  assert.match(front[1], /^name: lessons-setup$/m);
});

test('the Codex skill names no Claude Code placeholder, tool or slash command', () => {
  assert.doesNotMatch(codexSkill, /\$\{CLAUDE_|CLAUDE_PLUGIN_ROOT|Read tool|Write tool|\/lessons-learned:|lessons-learned:setup/);
});

test('both skills and the Codex manifests and README are plain ASCII, with no em or en dashes', () => {
  const files = [
    join(CLAUDE, 'skills', 'setup', 'SKILL.md'),
    join(CODEX, 'skills', 'lessons-setup', 'SKILL.md'),
    join(CODEX, 'plugin.json'),
    join(CODEX, '.codex-plugin', 'plugin.json'),
    join(CODEX, 'README.md'),
    join(REPO, '.agents', 'plugins', 'marketplace.json'),
  ];
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /[^\x00-\x7f]/, `${f} holds a non-ASCII character`);
});

test('the Codex manifests are the same file, name the plugin, carry the Claude copy\'s version and the website', () => {
  const root = read(CODEX, 'plugin.json');
  assert.equal(read(CODEX, '.codex-plugin', 'plugin.json'), root);
  const m = JSON.parse(root);
  const claude = JSON.parse(read(CLAUDE, '.claude-plugin', 'plugin.json'));
  assert.equal(m.name, 'lessons-learned-codex');
  assert.equal(m.version, claude.version);
  assert.equal(m.license, 'MIT');
  // The ChatGPT app's plugin page reads interface.websiteURL, not homepage.
  assert.equal(m.interface?.websiteURL, URL);
  assert.equal(m.homepage, URL);
});

test('the Codex marketplace lists the one plugin at its folder', () => {
  const mk = JSON.parse(read(REPO, '.agents', 'plugins', 'marketplace.json'));
  assert.deepEqual(mk.plugins.map((p) => [p.name, p.source.source, p.source.path]), [['lessons-learned-codex', 'local', './plugins/lessons-learned-codex']]);
  assert.ok(existsSync(join(REPO, mk.plugins[0].source.path, '.codex-plugin', 'plugin.json')));
});

test('the templates and LICENSE are byte for byte the same in both copies', () => {
  for (const f of ['LICENSE', 'templates/LESSONS.md', 'templates/PLAYBOOK.md', 'templates/lessons.mjs']) {
    assert.ok(readFileSync(join(CLAUDE, f)).equals(readFileSync(join(CODEX, f))), `${f} differs between the copies`);
  }
  assert.deepEqual(readdirSync(join(CODEX, 'templates')).sort(), readdirSync(join(CLAUDE, 'templates')).sort());
});

test('both skills give the template\'s fingerprint, the same path check and the same entry-point line', () => {
  const hash = createHash('sha256').update(read(CODEX, 'templates', 'lessons.mjs').replace(/\r\n/g, '\n')).digest('hex');
  for (const skill of [claudeSkill, codexSkill]) assert.match(skill, new RegExp(`This plugin's version prints \`${hash}\``));
  const pathCheck = (s) => s.match(/^node -e "const f=require\('fs'\);for\(const p of .*$/m)?.[0];
  assert.ok(pathCheck(claudeSkill));
  assert.equal(pathCheck(codexSkill), pathCheck(claudeSkill));
  const nodeRule = (s) => s.match(/^## Before any `node` command\n\n.*$/m)?.[0];
  assert.match(nodeRule(claudeSkill) || '', /starts with `node\.`, in any case/);
  assert.equal(nodeRule(codexSkill), nodeRule(claudeSkill));
  const entry = (s) => s.match(/^ {2}Before each step listed under "The lessons check".*$/m)?.[0];
  assert.ok(entry(claudeSkill));
  assert.equal(entry(codexSkill), entry(claudeSkill));
});

test('the Codex copy command copies a template exactly and refuses to write over an existing file', () => {
  const {code} = nodeCommand(codexSkill, "flag:'wx'");
  const repo = folder();
  const src = join(CODEX, 'templates', 'lessons.mjs');
  mkdirSync(join(repo, 'dev'));
  let r = runNode(code, [src, 'dev/lessons.mjs'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(join(repo, 'dev', 'lessons.mjs')).equals(readFileSync(src)));
  writeFileSync(join(repo, 'LESSONS.md'), 'the user\'s own log\n');
  r = runNode(code, [join(CODEX, 'templates', 'LESSONS.md'), 'LESSONS.md'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /LESSONS\.md: something is already there/);
  assert.equal(readFileSync(join(repo, 'LESSONS.md'), 'utf8'), 'the user\'s own log\n');
});

test('the Codex copy command does not write through a link at the target, even a dangling one', (t) => {
  const {code} = nodeCommand(codexSkill, "flag:'wx'");
  const repo = folder();
  const elsewhere = join(folder(), 'PLAYBOOK.md');
  try {
    symlinkSync(elsewhere, join(repo, 'PLAYBOOK.md'), 'file');
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip('this system does not allow symbolic links here');
    throw e;
  }
  const r = runNode(code, [join(CODEX, 'templates', 'PLAYBOOK.md'), 'PLAYBOOK.md'], repo);
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(elsewhere), 'the copy wrote through the link');
});

test('the path check reports a file, a folder, an absent path, a link (a junction on Windows) and a hard link', () => {
  const {code, rest} = nodeCommand(claudeSkill, 'lstatSync');
  assert.match(rest, /^LESSONS\.md PLAYBOOK\.md dev /);
  const repo = folder();
  writeFileSync(join(repo, 'LESSONS.md'), 'x');
  mkdirSync(join(repo, 'dev'));
  // A junction needs no special rights on Windows; elsewhere this is a plain link.
  symlinkSync(folder(), join(repo, 'linked'), 'junction');
  // A hard link to a file outside the repo.
  const outside = join(folder(), 'secret.txt');
  writeFileSync(outside, 'x');
  linkSync(outside, join(repo, 'AGENTS.md'));
  const r = runNode(code, ['LESSONS.md', 'PLAYBOOK.md', 'dev', 'linked', 'AGENTS.md'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split(/\r?\n/),
    ['LESSONS.md: file', 'PLAYBOOK.md: absent', 'dev: folder', 'linked: LINK', 'AGENTS.md: HARDLINK']);
  assert.match(rest, / \.gitattributes \.npmignore package\.json$/);
});

test('the Codex copy command refuses a dangling junction at the target, and creates nothing where it points', () => {
  const {code} = nodeCommand(codexSkill, "flag:'wx'");
  const repo = folder();
  const elsewhere = join(folder(), 'not-yet');
  // A junction needs no special rights on Windows; elsewhere this is a plain link.
  symlinkSync(elsewhere, join(repo, 'PLAYBOOK.md'), 'junction');
  const r = runNode(code, [join(CODEX, 'templates', 'PLAYBOOK.md'), 'PLAYBOOK.md'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PLAYBOOK\.md: something is already there/);
  assert.ok(!existsSync(elsewhere), 'the copy created something where the junction points');
});

test('the Codex copy command refuses a target whose folder is a link (a junction on Windows)', () => {
  const {code} = nodeCommand(codexSkill, "flag:'wx'");
  const repo = folder();
  const outside = folder();
  symlinkSync(outside, join(repo, 'dev'), 'junction');
  const r = runNode(code, [join(CODEX, 'templates', 'lessons.mjs'), 'dev/lessons.mjs'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dev: is a link/);
  assert.ok(!existsSync(join(outside, 'lessons.mjs')), 'the copy wrote into the folder the link points to');
});
