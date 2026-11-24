# LESSONS

A dated log of what went wrong while working on the lessons-learned plugin, newest first. For development only: it sits outside `plugins/lessons-learned`, so an installed plugin never includes it. When to add, promote or close an entry: `PLAYBOOK.md`, "The lessons check".

Format, checked by `node dev/lessons.mjs --check`. A field's text may go on over indented lines.

```
## YYYY-MM-DD: short title
- What went wrong:
- Why:
- Rule going forward:
- Evidence: a commit, a test, a run, the user's words, or a file and text it holds: `path/from/root`, search "text"
- Status: open | promoted to PLAYBOOK "<section>" | closed: <the test or tool that now enforces the whole rule>
```

A good entry: its rule says what to do next time, and someone who wasn't in the session can follow it. It is about this project, not general advice. Its evidence can be checked later: a commit, a test's name, or a file in backticks by its path from the repo root, with `, search "text"` for text the file holds on one line, at most 200 UTF-16 units, where an emoji counts as two (`node dev/lessons.mjs --stale` checks both). A name counts as a file only if it holds a `/` or ends in an extension that starts with a letter (`.md`, not `.7z`), and has only letters, digits, `.`, `_`, `-` and `/`: `Makefile` alone, or `app/[id]/page.tsx`, is skipped. And no open lesson covers it already: look it up first. If one does, that lesson has now been seen a second time, so promote it (`PLAYBOOK.md`, "The lessons check", step 5).

## 2026-11-24: LESSONS.md went past its budget, and Evidence was cut to fit
- What went wrong: in Q40, LESSONS.md reached its 16,000 token budget, so the Evidence of several promoted lessons was shortened, and a new lesson put it over again. The user said to raise the budget instead.
- Why: the user, from Q39's research (not recorded in this repo, not checked here): sessions read lessons through a lookup and `--section`, which keep their own budgets (2,000 and 1,500), so the whole-file budget capped a read no session makes.
- Rule going forward: never cut Evidence or close a lesson to meet the whole-file budget. In this repo, close a lesson only when a test enforces its whole rule (the user, 2026-11-24).
- Evidence: `plugins/lessons-learned/templates/lessons.mjs`, search "lessons: 24000"
- Status: open

## 2026-11-24: Template step 3 had the session put a section's name in a shell command
- What went wrong: Q41's step 3 said to run `--section "<name>"` with a PLAYBOOK heading. Codex's security review of PR 16 found that a heading like `$(touch marker)` runs in the shell first. Three review rounds missed it.
- Why: CONFIRMED by a probe: `--check` accepts such a heading, and double quotes still expand `$()`. The rounds checked the script's parsing, not what a step tells the session to type.
- Rule going forward: a step or printed hint never has a session put repo text (a heading, title or path) in a command. It gives a value the script makes safe, such as a number. A review of a new step asks what the session will type.
- Evidence: `tests/lessons.test.mjs`, search "step 3 never puts a name in a command"
- Status: open

## 2026-11-24: A fail-before run of tests/lessons.test.mjs ran the new script, so every new test passed
- What went wrong: for Q40 and Q41, a fail-before run with `LESSONS_SCRIPT` passed all 13 tests on the old script, the new ones too.
- Why: CONFIRMED: that file never read `LESSONS_SCRIPT`, unlike the other script test files, so every fail-before run of it ran the new script.
- Rule going forward: when a new test passes on the old copy, first check that the test file reads `LESSONS_SCRIPT` before trusting the result.
- Evidence: `tests/lessons.test.mjs`, search "const SCRIPT = process.env.LESSONS_SCRIPT"
- Status: open

## 2026-11-24: A fix for errors lost among leads was tested through --json, which has no print cap
- What went wrong: round 1's fix kept errors ahead of leads, and its test read `--lint --leads --json`. Round 2 found the text output, which prints 100 findings sorted by file and line, still showed no error past 100 leads.
- Why: CONFIRMED: `lintLines` caps and sorts what it prints; `--json` lists every finding, so the test could not see the cap.
- Rule going forward: a test for what a user reads checks the text output, not only `--json`, where the two differ (a cap, an order, a summary line).
- Evidence: `tests/lint.test.mjs`, search "the print cap is 100 findings"
- Status: open

## 2026-11-24: A compare against local main read a branch that was behind the release
- What went wrong: to find which version added the stale-path errors in two other repos, I ran the script from `git show main:...`. It had no `--lint`, so it printed its usage, and my count of ERROR lines read 0. I nearly reported that 0.4.0 gave none of them.
- Why: CONFIRMED: local `main` was at a5c9e5b, and `git log main..7d59289` listed the 0.4.0 release commit. This worktree never moves local `main`; `origin/main` was at 1f95a46.
- Rule going forward: to compare with a release, use its tag (`v0.4.0`), or `origin/main` after a fetch, not local `main`. Read the old run's output before counting lines in it.
- Evidence: `dev/release-state.md`, search "v0.4.0 already gives three of them"
- Status: open

## 2026-11-24: An exit code printed inside an echo was the exit of a command substitution
- What went wrong: `node ... > out; echo "$(basename "$r"): exit $?"` printed exit 0 for v0.4.0's `--lint` on a repo with errors, so `--lint` looked like it had changed its exit code.
- Why: CONFIRMED: `$?` in that line is read after `$(basename ...)` runs, so it was basename's exit. Saved right after node, the exit was 1 in all three versions.
- Rule going forward: save a command's exit code on the next statement (`e=$?`), before anything else runs, a `$(...)` in the line that prints it included.
- Evidence: in Git Bash, `false; echo "$(true) $?"` prints 0.
- Status: open

## 2026-11-24: A continue in the pairs loop skipped the reset at the loop's end
- What went wrong: to keep a promoted lesson from being paired with its own section's steps, I added a `continue` in the loop over the items `--pairs` compares. The loop zeroes `count[j]` and `sameCommand[j]` at its end, so the `continue` left them set and the item was never compared again. A new fixture listed no pairs at all, even with the cutoff at 0.
- Why: CONFIRMED by reading the loop: the reset sits at the end of the body, after the pair logic, and I didn't read past the line I changed.
- Rule going forward: before adding a `continue` or an early `return` inside a loop in `dev/lessons.mjs`, read the rest of the loop's body for state it resets or records. Skip the work with a condition instead.
- Evidence: `plugins/lessons-learned/templates/lessons.mjs`, search "Not a `continue`: count[j] and sameCommand[j] are reset below."
- Status: open

## 2026-11-24: Phase 3 was built in a second worktree this session can't edit
- What went wrong: I cut phase 3's branch into a new worktree, `q5-phase3`, so Auto-fix could still push to PR 14 here, and had a subagent build it there. When I came to tune it, the worktree hook refused every edit from this session, since the files were in another worktree. I removed the worktree and checked its branch out here, after a rebase I had to do over.
- Why: the session runs in its own isolated worktree, and its hook refuses writes to any other one. I hadn't checked that before choosing where the work would go.
- Rule going forward: a second branch is built in this session's own worktree: commit or push the first branch, then switch with a clean tree. Don't start a worktree for work this session will edit.
- Evidence: `dev/release-state.md`, search "Phase 3 was built in a subagent"
- Status: open

## 2026-11-23: A node -e edit to the lint fixture left a bare quote in a JS string
- What went wrong: for Q32 I changed the `STEP3` fixture in `tests/lint-fixtures.mjs` with a `node -e` script. The new text's backslash was lost on the way to the file, so the file no longer parsed, and the script reported "ok". Seen again on 2026-11-24 in phase 3 (a scripted edit matched nothing twice) and in Q40 (an inline `node -e` read script lost a regex backslash).
- Why: I broke "Editing files" step 1. A text replace never parses what it writes.
- Rule going forward: as "Editing files" step 1 says, text with a backslash goes through the Edit or Write tool, also for a quick edit. After any scripted edit to a `.mjs` file, import it once (`node -e "import('./<file>')"`) before going on.
- Evidence: `tests/lint-fixtures.mjs`, search "const STEP3 ="
- Status: promoted to PLAYBOOK "Editing files"

## 2026-11-23: run-live.ps1's new options were committed without running them through the script
- What went wrong: I added `-Marketplace` and `-Resume` to `run-live.ps1` after typing the same Codex commands by hand, and the commit said they were the commands that ran. Review found two bugs a single run would have shown: `-Marketplace .` was resolved after the script moved into the test repo, so it named the repo, and the cache line used `USERPROFILE`, which Linux and macOS don't set, so the script stopped before the reply.
- Why: the hand-typed run used absolute paths from the checkout, so I took the script's version as the same and checked only that it parsed.
- Rule going forward: a change to an e2e script is run through the script before it is committed, with a fake for the billed tool on `PATH` (a `codex.cmd` that prints its arguments), and once with each environment variable it reads unset.
- Evidence: `dev/e2e/run-live.ps1`, search "Codex's home is CODEX_HOME"
- Status: open

## 2026-11-23: The 0.4.0 Codex setup run tested the released plugin, not the one installed from the checkout
- What went wrong: for the 0.4.0 end-to-end run I installed the Codex plugin from this checkout with the `-c` marketplace override, then ran `run-live.ps1`. `codex exec` refreshed the GitHub marketplace when it started and put main's copy back, 26 seconds after the install. Codex built `node-app` with the old script and reported "matches the plugin fingerprint", so its reply looked like a pass.
- Why: the override covered the install commands only, and nothing checked which copy the run used. Only the fingerprint in the repo afterwards showed it.
- Rule going forward: a Codex run that tests a copy installed from here passes the same marketplace override to `codex exec` (`run-live.ps1 -Marketplace`), and the check afterwards names the plugin version the run read (the cache folder and the skill paths in its log), with the fingerprint in the repo.
- Evidence: `dev/e2e/run-live.ps1`, search "-Marketplace points"
- Status: open

## 2026-11-23: The Codex gate's command was never run in the shell Codex starts hooks with
- What went wrong: the live Codex runs found that the gate never denied. Codex runs a hook through the session's shell, pwsh here, and pwsh prints a job table before the gate's JSON, so Codex let every call through. The command had been tested only under cmd. Two paid runs went by before I read the source, and a third tested a flag the source settled.
- Why: RS-H-codexhook read the source path for a session with no shell (`%COMSPEC% /C`) and took it as the only one. The tests start the command through cmd alone.
- Rule going forward: before shipping a hook command, find in the tool's source which shell runs it on the user's machine, the branch their setup takes and not the fallback, and run the command there with a real payload, checking that stdout holds only the hook's JSON. When a live run doesn't behave, replay its real input locally before spending another run.
- Evidence: `dev/release-state.md`, search "RS-A-codexhookshell"
- Status: open

## 2026-11-23: A control run asked Codex to edit a file the test repo doesn't have
- What went wrong: the first control run for RS-H-codexlive asked Codex to edit `README.md` in `full-app`, which has none. The edit failed for that reason, and the run tested nothing.
- Why: I wrote the prompt from memory of what a repo usually holds, not from the test repo's listing.
- Rule going forward: before a billed run whose prompt names a file in a test repo, list the repo and name a file that is there.
- Evidence: `dev/e2e/make-test-repos.ps1`
- Status: open

## 2026-11-23: Allowing diff in the e2e runs did not let the session diff the template
- What went wrong: to fix RS-T-e2ediff I added `Bash(diff:*)`, `Bash(head:*)` and `Bash(wc:*)` to `run-setup.ps1`'s allow list and reran `old-script-app`. The diffs were refused again, and the paid run was spent.
- Why: release-state said adding `diff` to the list would settle it, and I took that as known. A Bash command that reads a path outside the session's folders is refused even when its command is allowed; a probe with Haiku in a scratch folder showed it, and `--add-dir` lets it through.
- Rule going forward: before changing a headless run's permissions to fix a refused call, reproduce the refusal in a cheap probe (Haiku, a scratch folder, the same flags) and check that the change lets it through. Then rerun the paid scenario.
- Evidence: `dev/e2e/run-setup.ps1`, search "--add-dir $plugin"
- Status: open

## 2026-11-22: The old-script-app test repo had held the plugin's own script since 0.3.0
- What went wrong: `make-test-repos.ps1` makes `old-script-app` by changing the script's usage line with a `Replace`. Its search text, `[--check | --all | <word>...]`, has not been in the script since 0.3.0 added `--stale`, so the `Replace` changed nothing and the repo got the plugin's own script. The scenario that should test "other version" tested a matching fingerprint for two releases. It was found while adding `release-app` in phase 1b.
- Why: a PowerShell `Replace` that finds nothing returns the text unchanged with no error, and no step checked that the fixture differed from the template.
- Rule going forward: a script that builds a test fixture by changing a template checks that each change happened (the text differs after the replace, or the search text was found) and stops if not, as `make-test-repos.ps1` now does.
- Evidence: `dev/e2e/make-test-repos.ps1`, search "the usage line to change is not in the template"
- Status: open

## 2026-11-22: A lint fixture taken from another repo kept two of its real values
- What went wrong: the user's terms for fixtures from other repos were "trimmed, neutral names", and for two of them "keep only the shape of each problem: no paths, session names or rule wording". A shape fixture for a `.jsonl` log still held the time and the CPU figure from that repo's lesson. Three comments named the source repos, and a real fixture kept a real folder name in its path. It was caught in the last read before the commit, after the fixtures had been shown as ready.
- Why: the fixture was written from the source lesson and then judged by eye. Nobody searched the source repo for the fixture's own details.
- Rule going forward: before text drawn from another repo is shown as ready or committed, search that repo for each number, time, name and path the text holds, and replace any it finds with a neutral one. Repo names go too, in comments as well.
- Evidence: `tests/lint-fixtures.mjs`, search "its last record."
- Status: open

## 2026-11-22: A scripted edit through a heredoc lost its backslashes and stopped after two of five files
- What went wrong: a node script given in a Git Bash heredoc made five replacements for the lint review fixes. Its search text held `\\n` for the two characters backslash and n, which reached node as a newline, so the third search text matched nothing. By then the first two files were written: the script checked and wrote each file in turn. The next try, a script file whose strings were `String.raw` templates, failed to parse on the backticks in them.
- Why: the "Editing files" step was not looked up before the edit, and the script wrote each file as soon as its own replacement matched.
- Rule going forward: text that holds a backslash goes into a file through the Edit or Write tool, and a scripted edit across several files checks every replacement in every file before it writes any of them.
- Evidence: `tests/lint-fixtures.mjs`, search "a lint-ignore with an empty reason"
- Status: promoted to PLAYBOOK "Editing files"

## 2026-11-22: Three Codex gate tests expected verdicts the gate's shared parser doesn't give
- What went wrong: in the first run of `tests/gate-codex.test.mjs`, 3 of 18 tests failed on inputs, not on the gate. `GIT_X=1 git commit` was expected to be no commit in PowerShell, but the shared walker skips an `X=1` word in every dialect. `cd sub && git commit` moved to a folder that doesn't exist, so no repo was found. A message of another turn was written as both records, and the response record has no `turn_id`.
- Why: each expected verdict was written from what the parser was thought to do, without running the gate on that input first.
- Rule going forward: before a gate test asserts a verdict for a new kind of input, run the gate once on that input and read why it gives that verdict. An input meant to tell two dialects apart is one whose verdict the shared walker's code shows differs between them.
- Evidence: `tests/gate-codex.test.mjs`, search "sh runs a backtick substitution; PowerShell reads a backtick as an escape."
- Status: promoted to PLAYBOOK "Quoting text that must match"

## 2026-11-22: A property test's generator made PowerShell that pwsh refuses
- What went wrong: in review round 4's fixes, the new property test for `$( )` inside PowerShell double quotes was built from pieces each checked alone. Run through pwsh 7, some of its inputs did not parse: a string holding `` `" ``, `""`, `)`, `#`, or nothing, inside a `$( )` inside double quotes. It took three changes to the generator before 40 of 40 inputs ran, in several batches.
- Why: the pieces were checked one at a time, not in the nestings the generator makes, so the test would have checked the gate against input no shell runs.
- Rule going forward: before trusting a property test that builds shell input, run a batch of its generated inputs (40 or more, more than once) in the real shell, and change the generator until every one runs as the test expects.
- Evidence: `tests/gate.test.mjs`, search "inside double quotes, so those come only in a string at the top"
- Status: open

## 2026-11-22: The case fix missed an esac written right before ) or ;;
- What went wrong: in review round 4's fixes, the first version of the gate's case tracking read the case state before the word in front of a `)` or `;` was finished. In `esac)` and `esac;;` the `esac` was still pending, so the case looked open and the `)` was taken as a pattern's end. The new tests caught it (2 failures) before the report.
- Why: the tokenizer finishes a word only at a separator, and the new branch ran before that step.
- Rule going forward: a tokenizer branch that decides on state a word can change finishes that word first, and its tests put the word right before the separator, with no space.
- Evidence: `plugins/lessons-learned/hooks/lessons-gate.mjs`, search "The word before it may be the esac that ends the case."
- Status: open

## 2026-11-22: Round 3's gate cases passed with the rule they were written for removed
- What went wrong: in review round 3's fixes, 13 of 59 mutants of the lessons gate survived the tests. Two of those had a case written for them. The case for "'@ inside a line does not close it" passed with that rule removed: the text the mutant added to the opening line opened a quote that hid the `git push` after it. The case for `Write-Host 'mail me @'` passed too: with no closer after it, the here-string was never closed and its lines were put back, so the commit was read either way.
- Why: each case was checked against the fixed gate only, and its input let another rule (a quote, the never-closed rule) decide the result. This is the second time the rule of "Two gate tests passed with the guard they were written for removed" was seen.
- Rule going forward: a test case written for one rule of a parser is run against a mutant that removes only that rule, and must fail there. Its input must not be decided by another rule too.
- Evidence: `tests/gate.test.mjs`, search "write '@' at the start of a line to close it"
- Status: promoted to PLAYBOOK "Parsing untrusted text"

## 2026-11-22: A mutant pattern written through a Git Bash heredoc lost its backslashes
- What went wrong: in review round 3, a scratch script for the growth runs was written through a quoted Git Bash heredoc. Its `hasLine-quadratic` pattern held `/[\\s>*_#-]/` in a JS string, reached the file with one backslash, and so matched nothing in the gate. The script stopped with "pattern missing or not unique", and the line was redone with the Edit tool and `String.raw`.
- Why: the PLAYBOOK "Editing files" step was not looked up for a scratch script, though it covers any file with a backslash in it.
- Rule going forward: text that holds a backslash goes into a file through the Edit or Write tool, scratch scripts included. This is the third time the rule of "Backslashes in a Git Bash heredoc were lost before the text reached the file" was seen.
- Evidence: round 3's growth-run script stopping with "hasLine-quadratic: pattern missing or not unique", then the same run after the Edit tool fix (5 of 5 fail).
- Status: promoted to PLAYBOOK "Editing files"

## 2026-11-22: A growth test passed the slow version it names in 3 of 5 runs
- What went wrong: in review round 2, two growth tests of the lessons gate passed the slow versions they were meant to catch, and were changed to time past a call the gate lets through at once (Node's start). The 20 MB transcript test then failed its slow version (`readTurn-reread`) in one run, at a ratio of 9.1, and was trusted. Review round 3 ran it 5 times against that version: it passed 3 of them (7.9 to 8.4). A gated call's own fixed cost (finding the repo, hashing its script) still diluted the growth.
- Why: each test was run once against its slow version, and a ratio just past the limit was taken as a pass.
- Rule going forward: a growth test times past the fixed cost of the path it measures (the same call on the smallest input), says in the test which slow version it fails on, and is run 5 times against that version before it is trusted: it must fail all 5, with its ratio well past the limit. This is the second time the rule of "A timing test passed on the slow script it was written to catch" was seen.
- Evidence: `tests/gate.test.mjs`, search "time: a gated call on a 31 MB transcript grows linearly from a quarter of it"
- Status: promoted to PLAYBOOK "Writing a timing test"

## 2026-11-22: A here-doc test written for a review finding passed on the old gate
- What went wrong: in review round 2's fixes, the test for "`<<` inside quotes or `$(( ))` is not a here-doc" put `git commit` on the same line as the `<<`, and the fail-before run showed it passing on the reviewed gate too: a here-doc body starts on the next line, so both gates read a commit on the `<<` line. The review's probe had the commit on the next line. With that input, the test failed on the reviewed gate and passed on the new one.
- Why: the test's input was written from the finding's summary, not copied from the probe that found it. This is the second time the rule of "A fail-before test for the BOM fix passed on the old gate" was seen.
- Rule going forward: a test for a review finding starts from the input of the probe that found it (the review's scratch scripts), and is run on the old code before it is trusted.
- Evidence: `tests/gate.test.mjs`, search "<< inside quotes or $(( )) is not a here-doc"
- Status: promoted to PLAYBOOK "Writing a test for a review finding"

## 2026-11-22: A regex written through node -e in Git Bash lost its backslash
- What went wrong: in review round 2's fixes, two changes to scratch scripts were made with a `node -e` replace run from the Bash tool. The first threw before it wrote anything. The second wrote the `\n` in a regex `[^\n]` as a line break, and the script then failed to load ("Invalid regular expression: missing /"). Both changes were then made with the Edit tool.
- Why: the loss in "Backslashes in a Git Bash heredoc were lost before the text reached the file" also hits a script given inline in a Bash tool command, and the step in PLAYBOOK "Editing files" named only a heredoc.
- Rule going forward: text that holds a backslash goes into a file through the Edit or Write tool, not through a Git Bash heredoc or a script given inline in Git Bash (`node -e`).
- Evidence: the round-2 session's change to its scratch script kill.mjs ("SyntaxError: Invalid regular expression: missing /"), then the same change made with the Edit tool.
- Status: promoted to PLAYBOOK "Editing files"

## 2026-11-22: A gate deny was marked as a permission rule in the transcript
- What went wrong: in the wake-up e2e run (session 021bca86-ff9e-40d2-978e-519cfa7e9a87), the Write the lessons gate denied got `toolDenialKind: "permission-rule"` on its tool result, not a value naming a hook. The round's notes had listed a hook kind among the values.
- Why: the list of values was read from a survey of past transcripts, not from a run of this hook.
- Rule going forward: code that reads `toolDenialKind` treats any non-empty value as a call that never ran, and never branches on which value it is.
- Evidence: `plugins/lessons-learned/hooks/lessons-gate.mjs`, search "const refused = typeof r.toolDenialKind === 'string' && r.toolDenialKind !== '';"
- Status: open

## 2026-11-22: Two gate tests passed with the guard they were written for removed
- What went wrong: in the round-1 mutant run, removing the PowerShell here-string rule and the `--git-dir` rule left every test passing. The here-string test's body had no quote in it, so the single-quote rule already hid it; the `--git-dir` test also passed `--work-tree`, which found the repo by itself.
- Why: each case was checked only against the fixed gate, not against the gate with that one rule taken out.
- Rule going forward: a test case written for one rule of a parser is run against a mutant that removes only that rule, and must fail there. Its input must not be decided by another rule too.
- Evidence: `tests/gate.test.mjs`, search "here-string with a quote in it"
- Status: promoted to PLAYBOOK "Parsing untrusted text"

## 2026-11-22: The gate's time-budget test kept a limit in milliseconds, against an open lesson that said to compare growth
- What went wrong: the lessons gate's time-budget test asserted a gated call under 400 ms and an ungated one under 100 ms. First as wall time, where it failed at 214 ms on a busy machine; then past Node's start, as the p95 of 12 samples. Review round 1 found that version failing 3 of 3 runs with 16 busy cores: with 12 samples the p95 is the largest one, and the WSL ungated time of 98 ms sat 2 ms under its limit.
- Why: the limits came from the plan, and the open lesson "A timing test with a limit in seconds failed on a busy machine" was not looked up with the word `time` before the test was written. The fix after the first failure kept a fixed limit.
- Rule going forward: a timing test compares growth: it times the full input and a quarter of it, and fails when the full run takes more than 8 times as long. A budget in milliseconds is measured and recorded in `dev/release-state.md`, not asserted. This is the second time the rule of "A timing test with a limit in seconds failed on a busy machine" was seen.
- Evidence: `tests/gate.test.mjs`, search "time: a gated call on a 31 MB transcript grows linearly from a quarter of it" (the test was renamed in review round 3)
- Status: promoted to PLAYBOOK "Writing a timing test"

## 2026-11-22: Two lessons logged in the gate work were second sightings of open lessons
- What went wrong: "A gate test started its child with spawn..." and "Node's own start on a busy Windows machine..." were each logged as a new open lesson. Each repeated an open lesson's rule ("A test's child process hung in CI", "A timing test with a limit in seconds failed on a busy machine"), so each should have promoted that lesson (PLAYBOOK.md, "The lessons check", step 5). Review round 1 found the first; the second was found while fixing it.
- Why: the new entries were written from what had just happened, without a lookup for the words of their own rules.
- Rule going forward: before adding a lesson, run `node dev/lessons.mjs` with two to four words from its rule. If an open lesson's rule covers it, promote that lesson as step 5 says, instead of adding a new open one.
- Evidence: `PLAYBOOK.md`, search "## Starting a child process in a test"
- Status: promoted to PLAYBOOK "The lessons check"

## 2026-11-22: A fail-before test for the BOM fix passed on the old gate
- What went wrong: the test for "a PLAYBOOK.md with a BOM goes ungated" put the BOM before the template's first line, `# PLAYBOOK`, so the heading was on a later line and the old gate found it too. The fail-before run showed it passing on both versions. With the heading as the first line after the BOM, as the review's probe had it, it failed on the old gate and passed on the new.
- Why: the test's input was written from the finding's one-line summary, not copied from the probe that found it.
- Rule going forward: a test for a review finding starts from the input of the probe that found it (the review's scratch scripts), and is run on the old code before it is trusted.
- Evidence: `tests/gate.test.mjs`, search "a BOM before the heading"
- Status: promoted to PLAYBOOK "Writing a test for a review finding"

## 2026-11-21: Two ways to see which node.exe the gate ran showed nothing
- What went wrong: to settle whether the hook runs a `node.exe` planted in the repo, a copy of `hostname.exe` was planted as a marker, and then copies of five other System32 tools were tried; none of them would run outside System32 on this machine ("Permission denied"). A process-list poller then ran beside a billed turn of three gated calls and logged no gate process at all, though a dry run had caught 4 of 5 runs of 200 ms. Two billed runs were spent before a third settled it.
- Why: the tests leaned on a marker program and on catching a short-lived process, and neither was tried in the way the live run would use it before the billed run.
- Rule going forward: to test whether a hook runs a planted program, plant a file under that name that can't run (plain text), and compare the hook's answer with a control run: a planted file that runs would fail and change the answer. Try any marker outside the billed run first, in the same folder, the same way the hook would start it.
- Evidence: `dev/release-state.md`, search "a text file named `node.exe` in its root"
- Status: open

## 2026-11-21: A gate test started its child with spawn from node:child_process, and hung on a mutant
- What went wrong: the lessons gate's polling test started the hook with `spawn` straight from `node:child_process` and listened for its exit only after a 120 ms wait. A mutant that exits at once closed before the listener was attached, and the test waited for over four minutes with no limit, until it was killed by hand. The open lesson "A test's child process hung in CI, and the log named no test" already said not to start a child that way; its lookup was not run with the words `child` or `spawn` before the test was written.
- Why: `tests/child.mjs` had only a `spawnSync`, and a test that must write to the transcript while the hook runs needs an async child, so the rule was set aside without saying so.
- Rule going forward: a test that needs an async child uses the `spawn` that `tests/child.mjs` exports, which listens for the exit at once and kills the child after 60 seconds. This is the second time the rule of "A test's child process hung in CI" was seen.
- Evidence: `tests/child.mjs`, search "spawn, for a test that must act while the child runs"
- Status: promoted to PLAYBOOK "Starting a child process in a test"

## 2026-11-21: Node's own start on a busy Windows machine was over the gate's 100 ms budget
- What went wrong: the lessons gate's time-budget test asked for an ungated call under 100 ms p95, timed from spawn to exit. It failed at 214 ms. A plain `node -e 0` on the same machine took 90 to 445 ms (median about 120 ms), so the hook added only 20 to 30 ms.
- Why: the budget was written as wall time, which counts Node's start, and on Windows under load that start alone can pass 100 ms.
- Rule going forward: a time-budget test for a script started as its own process takes Node's start off its runs (the p95 of `node -e 0` runs taken in between, off the p95 of its runs), and prints the wall time beside it.
- Evidence: `tests/gate.test.mjs`, search "Node's own start is taken off"
- Status: closed: its rule kept a fixed limit in milliseconds, which review round 1 found failing 3 of 3 runs under load; PLAYBOOK "Writing a timing test" replaces it

## 2026-11-21: The Edit tool could not match a line holding both a unicode escape and a literal accented letter
- What went wrong: an Edit of one line in `tests/gate.test.mjs` that held two unicode escapes and a literal accented letter failed twice with "String to replace not found". Its note showed the line with an escape swapped for the character, though the file held the escape as ASCII (checked with `od -c`). A fix through a Git Bash `node -e` then failed too, its backslashes lost, as "Editing files" says they would be.
- Why: the Edit tool swaps unicode escapes and their characters when it matches, so a line with both forms matched neither way.
- Rule going forward: to change a line that holds a unicode escape, write a small script with the Write tool that builds the backslash with `String.fromCharCode(92)`, and replace the text in it at byte level. Then scan the file for non-ASCII characters.
- Evidence: `tests/gate.test.mjs`, search "String.fromCodePoint(0x2028)"
- Status: open

## 2026-11-21: The lessons gate plan assumed the current tool call is in the transcript when PreToolUse fires
- What went wrong: the plan for a PreToolUse hook that checks for the `Lessons checked:` line allowed any call whose own tool_use_id was not yet in the transcript, on the guess that this would be rare. A probe hook in two headless runs (sessions fa8bae8f-bf99-4ab5-81c7-85449fd30ace and d6359e4d-e0ba-4994-9ee7-500b48874765) read the transcript at once on 10 main-thread calls: the call was there on 1. Polling every 10 ms, it and the text before it showed up 24 to 75 ms later on all 10. So the gate would have let 9 of 10 calls through unchecked, and the work stopped before any gate was built.
- Why: Claude Code writes the transcript asynchronously, and the hook starts before the current message is on disk. The plan named this as an open question but built the design on the hoped-for answer.
- Rule going forward: before designing a hook that reads the transcript, run a probe hook in a headless run (`dev/e2e/run-live.ps1`) and measure what is on disk when it fires, on at least ten calls. Build on the measured answer, not the hoped-for one.
- Evidence: the two probe runs of 2026-11-21 above. In the same runs, a subagent's payload had agent_id and the parent's transcript_path, and that file never held the subagent's own call, which was in the session's subagents folder.
- Status: open

## 2026-11-18: The CHANGELOG named the script's message for cases that were never run, twice in one release
- What went wrong: 0.3.1's CHANGELOG said a symbolic link swapped in gives "changed while it was read"; on Linux and macOS it gives "cannot read" (review round 1). After that fix, a rewording said a file that is "grown" is not read and gives "changed"; a file grown before the open is read, and one grown past the cap gives "is over ... bytes" (review round 3).
- Why: each sentence was written from what the code was meant to do for a group of cases, and only one case of the group had been run.
- Rule going forward: a doc sentence that says what the script prints, or whether it reads a file, names only cases that were run, and quotes each message from that run's output.
- Evidence: `CHANGELOG.md`, search "is refused as over it"
- Status: promoted to PLAYBOOK "Quoting text that must match"

## 2026-11-18: A fail-before copy of the repo was made from the working tree, so it ran the new skills
- What went wrong: to run the new `..` test against 0.3.0's copy command, a copy of the repo was made with `git ls-files` and `tar`, which copy the working tree. The test passed there, on the new skills. A `grep` for the new check in the copy showed it; the run was redone with the two skills from `git show HEAD:<path>`, checked with `git hash-object`, and then the test failed as it should.
- Why: "Running a test against old code" says to check the copy's hash, and that step was skipped because the copy was of the whole repo, not one file.
- Rule going forward: in a copy of the repo made for a fail-before run, every file the fix changed comes from `git show <rev>:<path>` and is checked with `git hash-object` against `git rev-parse <rev>:<path>` before the run.
- Evidence: `tests/codex.test.mjs`, search "the copy command refuses a relative target that climbs out of the repo with .."
- Status: promoted to PLAYBOOK "Running a test against old code"

## 2026-11-17: A commit's Verified line was written from memory, and said --stale listed nothing it did list
- What went wrong: the commit that promoted "Testing on more than one system" said `--stale` gave "none for these lessons' sections". The `--stale` output run just before it listed the Linux lesson, for its scratch file. The message was amended before any push.
- Why: the Verified line was written from what the check was expected to show, not copied from what it printed, the same mistake as "A new lesson quoted its evidence from memory", in a commit message.
- Rule going forward: a commit's Verified line states each check's result as its output printed it, read again while writing the line.
- Evidence: commit 41d3148, amended as 87860c4, which says "one is the Linux lesson's scratch file".
- Status: promoted to PLAYBOOK "Quoting text that must match"

## 2026-11-17: A test's child process hung in CI, and the log named no test
- What went wrong: on PR 2's first CI run, a child process started by `tests/hardening.test.mjs` never exited on ubuntu Node 24. The job waited until its 10-minute limit cancelled it, and the log named no test, because `node --test` prints a file's results only when the file ends. A rerun passed in 11 s, and 60 local runs on Node 18 and 26 did not hang, so the cause was not found.
- Why: the tests called `spawnSync` with no time limit, so one stuck child held its file until the job limit, with nothing to say which test it was.
- Rule going forward: a test starts a child process through the `spawnSync` that `tests/child.mjs` exports, never straight from `node:child_process`. It kills the child after 60 seconds and fails the test with the command named.
- Evidence: `tests/child.mjs`, search "A child process that never exits"; commit c5e46ae.
- Status: promoted to PLAYBOOK "Starting a child process in a test"

## 2026-11-17: A new lesson quoted its evidence from memory, and --stale flagged it the day it was written
- What went wrong: the exFAT lesson's evidence quoted a test name as "a rename changes a file's ID (exFAT)". The test name is in single quotes, so the file holds `file\'s`, and the search text never matched. Review round 5 found it with `--stale`.
- Why: the search text was typed from the test's meaning, not copied from the file, and `--stale` was not run after the entry was added.
- Rule going forward: copy an evidence search text from the file itself, and after adding or changing a lesson's Evidence, run `node dev/lessons.mjs --stale` and check it lists no lead for that lesson.
- Evidence: `dev/release-state.md`, search "the new lesson's evidence quotes".
- Status: promoted to PLAYBOOK "Quoting text that must match"

## 2026-11-17: The copy's end check assumed a rename keeps a file's ID, and failed every copy on exFAT
- What went wrong: the copy command falls back to a rename where a hard link fails, and its docs name a FAT drive as one such place. Its last check compared the target's ID with the ID it read from its file before the move. exFAT has no hard links, and a rename there changes a file's ID, so every copy on an exFAT drive failed with "is not the file this copy wrote", though the file was right. Another session found it with a test run on an exFAT disk.
- Why: the fallback was probed only where hard links are refused on NTFS (the Codex sandbox), where a rename keeps the ID. The FAT case was written down as a reason for the fallback but never run.
- Rule going forward: a path the code takes for a named file system or platform is run there before it ships: for the copy, an exFAT drive (a virtual disk) with the repo and `TEMP` on it. A check that compares file IDs across a move reads the moved file's ID after the move, from a handle it holds. This widens the probe rule in "A create-only write was trusted to refuse a link".
- Evidence: `tests/codex.test.mjs`, search "the copy renames the file into place and accepts it".
- Status: promoted to PLAYBOOK "Testing on more than one system"

## 2026-11-17: Counting the search limit in code points let text past V8's slow-search threshold
- What went wrong: round 1 capped --stale's search text at 200 to keep the search fast. Round 2 made the cap count code points, as the docs say, which lets up to 400 UTF-16 units through. V8's `includes` can turn about 100 times slower per search once the pattern is longer than about 250 units (it did for emoji), so 100 searches of 200 emoji on 1 MB took 5.7 s, against 0.4 s for the worst case under the old cap.
- Why: the change was checked for what it counts, not for the cost the cap was there to bound, and no test timed the case at the new limit.
- Rule going forward: a change to a limit that bounds a cost is tested at the new limit for that cost: time the worst input the new limit lets through, and compare it with the old limit's worst.
- Evidence: `dev/release-state.md`, search "V8's slow substring search".
- Status: open

## 2026-11-17: A real-path check folded the whole path with toLowerCase, and let a Kelvin-sign folder through
- What went wrong: round 1's fix for --stale compared real paths after `toLowerCase` on Windows and macOS, as the 0.2.1 copy does. Review round 2 put the repo under `kit` and a junction to a volume path into `Kit` spelled with the Kelvin sign (U+212A) beside it. `toLowerCase` makes both `kit`, NTFS keeps them apart, and the script searched the outside file.
- Why: the fold was copied from the copy command, which had passed its own review rounds, without asking whether Unicode case folding matches what the file system treats as one name.
- Rule going forward: a real-path check compares the repo's real path exactly (both sides come from the same `realpathSync.native` call), and folds only ASCII case in the rest, which comes from a name of ASCII characters. Never fold a whole path with `toLowerCase`.
- Evidence: `dev/lessons.mjs`, search "full case folding"; `tests/stale.test.mjs`, search "only by Unicode case"; `dev/release-state.md`, search "the Kelvin sign".
- Status: promoted to PLAYBOOK "Walking a path in the repo"

## 2026-11-17: --stale followed a junction to a volume path, the class 0.2.1 had already fixed in the copy
- What went wrong: 0.3.0's `--stale` refused a link on the way to a file by `lstat` alone. Review round 1 planted a junction to a volume path at `docs`, which `lstat` reports as a plain folder, and the script searched a file outside the repo and printed whether it held the quoted text. 0.2.1 review round 8 had found the same in the copy command, and fixed it there with a real-path check, but no lesson was logged, so the new walk was written without it.
- Why: a fix to one piece of code was not turned into a rule for the next code that walks a path.
- Rule going forward: code that refuses a link on a path in the repo also checks that the path's real path (`realpathSync.native`) is the repo's real path plus the name, with case folded only on Windows and macOS, since `lstat` calls a junction to a volume path a plain folder. Its tests make such a junction with `mklink /J` to the volume path `mountvol` prints.
- Evidence: `tests/stale.test.mjs`, search "which lstat calls a folder".
- Status: promoted to PLAYBOOK "Walking a path in the repo"

## 2026-11-17: A test asserted the cut marker's format from memory, and failed on the fixed script
- What went wrong: a new test for a long file name expected `[cut: N more characters]` right after the name, but the script puts a space before it. The test failed on both the old and the fixed script, and only reading the actual output showed why.
- Why: the expected format was written from memory, not copied from the script's output.
- Rule going forward: before asserting on the script's output in a test, run the script on the test's input once and copy the format from what it printed.
- Evidence: `tests/stale.test.mjs`, search "cuts a long name short".
- Status: promoted to PLAYBOOK "Quoting text that must match"

## 2026-11-17: Mutant runs against files that were never written looked like six caught mutants
- What went wrong: a `node -e` mutant generator inside Git Bash failed on its quoting and wrote no files. The loop that followed ran the stale tests with `LESSONS_SCRIPT` set to each missing path, and every run showed 8 of 8 failing, the same as a mutant caught by every test.
- Why: the loop didn't check that each mutant file existed, and a missing script fails every test the same way a broken one does.
- Rule going forward: write a mutant or copy generator as a script file, not nested quotes in `node -e`, and check each mutant exists and differs from the original before reading its test results. A mutant should fail the one test written for its guard, not all of them.
- Evidence: the 0.3.0 session: the "Expected ',', got 'string literal'" error above six "fail 8" lines; rerun from a script file, each mutant failed only its own test. Seen again 2026-11-24: a variant of the script built through `node -e` put an import above the shebang, and every run failed with a SyntaxError; rebuilt from a script file.
- Status: promoted to PLAYBOOK "Running a test against old code"

## 2026-11-17: A scripted edit across four files wrote three before it found the fourth didn't match
- What went wrong: a node script replaced text in both playbook templates and in this repo's own `PLAYBOOK.md` and `LESSONS.md`. It wrote the first three, then stopped on the repo's `LESSONS.md`, which has no "Entries go below this line" sentence. An earlier script for the two setup skills expected a line in both word orders, which each skill holds only one of.
- Why: the script checked and wrote each file in turn, and assumed this repo's own files and the two skills hold the same text as the template where they differ.
- Rule going forward: a scripted edit across several files checks every replacement in every file before it writes any of them, and this repo's `LESSONS.md`, `PLAYBOOK.md` and the two skills are each checked for the text, not assumed to match the template.
- Evidence: the 0.3.0 session: the "MISSING in LESSONS.md" stop, after three files were written; `LESSONS.md` has no "Entries go below this line".
- Status: promoted to PLAYBOOK "Editing files"

## 2026-11-17: Two tests that passed on Windows failed on Linux, found only by a reviewer's WSL probe
- What went wrong: for eleven review rounds of 0.2.1 every test ran on Windows only. A reviewer used WSL for a probe; running the suite there then showed two failures that CI (ubuntu, windows and macOS) would have shown only after a push. The copy command's end check passed a swapped-in file, because the random-name file's handle was closed and Linux gave the next new file the same inode number. The heap test's 96 MB limit was too little for the new script on Node 18, which needs 128 MB (Node 26 needs 40).
- Why: I ran `node --test` and the release check on this Windows machine only, and took one machine's numbers (inode behavior, heap use) as the code's.
- Rule going forward: before a release commit, also run `node --test` under WSL (Linux) from a copy on its own file system. A test that measures a resource (heap, time) gets its limit from runs on more than one Node version and OS, with room on both sides.
- Evidence: the 0.2.1 work: `not ok 35 - the copy command fails when its random-name file is replaced by another plain file before the fallback rename` under WSL, and a heap probe: 128 MB on Node 18, 40 MB on Node 26.
- Status: promoted to PLAYBOOK "Testing on more than one system"

## 2026-11-17: Review rounds re-reviewed the whole release instead of the diff since the last round
- What went wrong: rounds 6 to 9 of the 0.2.1 review each had a fresh reviewer look at the whole diff from 643dcdd, not at the previous round's fixes. Each round found something new in that large surface, so the stop rule was never near. A reviewer quoted REVIEW.md's "Rounds" section back, which I had not read for this release.
- Why: I wrote each round's brief from the one before it, not from REVIEW.md, and only read REVIEW.md's file path into the brief for the reviewer to follow.
- Rule going forward: before writing a review round's brief, read REVIEW.md's "Rounds" section and scope the round to the diff since the last reviewed state; save that state (a copy of the changed folders and docs) before applying each round's fixes, so the next round can diff against it, and run fail-before checks in another copy, never in that one.
- Evidence: the 0.2.1 session's briefs for rounds 6 to 9 ("the uncommitted diff from commit 643dcdd to the working tree" in each) and round 10's, scoped to round 9's fixes; REVIEW.md on main, "Each round reviews the diff since the last reviewed state".
- Status: promoted to PLAYBOOK "Running a review round"

## 2026-11-17: Backslashes in a Git Bash heredoc were lost before the text reached the file
- What went wrong: an edit script for 0.2.1, written through a quoted Git Bash heredoc (`<<'EOF'`), searched for a test line holding `/staged\.md/` and found nothing: the script Node read had lost a backslash. The 0.2.0 work hit the same loss in a RegExp template, fixed then with the Edit tool and `String.raw`, but logged no lesson.
- Why: in this environment a doubled backslash in a Bash tool heredoc reaches the file as one, even when the heredoc is quoted; a single backslash before an ordinary character is kept. Tried: `one:\. two:\\. four:\\\\.` came out as `one:\. two:\. four:\\.` (`od -c`). The script had `\\.` inside a JS string, so it reached Node as `\.`, which JS reads as a plain `.`.
- Rule going forward: text that holds a backslash (a regex, an escape, a Windows path) goes into a file through the Edit or Write tool, not through a Git Bash heredoc.
- Evidence: the 0.2.1 session's round 1 fix script ("0 matches", the backslash gone), then the same change made with the Edit tool.
- Status: promoted to PLAYBOOK "Editing files"

## 2026-11-17: A command meant to run one billed setup run held a leftover call to another
- What went wrong: the command for the second Claude Code end-to-end run of 0.2.1 began with leftovers from an earlier draft: a `run-setup.ps1` call on a repo path that didn't exist, and a copy and delete that did nothing. The stray call failed before starting a session, so nothing was billed or changed.
- Why: I built the command by editing an earlier one in place and didn't read it through before running it.
- Rule going forward: before running a command that calls a billed script (`run-setup.ps1`, `run-live.ps1`), read the whole command through, and write it fresh rather than editing an earlier draft.
- Evidence: the 0.2.1 session's call that made `e2e021d-claude`; no session folder exists for the stray path.
- Status: open

## 2026-11-17: A create-only write was trusted to refuse a link, and on Windows it follows one
- What went wrong: the 0.2.0 copy command relied on a create-only write (`flag: 'wx'`) as its last guard against a link made after its check, and `dev/release-state.md` said only a link made in that instant would get through. A probe for 0.2.1 showed more on Windows: the write follows a dangling file symbolic link and writes the text where it points, and a dangling junction makes it create an empty folder where the junction points.
- Why: on Linux and macOS, `O_CREAT | O_EXCL` fails on any link at the name. Windows has no such rule for `CREATE_NEW`: it follows the link, so "create only" holds for the target, not for the name.
- Rule going forward: to create a file at a name where a link may appear, write it under a random name beside it and give it the name with a hard link (`linkSync`), which fails on anything at the name and follows nothing. Where the hard link fails for any other reason (Codex's Windows sandbox refuses it with `EPERM`), rename it into place, which replaces the name and writes through nothing. Probe a guard's behavior on Windows, and in the Codex sandbox, before relying on it.
- Evidence: the 0.2.1 probes (a dangling file link: the text written at the target; `linkSync` over a link: `EEXIST`), and `tests/codex.test.mjs`, search "refuses a dangling junction at the target".
- Status: promoted to PLAYBOOK "Testing on more than one system"

## 2026-11-16: A growth test was claimed to guard a cost that an output cap keeps linear
- What went wrong: I said the 4 MB title test guarded the change that cuts a title once for all its problem messages. Review round 6 showed it passed on the script before that change, and on a mutant that cut the title again in each message.
- Why: `--check` prints at most 50 problems, so cutting the title in each one costs at most 50 walks of it. That grows with the title, linearly, so full against a quarter grows about 4 times either way, and a growth test cannot tell them apart.
- Rule going forward: when an output cap bounds how often a cost repeats, test it by holding the input the same and changing only the repeat count (50 messages against 1), and run that test on the old version before saying it guards the change.
- Evidence: `tests/hardening.test.mjs`, "a 9 MB title named in 50 problem messages costs about what one message costs": 750 ms against 100 ms on the round-5 script, 1245 ms against 205 ms on the mutant; review round 6 in `dev/release-state.md`.
- Status: promoted to PLAYBOOK "Writing a timing test"

## 2026-11-16: A timing test with a limit in seconds failed on a busy machine
- What went wrong: the 4 MB title test failed at 10 to 14 seconds against a 10-second limit. The current script, the round-5 script and the round-6 script all took about 14 seconds on that input, so nothing had regressed: other processes were loading the machine.
- Why: a fixed limit in seconds measures the machine as much as the script. A limit wide enough for any load would also let a slow script pass.
- Rule going forward: a timing test compares growth, not seconds: it times the full input and a quarter of it, and fails when the full run takes more than 8 times as long (linear work grows about 4 times, quadratic about 16).
- Evidence: `tests/hardening.test.mjs`, the `growth` helper and its four tests, which pass under the same load and fail on the slow scripts they were written for.
- Status: promoted to PLAYBOOK "Writing a timing test"

## 2026-11-16: A rule holding U+2028 was read as a broken field
- What went wrong: the first run of the new property tests found rules that `--check` called "missing or empty" and "not a field", though each had its `- Rule going forward:` line. The lookup printed them as empty rules. Unit tests had never put a line separator inside a field.
- Why: in a JavaScript regex, `.` doesn't match U+2028 or U+2029, which it treats as line ends. The field and heading patterns end in `(.*)$`, so a line holding one never matched.
- Rule going forward: a regex that must match a whole line of untrusted text uses the `s` flag (or `[^]`), and a new parsing rule gets a property test with random text, not only examples.
- Evidence: `tests/hardening.test.mjs`, search "a line separator (U+2028) in a rule is reported as hidden". Seen again in 0.3.0, in the `--stale` parser: `tests/stale.test.mjs`, search "property: --stale reports the file names a plain parser finds".
- Status: promoted to PLAYBOOK "Parsing untrusted text"

## 2026-11-16: A timing test passed on the slow script it was written to catch
- What went wrong: the first version of the `From:` timing test passed on the round-3 script, which round 3 had shown takes 24 seconds on such input. The test used keys of different lengths.
- Why: comparing two strings of different lengths stops at once, so the quadratic scan cost almost nothing per step. Only keys of one length that differ at the end make each comparison run long.
- Rule going forward: run a new timing test against the slow version before trusting it, and build its input so every step of the slow path does real work.
- Evidence: `tests/hardening.test.mjs`, "a From: line naming 100,000 lessons": 1.5 s on the round-3 script with the first input, 23.8 s with keys of one length.
- Status: promoted to PLAYBOOK "Writing a timing test"

## 2026-11-16: A PowerShell replacement list dropped the text after a + in each pair
- What went wrong: a batch of text replacements written as `@( ,@('old', 'new' + "`n" + 'more') )` replaced each old text with only the part before the first `+`. A table row in SECURITY.md lost its end and merged with the next row, two bullets were dropped, and two script edits never landed. The loop reported no missing anchor.
- Why: in PowerShell the comma binds tighter than `+`, so `'a', 'b' + 'c'` is the array `'a', 'b'` with `'c'` added as a third item. The pair's second item was only `'b'`.
- Rule going forward: in a PowerShell array of replacement pairs, wrap a joined item in parentheses (`@('old', ('new' + "`n" + 'more'))`) or write it as one here-string, and read each changed file back before going on.
- Evidence: the 0.2.0 session: SECURITY.md held the `node` row and the `dev/lessons.mjs` row on one line; the hard-link and `byKey` edits to `plugins/lessons-learned/templates/lessons.mjs` were missing until redone with parentheses.
- Status: open

## 2026-11-16: A setup run wrote the script's BOM escape as the character itself
- What went wrong: in the first live run next to Trailmark, setup wrote `templates/lessons.mjs` with the Write tool, and the `\uFEFF` in the BOM check became a literal U+FEFF. The fingerprint didn't match until that session found the character and fixed it. Later a PowerShell command of mine that held the same escape was refused for holding U+FEFF.
- Why: text passed through a tool call is JSON, where a single-backslash unicode escape is read as the character. Any agent that writes the template out can do this, not only the Edit tool.
- Rule going forward: the templates and skills hold no single-backslash unicode escape: match an invisible character by its code (`charCodeAt(0) === 0xfeff`) or a property class (`\p{Cf}`). A test checks the shipped files.
- Evidence: `tests/hardening.test.mjs`, search "hold no single-backslash unicode escape".
- Status: promoted to PLAYBOOK "Changing the setup skill or templates"

## 2026-11-16: A fail-before run used a copy of the old script that was one line long
- What went wrong: to show the new hardening tests fail on the old script, `git show HEAD:<script> | Set-Content -NoNewline <file>` made the old copy. Its lines were joined with no separator, so everything after the first `//` was a comment and the copy did nothing. The run reported 8 failures, which looked right but proved nothing; a guard test that should pass on both versions failing gave it away.
- Why: in PowerShell, a native program's output reaches `Set-Content` as separate lines, and `-NoNewline` drops the line breaks between them, not only the last one.
- Rule going forward: copy an old version of a file with a byte-exact redirect (`cmd /c "git show <rev>:<path> > <file>"`), and check the copy with `git hash-object <file>` against `git rev-parse <rev>:<path>` before using it.
- Evidence: the 0.2.0 hardening session's second fail-before run, with a copy whose hash matched the blob. Seen again in the round-5 timing check of the v0.1.0 copy.
- Status: promoted to PLAYBOOK "Running a test against old code"

## 2026-11-16: The Edit tool wrote a \uFEFF escape into the script as a literal BOM
- What went wrong: an edit to `templates/lessons.mjs` meant to add `.replace(/^\uFEFF/, '')` left an invisible U+FEFF character between `^` and `/` instead of the six-character escape. The code still worked, but it hid a character in the source of a change about hidden characters.
- Why: the Edit tool turned `\uFEFF` in the new text into the character itself, in the script and in this entry too (three times). `\x00`-style escapes and doubled-backslash `\\u0000` came through as text.
- Rule going forward: after an edit whose text holds a `\u` escape, in any file, scan the file for non-ASCII characters (`[^\x00-\x7F]`). Write a regex escape for an invisible character with a doubled backslash inside a string (`new RegExp('\\uFEFF')`), or fix it with a byte-level replace.
- Evidence: the 0.2.0 hardening session: a scan found 1 literal U+FEFF in `plugins/lessons-learned/templates/lessons.mjs`; after the replace, 0 non-ASCII characters.
- Status: promoted to PLAYBOOK "Changing the setup skill or templates"

## 2026-11-16: CI ran the tests with a folder argument, and Node 22 read it as a module
- What went wrong: the first CI run (43957308380) failed on Node 22 on all three systems with "Cannot find module '.../tests'", while Node 20 passed. Locally, `node --test tests/` had passed on Node 26.
- Why: CONFIRMED from the log (`gh run view 43957308380 --log-failed`, read again 2026-11-22: on Node 22, on Windows and on macOS, `node --test tests/` printed "Cannot find module" for the `tests` folder): Node 22 took the `tests/` argument as a module to load, not a folder to search. How `--test` reads its arguments differs between Node versions.
- Rule going forward: run the tests with `node --test` and no path argument. It finds `*.test.mjs` files the same way on every version CI uses.
- Evidence: `gh run view 43957308380 --log-failed`; after 52e4438, run 43957556091 passed all six jobs (three systems, Node 22 and 24).
- Status: open

## 2026-11-16: Listing a git archive through a pipe in PowerShell ran past the 2-minute limit
- What went wrong: `git archive $tree | tar -t` in the PowerShell tool ran past the 2-minute limit and was moved to the background, though the archive has 20 entries. The same listing through a file (`git archive -o <file>`, then `tar -tf <file>`) took 176 ms.
- Why: HYPOTHESIZED: the pipe between the two native programs in pwsh 7.7. On 2026-11-22, `git archive HEAD | tar -t` in pwsh 7.7.0 took 0.11 s, so the hang did not reproduce, and the cause is still not known.
- Rule going forward: in the PowerShell tool, list an archive through a temp file, not a pipe.
- Evidence: the MVP session, 2026-11-16: the backgrounded call, then the timed file-based listing.
- Status: open

## 2026-11-16: A shell copy out of the plugin folder was refused
- What went wrong: a change to the setup skill told it to copy the templates with `cp` or `Copy-Item`. Its end-to-end run refused both as an edit of a "sensitive file", and the session stopped with nothing set up. The change had been made without an end-to-end run.
- Why: the plugin folder is outside the repo being set up, and Claude Code's permission check asks for approval for any shell command that touches it, even one that only reads. The Read tool reads there without asking.
- Rule going forward: the setup skill brings templates in with the Read and Write tools, never with a shell command on the plugin folder. A change to the setup skill or the templates gets an end-to-end run on a fresh test repo before it is committed.
- Evidence: fc61131 ("Setup writes templates out and checks the script's fingerprint"); the run's refusal "requested permissions to edit ... templates\LESSONS.md which is a sensitive file".
- Status: promoted to PLAYBOOK "Changing the setup skill or templates"

## 2026-11-16: A setup run's copy of the script differed from the template only in line endings
- What went wrong: after the first end-to-end run of setup, a byte compare of the run's `dev/lessons.mjs` with the template failed: 8,485 bytes with no CRLF against 8,683 bytes with 198. The text was the same.
- Why: the template was a byte copy of Deep Belt's script, whose checkout had CRLF from `core.autocrlf=true`, and this repo had no `.gitattributes`. The setup session wrote the file with LF.
- Rule going forward: compare a copy of the script with its template with line endings ignored, as the setup skill's fingerprint does. Text files here are LF in every checkout (`.gitattributes`).
- Evidence: `.gitattributes`, search "eol=lf"; `plugins/lessons-learned/skills/setup/SKILL.md`, search "line endings ignored".
- Status: open

## 2026-11-16: A commit message passed with -F - in PowerShell was read as a path
- What went wrong: the first commit, run in the PowerShell tool as `git commit -F - @'...'@`, failed with "pathspec 'Add the lessons-learned plugin ...' did not match any file(s)" and committed nothing.
- Why: `-F -` reads the message from stdin, and PowerShell passed the here-string as one more argument, not as stdin.
- Rule going forward: in the PowerShell tool, give a commit message with `-m @'...'@`.
- Evidence: the session that made 2f94516: the failed call, then the same message with `-m`, which made the commit. Seen again at the 0.2.0 commit (855302b), made after the same failure, when the lessons check was skipped before the commit.
- Status: promoted to PLAYBOOK "Committing"
