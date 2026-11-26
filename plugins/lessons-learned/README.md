# lessons-learned

A lessons-learned log and a playbook for Claude Code, kept in each repo.

Claude Code forgets a project's mistakes between sessions, so the same ones come back. This plugin sets up a small system in the repo that stops that:

- **`LESSONS.md`**: a dated log of what went wrong, why, and the rule going forward, with evidence.
- **`PLAYBOOK.md`**: checklists for the project's recurring work. Its first section, "The lessons check", is what Claude runs before each significant step: look up the lessons that apply, write a visible `Lessons checked:` line, follow the rules, and log anything that goes wrong before moving on. A lesson seen twice becomes a playbook step. Its second section, "Checking your work", says what to run and report before calling a change done: run it the way it is used, list what ran and what didn't, make a test for a fix fail before the fix, never weaken a check to pass it, and stop after three failed fixes.
- **`dev/lessons.mjs`**: finds lessons by topic and checks the format of both files. `--stale` lists lessons whose evidence names a file that is gone, or text that file no longer holds, as leads for evidence to fix, and names a file it didn't check or search. It reads and never writes. `--lint` finds rules a session may not be able to follow: files, commands and flags that aren't there, evidence another reader can't open, unsettled labels, text that reads like an injected instruction, the playbook's headings and steps, and a size budget.
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

1. Checks what the repo already has, including the same idea under other names (a `gotchas.md`, rules kept in `CLAUDE.md`) and an older copy of the script. For a script from an earlier release, it names the release and what changed since, and asks before it replaces it.
2. Changes nothing if everything is in place. Otherwise it shows a plan and waits for your go-ahead.
3. Adds only what's missing, and keeps the files out of what the repo ships (`package.json` `files`, `.npmignore`, `export-ignore` in `.gitattributes`, or the build's include list).
4. Offers two checks that run `node dev/lessons.mjs --doctor` and fail only on an error: a CI step, and a pre-commit hook in the hook manager the repo uses (or a new `.githooks/pre-commit`, which you turn on yourself). It adds each only if you name it.
5. Proves the format check catches broken entries and that the script came through intact. It doesn't commit.

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
PLAYBOOK "Changing saved state": follow its steps (2 matching lessons), section 3
-- node dev/lessons.mjs --section <number> prints a section's steps and its lessons' rules: give the section's number, never its name
-- 3 shown; 3 lessons: 1 open, 2 promoted, 0 closed
```

```
Lessons checked: "A test read the save once, right after a toast, and saw old values"; PLAYBOOK "Changing saved state"
```

`node dev/lessons.mjs --section 3` prints that section's steps, then the rule of each lesson whose Status is `promoted to PLAYBOOK "Changing saved state"`. Claude gives the number the lookup printed, never the section's name: a name is text from the repo, and a shell runs a `$(...)` in it. You can give a name yourself. A lesson's Status is what links it to its section, so a section needs no list of its lessons. Without Node, a search of `LESSONS.md` for that Status finds them.

`node dev/lessons.mjs --check` checks the format of both files: every field present and in order, real dates newest first, valid statuses, and that each promoted lesson's playbook section exists. A section's `From:` line is optional; if it has one, each lesson it names must be promoted to that section. It exits 1 on any problem, so it can run in CI.

`node dev/lessons.mjs --lint` does what `--check` does and more. It reads the rules, the playbook's steps and the rule files (`CLAUDE.md` and `AGENTS.md`, or those a `Rule files:` line in `LESSONS.md`'s header names) and reports, each with a rule ID:

- a file, command or flag a rule names that isn't in the repo (`stale-path`, `stale-flag`);
- evidence only this machine has, such as a transcript or a temp path (`unopenable-evidence`), and a rule that points at a file in your home folder (`outside-rule`);
- an `INFERRED` or `HYPOTHESIZED` label in an open lesson's What went wrong, Why or rule, with no word of an attempt to settle it (`unsettled-label`);
- text that reads like an injected instruction: a fetch piped to a shell, "ignore previous instructions", a claim of authority, text shaped like a key (`suspicious-instruction`);
- headings in `PLAYBOOK.md` that skip a level, and numbered steps there out of order (`md-heading`, `md-steps`);
- a lookup, `--all`, the whole log or a playbook section over its size budget, in tokens (`size-budget`). A `Budget:` line in the header changes the limits;
- an open lesson that a lookup with any one of the topic words in step 1 of "The lessons check" doesn't print, and a section with promoted lessons that no such lookup points to (`unreached`, a warning). If one of the topic words fits the lesson, use it in the lesson's text, or add a word for its topic to step 1. A topic word is a span in backticks with no space, at least one letter or digit, and no `-` at its start, so `node.js`, `c++` and `c#` count. A placeholder such as `<words>` doesn't. Step 1 is read as Markdown reads its list item, a nested list included, up to the first blank line or code fence. The lint hook doesn't show this one: it would name every such lesson after each edit of `LESSONS.md`.

It also reports what `--check` finds (`format`, `from-mismatch`), a bad setting (`bad-setting`), and a `lint-ignore` line that is wrong or matches nothing (`bad-ignore`, `unused-ignore`). An error exits 1; a warning doesn't. Some rules are milder for some text: a missing file named in Evidence or a rule file is a warning, and so is an unknown flag of a script other than `dev/lessons.mjs`. A finding that is wrong is silenced where it is, on a line of its own: `<!-- lint-ignore <rule>: <reason> -->`. In `LESSONS.md` the line goes after one of the entry's fields, indented, and covers the entry. Elsewhere it covers the next line that isn't blank. A finding about a header setting is fixed in the setting. `--all` lists the silenced ones too, `--json` prints one JSON object, and `--doctor` adds a summary of the whole log. It reads scripts as text and never runs them.

## Requirements

Node.js 22 or later for `dev/lessons.mjs`. It uses only Node's built-in modules. In a project without Node, setup asks whether to use it anyway or port the script.

## The lessons gate

The plugin has two hooks: the gate, here, and the lint hook, below. In a repo whose `PLAYBOOK.md` has the section "The lessons check", the gate runs before each edit (Edit, Write, MultiEdit, NotebookEdit), and before each Bash or PowerShell command that holds a `git commit` or `git push`. It denies the call until Claude has written a visible `Lessons checked:` line in this turn, after its last commit or push to that repo. A turn that starts with a background task's notification carries on the turn before it. In the repo the session works in, where its `dev/lessons.mjs` is this plugin's version or an earlier release's (0.2.0 to 0.3.1), Claude must also have run a lookup with it (`node dev/lessons.mjs <words>`). The denial tells Claude what to do, and Claude retries:

```
Lessons check (PLAYBOOK.md, 'The lessons check'): run `node dev/lessons.mjs <2-4 topic words>`, then write a short `Lessons checked:` line on its own line in your reply's text just before the call (a line in thinking or a quoted mention doesn't count), then retry. If this deny comes back after both, the line didn't reach your reply's text: write it again. To turn this check off: LESSONS_GATE=off (see the lessons-learned README).
```

A repo already set up is gated as soon as the plugin with the hook is installed or updated. Edits to the repo's own `LESSONS.md`, anything under `.git/`, and anything under `.claude/` but its `settings*.json` files, are never gated, and neither are subagents. In other repos the hook does nothing. It only reads: the repo's `PLAYBOOK.md` and `dev/lessons.mjs`, and the session's transcript. If it can't finish reading the turn within 6 seconds, it denies the call, since Claude Code runs a call whose hook its 10 second timeout ends; the next turn starts fresh. To turn it off, set `LESSONS_GATE=off` in the `env` of your Claude Code settings. See [SECURITY.md](https://github.com/cptjamestiberiouskirk-pixel/lessons-learned/blob/main/SECURITY.md).

## The lint hook

After an Edit, Write or MultiEdit of `LESSONS.md`, `PLAYBOOK.md` or a rule file that `--lint` reads (`CLAUDE.md` and `AGENTS.md` at the root, or the files a `Rule files:` line names), in a repo set up as the gate's are, a second hook (`hooks/lessons-lint.mjs`) tells Claude what `--lint` finds in that file, apart from `unreached`. It names at most 9 findings, errors first, and says how many more there are. When an Edit or MultiEdit adds a lesson, it also names the open lessons and PLAYBOOK steps whose rules the new one overlaps (the `second-sighting` and `dup-rule` leads of `--leads`), so Claude can promote the lesson instead of adding a second one. When it finds nothing, it says nothing. It never blocks the edit.

It runs the plugin's own copy of the script, imported into its own process, never the repo's `dev/lessons.mjs`, so it works whatever release's script the repo has. A Write gives it no old text, so after a Write it can't tell which lessons are new and names no leads. A write through the shell isn't seen; "The lessons check" and `--doctor` in CI still catch those. `LESSONS_GATE=off` turns it off too.

## Limits

The gate is a nudge, not an enforcement boundary: a write through the shell or another tool gets past it, and so does a commit it can't see in the command (a git alias, or a script that commits). It lets a call through whenever it can't tell, and it checks that the line is there, not that it names the right lessons. Test runs are still checked by hand. The script checks only the format of the two files, not whether the check was run. The Codex plugin ships the same two hooks, which Codex runs once you trust them (`/hooks` in the Codex CLI, Settings > Hooks in the desktop app); its README says how it differs.
