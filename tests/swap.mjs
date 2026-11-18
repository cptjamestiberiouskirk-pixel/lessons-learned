// Preloads that change the file system while the script runs, at the moment it
// would be easiest to miss. Each writes a CommonJS file into `into` and returns
// its path, for `node --require <path> <script>`. The script imports from
// node:fs by name, so each patch ends with syncBuiltinESMExports, which carries
// the change to those names.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

const HEAD = "const fs = require('fs'), path = require('path'), {syncBuiltinESMExports} = require('module');\n";

// What swapAfterLook puts in the file's place. Each is caught by a different
// check of the read, so each needs its own test:
// - link: a second hard link to `target` (a new file ID, and two links)
// - rename: `target` itself, renamed in (a new file ID, one link)
// - second-link: the same file, with a second name made at `target`
// - symlink: a symbolic link to `target`
// - fifo: a FIFO (not on Windows), which a blocking open would wait on
// - grow: the same file, with `target` (text here) added to its end
const MAKE = {
  link: 'fs.unlinkSync(p); fs.linkSync(target, p);',
  rename: 'fs.renameSync(target, p);',
  'second-link': 'fs.linkSync(p, target);',
  symlink: 'fs.unlinkSync(p); fs.symlinkSync(target, p);',
  fifo: "fs.unlinkSync(p); require('child_process').execFileSync('mkfifo', [p]);",
  grow: 'fs.appendFileSync(p, target);',
};

// Right after the script's first lstat of a file named `name`, puts `how` in
// its place: the look saw a file of its own, the read would get another.
export function swapAfterLook(into, name, target, how = 'link') {
  if (!MAKE[how]) throw new Error(`no such swap: ${how}`);
  const file = join(into, `swap-${how}.cjs`);
  writeFileSync(file, `${HEAD}const real = fs.lstatSync, target = ${JSON.stringify(target)};
let done = false;
fs.lstatSync = function (p, ...rest) {
  const r = real.call(this, p, ...rest);
  if (!done && path.basename(String(p)) === ${JSON.stringify(name)}) {
    done = true;
    ${MAKE[how]}
  }
  return r;
};
syncBuiltinESMExports();
`);
  return file;
}

// Right after the script's fstat of a handle it opened on a file named `name`,
// adds `text` to the end of that file, so the read gets more than the size the
// fstat gave.
export function growAfterFstat(into, name, text) {
  const file = join(into, 'grow-after-fstat.cjs');
  writeFileSync(file, `${HEAD}const open = fs.openSync, fstat = fs.fstatSync, opened = new Map();
fs.openSync = function (p, ...rest) {
  const fd = open.call(this, p, ...rest);
  if (path.basename(String(p)) === ${JSON.stringify(name)}) opened.set(fd, String(p));
  return fd;
};
fs.fstatSync = function (fd, ...rest) {
  const r = fstat.call(this, fd, ...rest);
  if (opened.has(fd)) {
    fs.appendFileSync(opened.get(fd), ${JSON.stringify(text)});
    opened.delete(fd);
  }
  return r;
};
syncBuiltinESMExports();
`);
  return file;
}

// Makes the real path of any file named `name` fail with `code`, as a folder
// the user can't list would.
export function realpathFails(into, name, code) {
  const file = join(into, 'realpath-fails.cjs');
  writeFileSync(file, `${HEAD}const real = fs.realpathSync.native;
fs.realpathSync.native = function (p, ...rest) {
  if (path.basename(String(p)) === ${JSON.stringify(name)}) {
    const e = new Error(${JSON.stringify(code)} + ': refused by the test');
    e.code = ${JSON.stringify(code)};
    throw e;
  }
  return real.call(this, p, ...rest);
};
syncBuiltinESMExports();
`);
  return file;
}
