---
name: setup
description: Add a lessons-learned log (LESSONS.md) and a playbook of checklists (PLAYBOOK.md) to the current repo, or check an existing setup and fill in what's missing. Use on /lessons-learned:setup, or when the user asks to add lessons learned, a lessons file, a playbook, a mistakes log, or a way for Claude to learn from its mistakes in this project.
---

# Lessons setup

This sets up the lessons check in the current repo. It has five parts:

1. **`LESSONS.md`** at the repo root: a dated log, newest first. Each entry is `## YYYY-MM-DD: short title` followed by the fields `What went wrong`, `Why`, `Rule going forward`, `Evidence`, `Status`, in that order. Status is `open`, `promoted to PLAYBOOK "<section>"` or `closed: <why the rule no longer holds>`. Entries are never deleted.
2. **`PLAYBOOK.md`** at the repo root: checklists for the project's recurring work. Its first section, "The lessons check", lists the steps a session runs before each significant step. Every later section has a `From:` line naming the lessons it came from.
3. **`dev/lessons.mjs`**: finds lessons by topic and checks the format of both files. It reads and never writes.
4. **One entry-point line** in the file agents read at session start (`CLAUDE.md` or `AGENTS.md`), pointing at "The lessons check".
5. **Exclusion from what ships**: both files and the script stay out of whatever the project builds, packages or releases.

The templates for parts 1 to 3 are in `${CLAUDE_PLUGIN_ROOT}/templates/`. If that path doesn't resolve (it still has a placeholder in braces, or the folder isn't there), stop and tell the user what failed. Don't search the disk for another copy.

Everything lands in the repo itself, so the repo keeps working for people and sessions that don't have this plugin.

## The script's fingerprint

To tell whether a repo's `dev/lessons.mjs` is this plugin's version, run this from the repo root. It hashes the file with line endings ignored:

```
node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('dev/lessons.mjs','utf8').replace(/\r\n/g,'\n')).digest('hex'))"
```

This plugin's version prints `107c844c469fc0e422dc285f7ac06a66b8825286e83330e8a5d808412c6b3f50`. For a script kept in another folder, change the path in the command.

## Steps

### 1. Check what's here (read-only)

Find the repo root (`git rev-parse --show-toplevel`, or the working directory if it isn't a git repo). Look for each of the five parts, under these names and under others: `lessons*`, `learnings`, `gotchas`, `pitfalls`, `playbook*`, `runbook`, `checklist`, a `tasks/lessons.md`, rules kept in `CLAUDE.md`, `AGENTS.md`, `.claude/rules/` or `.claude/skills/`, and any memory or handoff folder the project uses. Skip `node_modules`, `.git`, build output and vendored folders.

Report each part as **present**, **partial**, **under another name** or **missing**, with the file path and the quoted line that shows it. If the script is present, run its `--check` and the fingerprint command, and include both outputs. A script whose fingerprint differs is **present, other version**.

### 2. Decide

- **All five present, `--check` reports 0 bad and the fingerprint matches:** change nothing. Report and stop.
- **Script present, other version:** it may be older than this plugin's, or changed on purpose. Read both, tell the user what differs in a few lines, and ask whether to replace it with this version. Replace it only on a yes, and then run `--check` again, since a newer script can find problems an older one missed.
- **Some present:** add only the missing parts. Keep the existing files' entries, names and wording. Fix format only where `--check` fails, and list each fix.
- **Same job under another name or format** (a `NOTES.md` of gotchas, rules kept in `CLAUDE.md`, a different log format): stop and ask the user whether to leave it, migrate its entries into `LESSONS.md` (each keeping its date and evidence), or wire the existing file into the lessons check as it is.
- **Missing:** go on to step 3.

When something is ambiguous, ask rather than guess.

### 3. Show the plan and wait

List each file to create or change, with one line on what changes, and the topic words you picked for "The lessons check" step 1 (from the project's own work: `migration`, `deploy`, `api`, and so on). Wait for the user's go-ahead.

If the project doesn't use Node, say so in the plan: the script needs Node to run. Ask whether Node is acceptable for a dev-only script or which language to port it to. A port keeps the same behavior, options and usage text. PowerShell means `pwsh` 7, never Windows PowerShell 5.1.

### 4. Build

Bring each template in by reading it with the Read tool and writing it into the repo with the Write tool, exactly as read. Don't copy it with a shell command (`cp`, `Copy-Item`): the plugin folder is outside the repo, so Claude Code refuses that or asks the user to approve it as a sensitive edit. Make any change after the write, with an edit. Step 5 checks that the script came through intact.

- **`LESSONS.md`**: copy `templates/LESSONS.md` to the repo root. Add no entries: don't invent lessons. If the project's history or docs show real, evidenced gotchas, list them in the report as proposed entries.
- **`PLAYBOOK.md`**: copy `templates/PLAYBOOK.md` to the repo root, and replace the topic words in step 1 of "The lessons check" with the ones from the plan. Add no other sections: those come from promoted lessons.
- **`dev/lessons.mjs`**: copy `templates/lessons.mjs`. It finds the repo root as the parent of its own folder, so it must sit one level down. If the project keeps dev scripts in another top-level folder (`scripts/`, `tools/`), put it there and change every `dev/lessons.mjs` in the two Markdown files and the script's usage text to match.
- **Entry point**: add this line near the top of `CLAUDE.md`, or of `AGENTS.md` if the project uses that instead, with the script path adjusted if you moved it:

  ```
  Before each step listed under "The lessons check" in `PLAYBOOK.md`, follow that section: it runs `node dev/lessons.mjs` and says when to add to `LESSONS.md`.
  ```

  Create `CLAUDE.md` only if neither file exists. Don't restructure what's there.
- **Exclusion**: keep `LESSONS.md`, `PLAYBOOK.md` and the script's folder out of what ships, with the project's own mechanism: `export-ignore` in `.gitattributes` for `git archive` releases, the `files` list in `package.json` or `.npmignore` for npm, the build's include list. If nothing ships from this repo, say so and skip this.
- **Optional**: if the project has one check script or CI job that runs before a merge, offer to add `node dev/lessons.mjs --check` to it. Add it only on the user's yes.

Don't add hooks, skills or slash commands to the project.

### 5. Verify

1. Run `node dev/lessons.mjs`, `node dev/lessons.mjs --check` (it must report 0 bad) and `node dev/lessons.mjs <one topic word>`. If you wrote the script and didn't edit its paths, run the fingerprint command (see "The script's fingerprint"): it must print this plugin's value. On any other value, compare the file with the template, fix the difference and run it again. If the script was moved and its paths edited, skip this and say so.
2. Prove that `--check` catches problems. Make a temp folder outside the repo, copy both Markdown files into it, and add three bad entries to the copy of `LESSONS.md`: one missing its `Why` field, one dated later than the entry above it, and one with `Status: promoted to PLAYBOOK "No such section"`. Run `node dev/lessons.mjs --dir <temp folder> --check`, confirm it exits 1 and names each of the three, then delete the temp folder.
3. If the project builds or packages anything, confirm the excluded files are left out: `git archive -o <temp file> HEAD` then `tar -tf <temp file>`, `npm pack --dry-run`, or the build's own listing. Exclusions in `.gitattributes` apply only once committed, so say if this can't be checked yet.
4. Show `git status` and `git diff`. Don't commit or push unless the user says so. When they do, follow the project's commit rules.

### 6. Report

- A table of the five parts: status before, status after, file.
- What changed in each file.
- The output of each check in step 5, with pass or fail.
- What's left for the user: questions, proposed lesson entries, the optional CI step.
