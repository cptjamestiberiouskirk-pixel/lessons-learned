# lessons-learned

A lessons-learned log and a playbook for Claude Code, kept in each repo.

Claude Code forgets a project's mistakes between sessions, so the same ones come back. This plugin sets up a small system in the repo that stops that:

- **`LESSONS.md`**: a dated log of what went wrong, why, and the rule going forward, with evidence.
- **`PLAYBOOK.md`**: checklists for the project's recurring work. Its first section, "The lessons check", is what Claude runs before each significant step: look up the lessons that apply, write a visible `Lessons checked:` line, follow the rules, and log anything that goes wrong before moving on. A lesson seen twice becomes a playbook step.
- **`dev/lessons.mjs`**: finds lessons by topic and checks the format of both files. It reads and never writes.
- **One line in `CLAUDE.md`** (or `AGENTS.md`) that points every session at the lessons check.

All of it lives in the repo, so it keeps working for anyone who clones the repo, with or without this plugin.

## Install

```
/plugin marketplace add cptjamestiberiouskirk-pixel/lessons-learned
/plugin install lessons-learned@lessons-learned
```

## Set up a repo

In the repo you want to set up, run:

```
/lessons-learned:setup
```

Or ask Claude to add lessons learned or a playbook to the project. Setup:

1. Checks what the repo already has, including the same idea under other names (a `gotchas.md`, rules kept in `CLAUDE.md`) and an older copy of the script.
2. Changes nothing if everything is in place. Otherwise it shows a plan and waits for your go-ahead.
3. Adds only what's missing, and keeps the files out of what the repo ships (`package.json` `files`, `.npmignore`, `export-ignore` in `.gitattributes`, or the build's include list).
4. Proves the format check catches broken entries and that the script came through intact. It doesn't commit.

## What it looks like

A lesson:

```
## 2026-11-15: A test read the save once, right after a toast, and saw old values
- What went wrong: the test read the save as soon as the toast showed and got 250 instead of 2750, in 2 of 3 runs.
- Why: the game saves on a timer (about every 5 s), so the save can trail what the page shows.
- Rule going forward: a test that checks state through the save polls it after the event, and does not read it once.
- Evidence: `tests/lategame.spec.ts`, search "The run is saved every few seconds".
- Status: open
```

Before a step, Claude looks up what applies and says so:

```
$ node dev/lessons.mjs save test
2026-11-15 "A test read the save once, right after a toast, and saw old values"
    a test that checks state through the save polls it after the event, and does not read it once.
PLAYBOOK "Changing saved state": follow its steps (2 matching lessons)
-- 3 shown; 3 lessons: 1 open, 2 promoted, 0 closed
```

```
Lessons checked: "A test read the save once, right after a toast, and saw old values"; PLAYBOOK "Changing saved state"
```

`node dev/lessons.mjs --check` checks the format of both files: every field present and in order, real dates newest first, valid statuses, and that each promoted lesson's playbook section exists and names it. It exits 1 on any problem, so it can run in CI.

## Requirements

Node.js for `dev/lessons.mjs`. It uses only Node's built-in modules. In a project without Node, setup asks whether to use it anyway or port the script.

## Limits

A session follows the lessons check by hand, because the instructions tell it to. The script checks only the format of the two files, not whether the check was run.
