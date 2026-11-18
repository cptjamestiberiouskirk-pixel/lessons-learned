// Tests for the Codex copy (plugins/lessons-learned-codex) and for what it
// must share with the Claude Code copy (plugins/lessons-learned).
// Run with: node --test
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from './child.mjs';
import {existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {can, NO_FOLDER_LINKS, NO_HARD_LINKS, REFUSED} from './links.mjs';

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
// The code of the first inline `node -e "..."` command in a skill whose code holds `marker`.
function inlineCommand(skill, marker) {
  const m = [...skill.matchAll(/`node -e "([^"]+)"([^`]*)`/g)].find((x) => x[1].includes(marker));
  assert.ok(m, `no inline node -e command holding ${marker}`);
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
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
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
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  const elsewhere = join(folder(), 'PLAYBOOK.md');
  try {
    symlinkSync(elsewhere, join(repo, 'PLAYBOOK.md'), 'file');
  } catch (e) {
    if (REFUSED.includes(e.code)) return t.skip('this system does not allow symbolic links here');
    throw e;
  }
  const r = runNode(code, [join(CODEX, 'templates', 'PLAYBOOK.md'), 'PLAYBOOK.md'], repo);
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(elsewhere), 'the copy wrote through the link');
});

test('the path check reports a file, a folder, an absent path, a link (a junction on Windows) and a hard link', (t) => {
  const {code, rest} = nodeCommand(claudeSkill, 'lstatSync');
  assert.match(rest, /^LESSONS\.md PLAYBOOK\.md dev /);
  assert.match(rest, / \.gitattributes \.npmignore package\.json$/);
  if (!can.folderLink) return t.skip(NO_FOLDER_LINKS);
  if (!can.hardLink) return t.skip(NO_HARD_LINKS);
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
});

test('the Codex copy command refuses a dangling junction at the target, and creates nothing where it points', (t) => {
  if (!can.folderLink) return t.skip(NO_FOLDER_LINKS);
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  const elsewhere = join(folder(), 'not-yet');
  // A junction needs no special rights on Windows; elsewhere this is a plain link.
  symlinkSync(elsewhere, join(repo, 'PLAYBOOK.md'), 'junction');
  const r = runNode(code, [join(CODEX, 'templates', 'PLAYBOOK.md'), 'PLAYBOOK.md'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PLAYBOOK\.md: something is already there/);
  assert.ok(!existsSync(elsewhere), 'the copy created something where the junction points');
});

test('the Codex copy command refuses a target whose folder is a link (a junction on Windows)', (t) => {
  if (!can.folderLink) return t.skip(NO_FOLDER_LINKS);
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  const outside = folder();
  symlinkSync(outside, join(repo, 'dev'), 'junction');
  const r = runNode(code, [join(CODEX, 'templates', 'lessons.mjs'), 'dev/lessons.mjs'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dev: is a link/);
  assert.ok(!existsSync(join(outside, 'lessons.mjs')), 'the copy wrote into the folder the link points to');
});

test('both skills give the same copy command', () => {
  assert.equal(nodeCommand(claudeSkill, "linkSync(t,d)").code, nodeCommand(codexSkill, "linkSync(t,d)").code);
});

// A preload script that changes what one fs call sees, to stand in for
// something on the machine acting between two steps of the copy command.
function preload(source) {
  const path = join(folder(), 'preload.cjs');
  writeFileSync(path, source);
  return path;
}

test('the copy command refuses a source swapped for another file between its look and its read', () => {
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  const secret = join(folder(), 'secret.txt');
  writeFileSync(secret, 'AKIA-SECRET');
  writeFileSync(join(repo, 'staged.md'), 'the template');
  // Opening or reading the source gets the secret, as if the staged file had
  // been swapped for a link to it right after the command looked at it.
  const swap = preload(`const f=require('fs'),o=f.openSync,r=f.readFileSync,s=${JSON.stringify(secret)};
f.openSync=(p,...a)=>o(p==='staged.md'?s:p,...a);
f.readFileSync=(p,...a)=>r(p==='staged.md'?s:p,...a);`);
  const r = spawnSync(process.execPath, ['-r', swap, '-e', code, 'staged.md', 'LESSONS.md'], {cwd: repo, encoding: 'utf8'});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /staged\.md: changed after the look/);
  assert.ok(!existsSync(join(repo, 'LESSONS.md')), 'the copy wrote the other file\'s text');
});

for (const [type, name] of [['file', 'symbolic link'], ['junction', 'junction']]) {
  test(`the copy command is not led by a dangling ${name} made after its look at the target, and makes nothing where it points`, (t) => {
    const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
    const repo = folder();
    const elsewhere = join(folder(), 'not-yet');
    try {
      symlinkSync(elsewhere, join(repo, 'PLAYBOOK.md'), type);
    } catch (e) {
      if (REFUSED.includes(e.code)) return t.skip('this system does not allow symbolic links here');
      throw e;
    }
    // The look at the target sees nothing, as if the link were made just after it.
    const late = preload(`const f=require('fs'),l=f.lstatSync;
f.lstatSync=(p,...a)=>{if(p==='PLAYBOOK.md'){const e=new Error('absent');e.code='ENOENT';throw e}return l(p,...a)};`);
    const r = spawnSync(process.execPath, ['-r', late, '-e', code, join(CODEX, 'templates', 'PLAYBOOK.md'), 'PLAYBOOK.md'], {cwd: repo, encoding: 'utf8'});
    // The hard link fails on the link. Where the copy falls back to a rename,
    // the rename replaces a link to a file and fails on a junction. Either way
    // nothing is written where it points, and no file is left under a random name.
    assert.ok(!existsSync(elsewhere), `the copy made something where the ${name} points`);
    assert.deepEqual(readdirSync(repo), ['PLAYBOOK.md'], 'a file was left under a random name');
    if (r.status === 0) {
      const s = lstatSync(join(repo, 'PLAYBOOK.md'));
      assert.ok(s.isFile() && s.nlink === 1, 'the link is still there after a copy that said it worked');
      assert.ok(readFileSync(join(repo, 'PLAYBOOK.md')).equals(readFileSync(join(CODEX, 'templates', 'PLAYBOOK.md'))));
    }
  });
}

test('the copy command refuses a source that is a second name for a file elsewhere (a hard link)', (t) => {
  if (!can.hardLink) return t.skip(NO_HARD_LINKS);
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  const secret = join(folder(), 'secret.txt');
  writeFileSync(secret, 'AKIA-SECRET');
  mkdirSync(join(repo, 'stage'));
  linkSync(secret, join(repo, 'stage', 'LESSONS.md'));
  const r = runNode(code, ['stage/LESSONS.md', 'LESSONS.md'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stage\/LESSONS\.md: is not a plain file with one name/);
  assert.ok(!existsSync(join(repo, 'LESSONS.md')), 'the copy brought the other file\'s text in');
});

test('the copy command keeps a file made at the target after its look, and leaves nothing under the random name', (t) => {
  // Without hard links the copy renames into place, which replaces a file made
  // there in that instant (SECURITY.md, "The path check and the write are two steps").
  if (!can.hardLink) return t.skip(NO_HARD_LINKS);
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  writeFileSync(join(repo, 'PLAYBOOK.md'), 'the user\'s own playbook\n');
  // The look at the target sees nothing, as if the file were made just after it.
  const late = preload(`const f=require('fs'),l=f.lstatSync;
f.lstatSync=(p,...a)=>{if(p==='PLAYBOOK.md'){const e=new Error('absent');e.code='ENOENT';throw e}return l(p,...a)};`);
  const r = spawnSync(process.execPath, ['-r', late, '-e', code, join(CODEX, 'templates', 'PLAYBOOK.md'), 'PLAYBOOK.md'], {cwd: repo, encoding: 'utf8'});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PLAYBOOK\.md: something is already there/);
  assert.equal(readFileSync(join(repo, 'PLAYBOOK.md'), 'utf8'), 'the user\'s own playbook\n');
  assert.deepEqual(readdirSync(repo), ['PLAYBOOK.md']);
});

test('the copy command refuses a source whose folder is a link (a junction on Windows)', (t) => {
  if (!can.folderLink) return t.skip(NO_FOLDER_LINKS);
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  const outside = folder();
  writeFileSync(join(outside, 'LESSONS.md'), 'TEXT FROM OUTSIDE THE REPO');
  symlinkSync(outside, join(repo, '.lessons-setup-Ab3xYz'), 'junction');
  const r = runNode(code, ['.lessons-setup-Ab3xYz/LESSONS.md', 'LESSONS.md'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /\.lessons-setup-Ab3xYz: is a link/);
  assert.ok(!existsSync(join(repo, 'LESSONS.md')), 'the copy brought the outside text in');
});

test('the copy command refuses a source whose folder is swapped between its look and its read', () => {
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  const other = folder();
  mkdirSync(join(repo, 'stage'));
  writeFileSync(join(repo, 'stage', 'LESSONS.md'), 'the template');
  // The second look at the folder finds a different folder, as if it had
  // been swapped while the file was read.
  const swap = preload(`const f=require('fs'),l=f.lstatSync,o=${JSON.stringify(other)};let n=0;
f.lstatSync=(p,...a)=>(p==='stage'&&n++>0)?l(o,...a):l(p,...a);`);
  const r = spawnSync(process.execPath, ['-r', swap, '-e', code, 'stage/LESSONS.md', 'LESSONS.md'], {cwd: repo, encoding: 'utf8'});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stage\/LESSONS\.md: changed after the look/);
  assert.ok(!existsSync(join(repo, 'LESSONS.md')));
});

test('where hard links are refused (Codex\'s Windows sandbox), the copy renames the file into place', () => {
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  const src = join(CODEX, 'templates', 'LESSONS.md');
  const refuse = preload(`const f=require('fs');
f.linkSync=()=>{const e=new Error('operation not permitted');e.code='EPERM';throw e};`);
  const r = spawnSync(process.execPath, ['-r', refuse, '-e', code, src, 'LESSONS.md'], {cwd: repo, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(join(repo, 'LESSONS.md')).equals(readFileSync(src)));
  const s = lstatSync(join(repo, 'LESSONS.md'));
  assert.ok(s.isFile() && s.nlink === 1, `nlink ${s.nlink}`);
  assert.deepEqual(readdirSync(repo), ['LESSONS.md']);
});

// A preload that makes fs act as on exFAT, as probed on Windows 11: a hard link
// fails with EISDIR, a file's ID comes from where its entry is (here, its path),
// so a rename changes it, and an open file's ID follows the file when it moves.
// `before` runs at the fallback rename, before the file is moved.
const exfat = (before = '') => `const f=require('fs'),path=require('path'),c=require('crypto');
const at=new Map(),abs=(p)=>path.resolve(String(p));
const id=(p,big)=>{const n=BigInt('0x'+c.createHash('sha256').update(abs(p)).digest('hex').slice(0,12));return big?n:Number(n)};
const slot=(s,p,a)=>{if(s&&p&&s.isFile())s.ino=id(p,a&&a.bigint);return s};
const o=f.openSync;f.openSync=(p,...a)=>{const fd=o(p,...a);at.set(fd,abs(p));return fd};
const mv=f.renameSync,move=(a,b)=>{mv(a,b);for(const [fd,p] of at)if(p===abs(a))at.set(fd,abs(b))};
const ls=f.lstatSync;f.lstatSync=(p,a)=>slot(ls(p,a),p,a);
const fs=f.fstatSync;f.fstatSync=(fd,a)=>slot(fs(fd,a),at.get(fd),a);
f.linkSync=()=>{const e=new Error('illegal operation on a directory');e.code='EISDIR';throw e};
f.renameSync=(a,b)=>{${before}move(a,b)};`;

test('on a drive where a rename changes a file\'s ID (exFAT), the copy renames the file into place and accepts it', () => {
  const {r, repo} = copyWith(exfat());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(join(repo, 'LESSONS.md')).equals(readFileSync(join(CODEX, 'templates', 'LESSONS.md'))));
  assert.deepEqual(readdirSync(repo), ['LESSONS.md']);
});

test('on exFAT, the copy still fails when its random-name file is moved away and another put in its place before the rename', () => {
  // exFAT keeps an unlinked open file's name until it is closed, so a swap there
  // moves the file away instead. The held file's ID then follows it elsewhere.
  const {r, repo} = copyWith(exfat("move(a,path.join(path.dirname(a),'away'));f.writeFileSync(a,'NOT THE TEMPLATE');"));
  assert.equal(r.status, 1, 'the copy said it worked');
  assert.match(r.stderr, /LESSONS\.md: is not the file this copy wrote: check it/);
  assert.equal(readFileSync(join(repo, 'LESSONS.md'), 'utf8'), 'NOT THE TEMPLATE');
});

// Runs the copy command with a preload, from a fresh repo; returns the run and the repo.
function copyWith(preloadSource, src = join(CODEX, 'templates', 'LESSONS.md'), dst = 'LESSONS.md', repo = folder()) {
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const r = spawnSync(process.execPath, ['-r', preload(preloadSource), '-e', code, src, dst], {cwd: repo, encoding: 'utf8'});
  return {r, repo};
}

test('the copy command fails, and names the file, when it cannot remove the random name after the hard link', (t) => {
  if (!can.hardLink) return t.skip(NO_HARD_LINKS);
  const {r, repo} = copyWith(`const f=require('fs'),u=f.unlinkSync;
f.unlinkSync=(p,...a)=>{if(String(p).includes('.lessons-copy-')){const e=new Error('busy');e.code='EBUSY';throw e}return u(p,...a)};`);
  assert.equal(r.status, 1, r.stderr);
  const left = readdirSync(repo).find((n) => n.startsWith('.lessons-copy-'));
  assert.ok(left, 'no file was left, so the test did not force the failure');
  assert.match(r.stderr, new RegExp(`LESSONS\\.md: copied; .*${left} is left: remove it`));
});

test('the copy command leaves nothing under the random name when the fallback rename is refused', () => {
  const repo = folder();
  mkdirSync(join(repo, 'in-the-way'));
  // The hard link is refused as in Codex's sandbox, and a folder sits at the
  // target that the look did not see, so the rename fails too.
  const {r} = copyWith(`const f=require('fs'),l=f.lstatSync;
f.linkSync=()=>{const e=new Error('not permitted');e.code='EPERM';throw e};
f.lstatSync=(p,...a)=>{if(p==='in-the-way'){const e=new Error('absent');e.code='ENOENT';throw e}return l(p,...a)};`, undefined, 'in-the-way', repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /in-the-way: something is in the way/);
  assert.doesNotMatch(r.stderr, /is left/);
  assert.deepEqual(readdirSync(repo), ['in-the-way']);
});

test('the copy command leaves nothing under the random name when writing it fails part way', () => {
  // The copy writes the random-name file through the handle it opened it with.
  const {r, repo} = copyWith(`const f=require('fs'),w=f.writeFileSync;
f.writeFileSync=(p,...a)=>{if(typeof p==='number'){f.writeSync(p,'part');const e=new Error('no space');e.code='ENOSPC';throw e}return w(p,...a)};`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot be written \(ENOSPC\)/);
  assert.deepEqual(readdirSync(repo), []);
});

test('the copy command names no random-name file as left when writing it failed before making it', () => {
  const {r, repo} = copyWith(`const f=require('fs'),o=f.openSync;
f.openSync=(p,...a)=>{if(String(p).includes('.lessons-copy-')){const e=new Error('denied');e.code='EACCES';throw e}return o(p,...a)};`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot be written \(EACCES\)/);
  assert.doesNotMatch(r.stderr, /is left/);
  assert.deepEqual(readdirSync(repo), []);
});

test('the copy command names no random-name file as left on a read-only drive, where removing a missing file also fails', () => {
  // On a read-only drive, unlinking a name that is not there gives EROFS, not ENOENT.
  const {r, repo} = copyWith(`const f=require('fs'),o=f.openSync,u=f.unlinkSync;
const ro=()=>{const e=new Error('read-only file system');e.code='EROFS';throw e};
f.openSync=(p,...a)=>String(p).includes('.lessons-copy-')?ro():o(p,...a);
f.unlinkSync=(p,...a)=>String(p).includes('.lessons-copy-')?ro():u(p,...a);`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot be written \(EROFS\)/);
  assert.doesNotMatch(r.stderr, /is left/);
  assert.deepEqual(readdirSync(repo), []);
});

test('the copy command refuses a target whose folder is a plain file, without naming a file as left', () => {
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  writeFileSync(join(repo, 'dev'), 'not a folder');
  const r = runNode(code, [join(CODEX, 'templates', 'lessons.mjs'), 'dev/lessons.mjs'], repo);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'dev: is not a folder');
});

test('the copy command names a source that vanishes as it is opened, without a stack trace', () => {
  const repo = folder();
  writeFileSync(join(repo, 'staged.md'), 'the template');
  const {r} = copyWith(`const f=require('fs'),o=f.openSync;
f.openSync=(p,...a)=>{if(p==='staged.md'){const e=new Error('gone');e.code='ENOENT';throw e}return o(p,...a)};`, 'staged.md', 'LESSONS.md', repo);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'staged.md: changed after the look');
  assert.deepEqual(readdirSync(repo), ['staged.md']);
});

test('the copy command refuses a source whose folder is swapped for a junction before its look at the file and back after its read', (t) => {
  if (!can.folderLink) return t.skip(NO_FOLDER_LINKS);
  const repo = folder();
  const outside = folder();
  writeFileSync(join(outside, 'LESSONS.md'), 'TEXT FROM OUTSIDE THE REPO');
  mkdirSync(join(repo, 'stage'));
  writeFileSync(join(repo, 'stage', 'LESSONS.md'), 'the template');
  // The folder is swapped just after the command looks at it, so its look at
  // the file and its read both reach the outside file. Then it is swapped back,
  // so a second look at the folder alone sees the folder it saw first.
  const {r} = copyWith(`const f=require('fs'),l=f.lstatSync,o=f.openSync,out=${JSON.stringify(outside)};let swapped=false;
f.lstatSync=(p,...a)=>{if(p==='stage/LESSONS.md'&&!swapped){swapped=true;f.renameSync('stage','stage-real');f.symlinkSync(out,'stage','junction')}return l(p,...a)};
f.openSync=(p,...a)=>{const fd=o(p,...a);if(p==='stage/LESSONS.md'&&swapped){f.unlinkSync('stage');f.renameSync('stage-real','stage')}return fd};`, 'stage/LESSONS.md', 'LESSONS.md', repo);
  assert.notEqual(r.status, 0, 'the copy said it worked');
  assert.match(r.stderr, /stage\/LESSONS\.md: changed after the look/);
  assert.ok(!existsSync(join(repo, 'LESSONS.md')), 'the copy brought the outside text in');
});

for (const [how, refuseLink] of [['hard link', false], ['fallback rename', true]]) {
  test(`the copy command fails when its random-name file is swapped for a second name of a file outside before the ${how}`, (t) => {
    if (!can.hardLink) return t.skip(NO_HARD_LINKS);
    const repo = folder();
    const outside = join(folder(), 'secret.txt');
    writeFileSync(outside, 'AKIA-SECRET');
    // Just before the hard link, the random-name file is replaced by a second
    // name for the outside file, so the target would become a third.
    const {r} = copyWith(`const f=require('fs'),k=f.linkSync,out=${JSON.stringify(outside)};
f.linkSync=(t,d)=>{f.unlinkSync(t);k(out,t);${refuseLink ? "const e=new Error('not permitted');e.code='EPERM';throw e" : 'return k(t,d)'}};`, undefined, 'LESSONS.md', repo);
    assert.equal(r.status, 1, 'the copy said it worked');
    assert.match(r.stderr, /LESSONS\.md: is not the file this copy wrote: check it/);
    assert.equal(readFileSync(outside, 'utf8'), 'AKIA-SECRET');
  });
}

test('where hard links are refused, the copy still keeps a file already at the target', () => {
  // The rename would replace the file, so only the look before it keeps it.
  const repo = folder();
  writeFileSync(join(repo, 'LESSONS.md'), 'the user\'s own log\n');
  const {r} = copyWith(`const f=require('fs');
f.linkSync=()=>{const e=new Error('not permitted');e.code='EPERM';throw e};`, undefined, 'LESSONS.md', repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /LESSONS\.md: something is already there/);
  assert.equal(readFileSync(join(repo, 'LESSONS.md'), 'utf8'), 'the user\'s own log\n');
  assert.deepEqual(readdirSync(repo), ['LESSONS.md']);
});

test('the copy command refuses a source replaced by another plain file between its look and its read, which stays replaced', () => {
  const repo = folder();
  writeFileSync(join(repo, 'staged.md'), 'the template');
  const other = join(repo, 'other.md');
  writeFileSync(other, 'AKIA-SECRET');
  // Just before the open, another file is moved over the staged one, so every
  // later look at the path agrees with what was read.
  const {r} = copyWith(`const f=require('fs'),o=f.openSync,other=${JSON.stringify(other)};
f.openSync=(p,...a)=>{if(p==='staged.md')f.renameSync(other,'staged.md');return o(p,...a)};`, 'staged.md', 'LESSONS.md', repo);
  assert.equal(r.status, 1, 'the copy said it worked');
  assert.match(r.stderr, /staged\.md: changed after the look/);
  assert.ok(!existsSync(join(repo, 'LESSONS.md')), 'the copy brought the other file\'s text in');
});

test('the copy command fails when the target gains a second name during the copy', (t) => {
  if (!can.hardLink) return t.skip(NO_HARD_LINKS);
  const repo = folder();
  const {r} = copyWith(`const f=require('fs'),k=f.linkSync;
f.linkSync=(t,d)=>{k(t,d);k(d,'second-name')};`, undefined, 'LESSONS.md', repo);
  assert.equal(r.status, 1, 'the copy said it worked');
  assert.match(r.stderr, /LESSONS\.md: is not the file this copy wrote: check it/);
});

test('the copy command fails when its random-name file is replaced by another plain file before the fallback rename', (t) => {
  if (!can.freesUnlinkedName) return t.skip('this file system keeps an open file\'s name after unlink (exFAT); a test above moves the file away instead');
  const repo = folder();
  const {r} = copyWith(`const f=require('fs');
f.linkSync=(t)=>{f.unlinkSync(t);f.writeFileSync(t,'NOT THE TEMPLATE');const e=new Error('not permitted');e.code='EPERM';throw e};`, undefined, 'LESSONS.md', repo);
  assert.equal(r.status, 1, 'the copy said it worked');
  assert.match(r.stderr, /LESSONS\.md: is not the file this copy wrote: check it/);
});

test('the copy command copies into a repo opened through a junction', (t) => {
  if (!can.folderLink) return t.skip(NO_FOLDER_LINKS);
  // A repo reached through a junction (one on another drive, say) keeps that
  // path as the working folder, so the repo's own folder looks like a link.
  const real = folder();
  const repo = join(folder(), 'repo');
  symlinkSync(real, repo, 'junction');
  mkdirSync(join(repo, 'dev'));
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  for (const [src, dst] of [['LESSONS.md', 'LESSONS.md'], ['lessons.mjs', 'dev/lessons.mjs']]) {
    const r = runNode(code, [join(CODEX, 'templates', src), dst], repo);
    assert.equal(r.status, 0, `${dst}: ${r.stderr}`);
    assert.ok(readFileSync(join(real, dst)).equals(readFileSync(join(CODEX, 'templates', src))));
  }
});

// A junction to a volume path (\\?\Volume{GUID}\...), which lstat reports as a
// plain folder, not a link. Any user can make one. Returns false where none can be made.
function volumeJunction(at, target) {
  if (process.platform !== 'win32') return false;
  const root = target.slice(0, 3);
  const vol = spawnSync('mountvol', [root, '/L'], {encoding: 'utf8'}).stdout?.trim();
  if (!/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i.test(vol ?? '')) return false;
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', at, vol + target.slice(root.length)], {encoding: 'utf8'});
  if (r.status !== 0) return false;
  folders.unshift(at); // removed first, as the junction itself, before its folder
  return !lstatSync(at).isSymbolicLink();
}

for (const [what, args] of [
  ['target\'s folder', (repo) => [join(CODEX, 'templates', 'lessons.mjs'), 'dev/lessons.mjs', 'dev']],
  ['staging folder', (repo) => ['.lessons-setup-Ab3xYz/LESSONS.md', 'LESSONS.md', '.lessons-setup-Ab3xYz']],
]) {
  test(`the copy command refuses a ${what} that is a junction to a volume path, which lstat takes for a folder`, (t) => {
    const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
    const repo = folder();
    const outside = folder();
    writeFileSync(join(outside, 'LESSONS.md'), 'TEXT FROM OUTSIDE THE REPO');
    const [src, dst, linked] = args(repo);
    if (!volumeJunction(join(repo, linked), outside)) return t.skip('no junction to a volume path can be made here');
    const r = runNode(code, [src, dst], repo);
    assert.equal(r.status, 1, 'the copy said it worked');
    assert.equal(r.stderr.trim(), `${linked}: leads outside the repo`);
    assert.deepEqual(readdirSync(outside), ['LESSONS.md']);
    assert.ok(!existsSync(join(repo, 'LESSONS.md')), 'the copy brought the outside text in');
  });
}

// NTFS keeps `kit` and `Kit` spelled with the Kelvin sign (U+212A) apart, and a
// check that folds the whole path with toLowerCase makes both `kit`, so a junction
// into the second got past it. The repo's part of the real path is compared exactly.
test('the copy command compares the repo\'s real path exactly, so a folder that differs from it only by Unicode case is outside', (t) => {
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const base = folder();
  const repo = join(base, 'kit', 'repo');
  const outside = join(base, `${String.fromCodePoint(0x212a)}it`, 'repo', 'dev');
  mkdirSync(repo, {recursive: true});
  mkdirSync(outside, {recursive: true});
  if (readdirSync(base).length !== 2) return t.skip('this file system folds the Kelvin sign to "k"');
  if (!volumeJunction(join(repo, 'dev'), outside)) return t.skip('no junction to a volume path can be made here');
  const r = runNode(code, [join(CODEX, 'templates', 'lessons.mjs'), 'dev/lessons.mjs'], repo);
  assert.equal(r.status, 1, 'the copy said it worked');
  assert.equal(r.stderr.trim(), 'dev: leads outside the repo');
  assert.deepEqual(readdirSync(outside), []);
});

// A folder marked case-sensitive (no admin needed) can hold `repo` and `REPO`
// side by side, so the repo's part of the real path must keep its case.
test('the copy command refuses a junction into a folder that differs from the repo only in case, in a case-sensitive folder', (t) => {
  if (process.platform !== 'win32') return t.skip('folders marked case-sensitive are a Windows feature');
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const base = folder();
  const mark = spawnSync('fsutil', ['file', 'setCaseSensitiveInfo', base, 'enable'], {encoding: 'utf8'});
  if (mark.status !== 0) return t.skip('this folder cannot be marked case-sensitive here');
  const repo = join(base, 'repo');
  const outside = join(base, 'REPO', 'dev');
  mkdirSync(repo);
  mkdirSync(outside, {recursive: true});
  if (!volumeJunction(join(repo, 'dev'), outside)) return t.skip('no junction to a volume path can be made here');
  const r = runNode(code, [join(CODEX, 'templates', 'lessons.mjs'), 'dev/lessons.mjs'], repo);
  assert.equal(r.status, 1, 'the copy said it worked');
  assert.equal(r.stderr.trim(), 'dev: leads outside the repo');
  assert.deepEqual(readdirSync(outside), []);
});

// The repo's real path ends in a separator in the comparison, so a sibling
// folder whose name starts with the repo's is outside. Two names, since each
// gets past a different wrong comparison: `repoZdev` past one that skips a
// character after the root, `repodev` past one that drops the separator there.
for (const sibling of ['repoZdev', 'repodev']) {
  test(`the copy command refuses a junction into a sibling folder whose name starts with the repo's (${sibling})`, (t) => {
    const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
    const base = folder();
    const repo = join(base, 'repo');
    const outside = join(base, sibling);
    mkdirSync(repo);
    mkdirSync(outside);
    if (!volumeJunction(join(repo, 'dev'), outside)) return t.skip('no junction to a volume path can be made here');
    const r = runNode(code, [join(CODEX, 'templates', 'lessons.mjs'), 'dev/lessons.mjs'], repo);
    assert.equal(r.status, 1, 'the copy said it worked');
    assert.equal(r.stderr.trim(), 'dev: leads outside the repo');
    assert.deepEqual(readdirSync(outside), []);
  });
}

test('the copy command refuses a target given as an absolute path, which the real-path check would not cover', () => {
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  mkdirSync(join(repo, 'dev'));
  const r = runNode(code, [join(CODEX, 'templates', 'lessons.mjs'), join(repo, 'dev', 'lessons.mjs')], repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /: give the target relative to the repo root/);
  assert.deepEqual(readdirSync(join(repo, 'dev')), []);
});

// 0.3.0 compared the folder's real path with the repo's joined to the path,
// which `..` takes out of the repo on both sides, so the two matched.
test('the copy command refuses a relative target that climbs out of the repo with ..', () => {
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const base = folder();
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  mkdirSync(repo);
  mkdirSync(outside);
  const r = runNode(code, [join(CODEX, 'templates', 'LESSONS.md'), '../outside/LESSONS.md'], repo);
  assert.equal(r.status, 1, 'the copy said it worked');
  assert.equal(r.stderr.trim(), '../outside: leads outside the repo');
  assert.deepEqual(readdirSync(outside), []);
});

test('the copy command takes a folder named in another case than its target path gives, where the file system ignores case', (t) => {
  // There a path's case need not match the folder's, and the real path may give the folder's own.
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  mkdirSync(join(repo, 'Dev'));
  if (!existsSync(join(repo, 'dev'))) return t.skip('this file system tells folder names apart by case');
  const r = runNode(code, [join(CODEX, 'templates', 'lessons.mjs'), 'dev/lessons.mjs'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(join(repo, 'Dev', 'lessons.mjs')).equals(readFileSync(join(CODEX, 'templates', 'lessons.mjs'))));
});

// The fold runs on macOS too, whose usual file system ignores case. No CI runner
// gives a real path in the folder's own case there, so the platform is set to
// darwin with a preload, on a file system here that ignores case.
test('the copy command folds ASCII case in the folder name on macOS too', (t) => {
  const repo = folder();
  mkdirSync(join(repo, 'Dev'));
  if (!existsSync(join(repo, 'dev'))) return t.skip('this file system tells folder names apart by case');
  const {r} = copyWith("Object.defineProperty(process,'platform',{value:'darwin'});", join(CODEX, 'templates', 'lessons.mjs'), 'dev/lessons.mjs', repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(join(repo, 'Dev', 'lessons.mjs')).equals(readFileSync(join(CODEX, 'templates', 'lessons.mjs'))));
});

test('the copy command refuses a target folder whose real path differs from its path only in case (Linux)', (t) => {
  // There, repo and REPO are two folders, so a link in the repo to REPO/a leads outside it.
  if (process.platform !== 'linux') return t.skip('folder names that differ only in case are one folder here');
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const base = folder();
  const repo = join(base, 'repo');
  mkdirSync(join(repo), {recursive: true});
  mkdirSync(join(base, 'REPO', 'a', 'b'), {recursive: true});
  symlinkSync(join(base, 'REPO', 'a'), join(repo, 'a'));
  const r = runNode(code, [join(CODEX, 'templates', 'LESSONS.md'), 'a/b/LESSONS.md'], repo);
  assert.equal(r.status, 1, 'the copy said it worked');
  assert.equal(r.stderr.trim(), 'a/b: leads outside the repo');
  assert.deepEqual(readdirSync(join(base, 'REPO', 'a', 'b')), []);
});

test('the copy command copies the text it read through the handle it checked, not what the path holds later', (t) => {
  if (!can.hardLink) return t.skip(NO_HARD_LINKS);
  const repo = folder();
  writeFileSync(join(repo, 'staged.md'), 'the template');
  const outside = join(folder(), 'secret.txt');
  writeFileSync(outside, 'TEXT FROM OUTSIDE THE REPO');
  // After the copy checks the file it opened, the path is made a second name for
  // a file outside, and put back before the handle is closed, so every look by
  // path agrees. Only a read through the handle gets the template.
  const {r} = copyWith(`const f=require('fs'),fs0=f.fstatSync,c=f.closeSync,k=f.linkSync,out=${JSON.stringify(outside)};let src=-1,swapped=false;
const o=f.openSync;f.openSync=(p,...a)=>{const fd=o(p,...a);if(p==='staged.md')src=fd;return fd};
f.fstatSync=(fd,...a)=>{const s=fs0(fd,...a);if(fd===src&&!swapped){swapped=true;f.renameSync('staged.md','staged-real');k(out,'staged.md')}return s};
f.closeSync=(fd)=>{if(fd===src&&swapped){f.unlinkSync('staged.md');f.renameSync('staged-real','staged.md');src=-1}return c(fd)};`, 'staged.md', 'LESSONS.md', repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(repo, 'LESSONS.md'), 'utf8'), 'the template');
  assert.equal(readFileSync(outside, 'utf8'), 'TEXT FROM OUTSIDE THE REPO');
});

for (const [how, refuseLink] of [['hard link', false], ['fallback rename', true]]) {
  test(`the copy command fails when the target's folder is swapped for a junction after its look (${how})`, (t) => {
    if (!can.folderLink) return t.skip(NO_FOLDER_LINKS);
    const repo = folder();
    const outside = folder();
    mkdirSync(join(repo, 'dev'));
    // After the copy's checks of dev, at its next look at anything else, dev
    // becomes a junction to a folder outside.
    const {r} = copyWith(`const f=require('fs'),l=f.lstatSync,out=${JSON.stringify(outside)};let seen=false,done=false;
f.lstatSync=(p,...a)=>{if(p==='dev')seen=true;else if(seen&&!done){done=true;f.renameSync('dev','dev-real');f.symlinkSync(out,'dev','junction')}return l(p,...a)};
${refuseLink ? "f.linkSync=()=>{const e=new Error('not permitted');e.code='EPERM';throw e};" : ''}`, join(CODEX, 'templates', 'lessons.mjs'), 'dev/lessons.mjs', repo);
    assert.equal(r.status, 1, 'the copy said it worked');
    assert.match(r.stderr, /^dev: changed during the copy: check it/m);
  });
}

test('the copy command refuses a source that gains a second name between its look and its read', () => {
  const {r, repo} = copyWith(`const f=require('fs'),s=f.fstatSync;
f.fstatSync=(...a)=>{const r=s(...a);r.nlink=2n;return r};`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /changed after the look/);
  assert.deepEqual(readdirSync(repo), []);
});

test('the copy command names a missing source or folder without a stack trace', () => {
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  let r = runNode(code, ['nothing.md', 'LESSONS.md'], repo);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'nothing.md: not found');
  r = runNode(code, [join(CODEX, 'templates', 'lessons.mjs'), 'dev/lessons.mjs'], repo);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'dev: not found');
});

test('the copy command leaves the target a plain file with one name, and nothing under the random name', () => {
  const {code} = nodeCommand(codexSkill, "linkSync(t,d)");
  const repo = folder();
  const r = runNode(code, [join(CODEX, 'templates', 'LESSONS.md'), 'LESSONS.md'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(repo), ['LESSONS.md']);
  const s = lstatSync(join(repo, 'LESSONS.md'));
  assert.ok(s.isFile() && s.nlink === 1, `nlink ${s.nlink}`);
});

test('the Claude Code skill\'s staging steps bring a template in exactly and leave no staging folder', () => {
  const repo = folder();
  const make = inlineCommand(claudeSkill, 'mkdtempSync');
  const made = runNode(make.code, [], repo);
  assert.equal(made.status, 0, made.stderr);
  const staging = made.stdout.trim();
  assert.match(staging, /^\.lessons-setup-\w{6}$/);
  // The Write tool's part: the template as read.
  const src = join(CLAUDE, 'templates', 'lessons.mjs');
  writeFileSync(join(repo, staging, 'lessons.mjs'), readFileSync(src));
  mkdirSync(join(repo, 'dev'));
  const copy = runNode(nodeCommand(claudeSkill, "linkSync(t,d)").code, [`${staging}/lessons.mjs`, 'dev/lessons.mjs'], repo);
  assert.equal(copy.status, 0, copy.stderr);
  assert.ok(readFileSync(join(repo, 'dev', 'lessons.mjs')).equals(readFileSync(src)));
  const remove = inlineCommand(claudeSkill, 'rmSync');
  assert.equal(remove.rest, '.lessons-setup-Ab3xYz');
  const gone = runNode(remove.code, [staging], repo);
  assert.equal(gone.status, 0, gone.stderr);
  assert.deepEqual(readdirSync(repo).sort(), ['dev']);
});
