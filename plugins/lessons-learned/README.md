# lessons-learned

A lessons-learned log and a playbook for Claude Code, kept in each repo.

Claude Code forgets a project's mistakes between sessions, so the same ones come back. This plugin sets up a small system in the repo that stops that:

- **`LESSONS.md`**: a dated log of what went wrong, why, and the rule going forward, with evidence.
- **`PLAYBOOK.md`**: checklists for the project's recurring work. Its first section, "The lessons check", is what Claude runs before each significant step: look up the lessons that apply, write a visible `Lessons checked:` line, follow the rules, and log anything that goes wrong before moving on. A lesson seen twice becomes a playbook step. Its second section, "Checking your work", says what to run and report before calling a change done: run it the way it is used, list what ran and what didn't, make a test for a fix fail before the fix, never weaken a check to pass it, and stop after three failed fixes.
- **`dev/lessons.mjs`**: finds lessons by topic and checks the format of both files. `--stale` lists lessons whose evidence names a file that is gone, or text that file no longer holds, as leads for closing them, and names a file it didn't check or search. It reads and never writes.
- **One line in `CLAUDE.md`** that points every session at the lessons check, and in `AGENTS.md` too when the repo is also worked on from Codex or another agent that reads it (Cursor, Windsurf, OpenCode, GitHub Copilot), or in `GEMINI.md` for Gemini CLI.

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

Node.js 22 or later for `dev/lessons.mjs`. It uses only Node's built-in modules. In a project without Node, setup asks whether to use it anyway or port the script.

## The lessons gate

The plugin has one hook. In a repo whose `PLAYBOOK.md` has the section "The lessons check", it runs before each edit (Edit, Write, MultiEdit, NotebookEdit), and before each Bash or PowerShell command that holds a `git commit` or `git push`. It denies the call until Claude has written a visible `Lessons checked:` line in this turn, after its last commit or push to that repo. A turn that starts with a background task's notification carries on the turn before it. In the repo the session works in, where its `dev/lessons.mjs` is this plugin's version, Claude must also have run a lookup with it (`node dev/lessons.mjs <words>`). The denial tells Claude what to do, and Claude retries:

```
Lessons check (PLAYBOOK.md, 'The lessons check'): run `node dev/lessons.mjs <2-4 topic words>`, write a visible `Lessons checked:` line, then retry. To turn this check off: LESSONS_GATE=off (see the lessons-learned README).
```

A repo already set up is gated as soon as the plugin with the hook is installed or updated. Edits to the repo's own `LESSONS.md`, anything under `.git/`, and anything under `.claude/` but its `settings*.json` files, are never gated, and neither are subagents. In other repos the hook does nothing. It only reads: the repo's `PLAYBOOK.md` and `dev/lessons.mjs`, and the session's transcript. To turn it off, set `LESSONS_GATE=off` in the `env` of your Claude Code settings. See [SECURITY.md](https://github.com/cptjamestiberiouskirk-pixel/lessons-learned/blob/main/SECURITY.md).

## Limits

The gate is a nudge, not an enforcement boundary: a write through the shell or another tool gets past it, and so does a commit it can't see in the command (a git alias, or a script that commits). It lets a call through whenever it can't tell, and it checks that the line is there, not that it names the right lessons. Test runs are still checked by hand. The script checks only the format of the two files, not whether the check was run. In Codex there is no hook, and the lessons check is followed by hand.
