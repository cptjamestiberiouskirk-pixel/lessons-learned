// What the file system under the scratch folder (os.tmpdir()) lets a test make.
// exFAT and FAT have no hard links and no links to folders (Node reports EISDIR),
// and keep an unlinked file's name while it is open. A test that needs one of
// these to stage its case skips without it, as it does where links are refused.
import {closeSync, linkSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Codes a link call fails with where links can't be made here. macOS gives
// ENOTSUP for a hard link on FAT.
export const REFUSED = ['EPERM', 'EACCES', 'EISDIR', 'ENOTSUP'];

// True if `make` works, false if the file system or the system refuses it.
function works(make) {
  try {
    make();
    return true;
  } catch (e) {
    if (REFUSED.includes(e.code)) return false;
    throw e;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'lessons-can-'));
let hardLink, folderLink, freesUnlinkedName;
try {
  writeFileSync(join(dir, 'file'), '');
  mkdirSync(join(dir, 'folder'));
  hardLink = works(() => linkSync(join(dir, 'file'), join(dir, 'second-name')));
  // A junction needs no special rights on Windows; elsewhere this is a plain link.
  folderLink = works(() => symlinkSync(join(dir, 'folder'), join(dir, 'link'), 'junction'));
  const fd = openSync(join(dir, 'open'), 'w');
  try {
    unlinkSync(join(dir, 'open'));
    freesUnlinkedName = works(() => writeFileSync(join(dir, 'open'), 'x'));
  } finally {
    closeSync(fd);
  }
} finally {
  rmSync(dir, {recursive: true, force: true});
}

export const can = {hardLink, folderLink, freesUnlinkedName};
export const NO_HARD_LINKS = 'this file system has no hard links (exFAT, FAT)';
export const NO_FOLDER_LINKS = 'this file system has no links to folders (exFAT, FAT)';
