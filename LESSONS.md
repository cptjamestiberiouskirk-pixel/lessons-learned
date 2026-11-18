# LESSONS

A dated log of what went wrong while working on the lessons-learned plugin, newest first. For development only: it sits outside `plugins/lessons-learned`, so an installed plugin never includes it. When to add, promote or close an entry: `PLAYBOOK.md`, "The lessons check".

Format, checked by `node dev/lessons.mjs --check`. A field's text may go on over indented lines.

```
## YYYY-MM-DD: short title
- What went wrong:
- Why:
- Rule going forward:
- Evidence: a commit, a test, a run, the user's words, or a file and text it holds: `path/from/root`, search "text"
- Status: open | promoted to PLAYBOOK "<section>" | closed: <why the rule no longer holds>
```

A good entry: its rule says what to do next time, and someone who wasn't in the session can follow it. It is about this project, not general advice. Its evidence can be checked later: a commit, a test's name, or a file in backticks by its path from the repo root, with `, search "text"` for text the file holds on one line, at most 200 UTF-16 units, where an emoji counts as two (`node dev/lessons.mjs --stale` checks both). A name counts as a file only if it holds a `/` or ends in an extension that starts with a letter (`.md`, not `.7z`), and has only letters, digits, `.`, `_`, `-` and `/`: `Makefile` alone, or `app/[id]/page.tsx`, is skipped. And no open lesson covers it already: look it up first. If one does, that lesson has now been seen a second time, so promote it (`PLAYBOOK.md`, "The lessons check", step 5).

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
- Status: open

## 2026-11-17: A test's child process hung in CI, and the log named no test
- What went wrong: on PR 2's first CI run, a child process started by `tests/hardening.test.mjs` never exited on ubuntu Node 24. The job waited until its 10-minute limit cancelled it, and the log named no test, because `node --test` prints a file's results only when the file ends. A rerun passed in 11 s, and 60 local runs on Node 18 and 26 did not hang, so the cause was not found.
- Why: the tests called `spawnSync` with no time limit, so one stuck child held its file until the job limit, with nothing to say which test it was.
- Rule going forward: a test starts a child process through the `spawnSync` that `tests/child.mjs` exports, never straight from `node:child_process`. It kills the child after 60 seconds and fails the test with the command named.
- Evidence: `tests/child.mjs`, search "A child process that never exits"; commit c5e46ae.
- Status: open

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
- Evidence: `tests/codex.test.mjs`, search "the copy renames the file into place and accepts it"; `dev/release-state.md`, search "exFAT".
- Status: open

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
- Evidence: `dev/lessons.mjs`, search "A junction to a volume path is a plain folder to lstat"; `tests/stale.test.mjs`, search "which lstat calls a folder"; `dev/release-state.md`, search "the same class as 0.2.1 round 8".
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
- Evidence: the 0.3.0 session: the "Expected ',', got 'string literal'" error above six "fail 8" lines; rerun from a script file, each mutant failed only its own test.
- Status: open

## 2026-11-17: A scripted edit across four files wrote three before it found the fourth didn't match
- What went wrong: a node script replaced text in both playbook templates and in this repo's own `PLAYBOOK.md` and `LESSONS.md`. It wrote the first three, then stopped on the repo's `LESSONS.md`, which has no "Entries go below this line" sentence. An earlier script for the two setup skills expected a line in both word orders, which each skill holds only one of.
- Why: the script checked and wrote each file in turn, and assumed this repo's own files and the two skills hold the same text as the template where they differ.
- Rule going forward: a scripted edit across several files checks every replacement in every file before it writes any of them, and this repo's `LESSONS.md`, `PLAYBOOK.md` and the two skills are each checked for the text, not assumed to match the template.
- Evidence: the 0.3.0 session: the "MISSING in LESSONS.md" stop, after three files were written; `LESSONS.md` has no "Entries go below this line".
- Status: open

## 2026-11-17: Two tests that passed on Windows failed on Linux, found only by a reviewer's WSL probe
- What went wrong: for eleven review rounds of 0.2.1 every test ran on Windows only. A reviewer used WSL for a probe; running the suite there then showed two failures that CI (ubuntu, windows and macOS) would have shown only after a push. The copy command's end check passed a swapped-in file, because the random-name file's handle was closed and Linux gave the next new file the same inode number. The heap test's 96 MB limit was too little for the new script on Node 18, which needs 128 MB (Node 26 needs 40).
- Why: I ran `node --test` and the release check on this Windows machine only, and took one machine's numbers (inode behavior, heap use) as the code's.
- Rule going forward: before a release commit, also run `node --test` under WSL (Linux) from a copy on its own file system. A test that measures a resource (heap, time) gets its limit from runs on more than one Node version and OS, with room on both sides.
- Evidence: the 0.2.1 work: `not ok 35 - the copy command fails when its random-name file is replaced by another plain file before the fallback rename` under WSL, and the probe showing the same inode after unlink with the handle closed and a new one with it held; `heapfloor.mjs`: new script 128 MB and old 256 MB on Node 18, 40 MB and 256 MB on Node 26.
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
- Evidence: the 0.2.1 session's `round1-fix.mjs` run ("0 matches: assert.match(r.stderr, /staged.md: ...", the backslash gone), then the same change made with the Edit tool; and the 0.2.0 session's RegExp template fix.
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
- Evidence: the probes in the 0.2.1 work (a dangling file link: "WROTE", the text at the target; a dangling junction: `EISDIR` and an empty folder; `linkSync` over either: `EEXIST`, nothing made; `renameSync` over a junction: `EPERM`, nothing made), the Codex end-to-end run for 0.2.1 (`LESSONS.md: cannot be made (EPERM)` from `linkSync` in the sandbox), and `tests/codex.test.mjs`, "the copy command is not led by a dangling junction made after its look at the target".
- Status: open

## 2026-11-16: A growth test was claimed to guard a cost that an output cap keeps linear
- What went wrong: I said the 4 MB title test guarded the change that cuts a title once for all its problem messages. Review round 6 showed it passed on the script before that change, and on a mutant that cut the title again in each message.
- Why: `--check` prints at most 50 problems, so cutting the title in each one costs at most 50 walks of it. That grows with the title, linearly, so full against a quarter grows about 4 times either way, and a growth test cannot tell them apart.
- Rule going forward: when an output cap bounds how often a cost repeats, test it by holding the input the same and changing only the repeat count (50 messages against 1), and run that test on the old version before saying it guards the change.
- Evidence: `tests/hardening.test.mjs`, "a 9 MB title named in 50 problem messages costs about what one message costs": 750 ms against 100 ms on the round-5 script, 1245 ms against 205 ms on the mutant; review round 6 in `dev/release-state.md`.
- Status: open

## 2026-11-16: A timing test with a limit in seconds failed on a busy machine
- What went wrong: the 4 MB title test failed at 10 to 14 seconds against a 10-second limit. The current script, the round-5 script and the round-6 script all took about 14 seconds on that input, so nothing had regressed: other processes were loading the machine.
- Why: a fixed limit in seconds measures the machine as much as the script. A limit wide enough for any load would also let a slow script pass.
- Rule going forward: a timing test compares growth, not seconds: it times the full input and a quarter of it, and fails when the full run takes more than 8 times as long (linear work grows about 4 times, quadratic about 16).
- Evidence: `tests/hardening.test.mjs`, the `growth` helper and its four tests, which pass under the same load and fail on the slow scripts they were written for.
- Status: open

## 2026-11-16: A rule holding U+2028 was read as a broken field
- What went wrong: the first run of the new property tests found rules that `--check` called "missing or empty" and "not a field", though each had its `- Rule going forward:` line. The lookup printed them as empty rules. Unit tests had never put a line separator inside a field.
- Why: in a JavaScript regex, `.` doesn't match U+2028 or U+2029, which it treats as line ends. The field and heading patterns end in `(.*)$`, so a line holding one never matched.
- Rule going forward: a regex that must match a whole line of untrusted text uses the `s` flag (or `[^]`), and a new parsing rule gets a property test with random text, not only examples.
- Evidence: `tests/property.test.mjs`, seeds 1 to 5, fail on the script before the `s` flag; `tests/hardening.test.mjs`, "a line separator (U+2028) in a rule is reported as hidden". Seen again in 0.3.0: the `--stale` evidence parser was written with example tests only, though the lookup had printed this rule, and paired backticks wrongly (a command in backticks, a slash, then a file name in backticks hid the file name) until a property test with random text was written; `tests/stale.test.mjs`, search "property: --stale reports the file names a plain parser finds".
- Status: promoted to PLAYBOOK "Parsing untrusted text"

## 2026-11-16: A timing test passed on the slow script it was written to catch
- What went wrong: the first version of the `From:` timing test passed on the round-3 script, which round 3 had shown takes 24 seconds on such input. The test used keys of different lengths.
- Why: comparing two strings of different lengths stops at once, so the quadratic scan cost almost nothing per step. Only keys of one length that differ at the end make each comparison run long.
- Rule going forward: run a new timing test against the slow version before trusting it, and build its input so every step of the slow path does real work.
- Evidence: `tests/hardening.test.mjs`, "a From: line naming 100,000 lessons": 1.5 s on the round-3 script with the first input, 23.8 s with keys of one length.
- Status: open

## 2026-11-16: A PowerShell replacement list dropped the text after a + in each pair
- What went wrong: a batch of text replacements written as `@( ,@('old', 'new' + "`n" + 'more') )` replaced each old text with only the part before the first `+`. A table row in SECURITY.md lost its end and merged with the next row, two bullets were dropped, and two script edits never landed. The loop reported no missing anchor.
- Why: in PowerShell the comma binds tighter than `+`, so `'a', 'b' + 'c'` is the array `'a', 'b'` with `'c'` added as a third item. The pair's second item was only `'b'`.
- Rule going forward: in a PowerShell array of replacement pairs, wrap a joined item in parentheses (`@('old', ('new' + "`n" + 'more'))`) or write it as one here-string, and read each changed file back before going on.
- Evidence: the 0.2.0 session: SECURITY.md held the `node` row and the `dev/lessons.mjs` row on one line; the hard-link and `byKey` edits to `lessons.mjs` were missing until redone with parentheses.
- Status: open

## 2026-11-16: A setup run wrote the script's BOM escape as the character itself
- What went wrong: in the first live run next to Trailmark, setup wrote `templates/lessons.mjs` with the Write tool, and the `\uFEFF` in the BOM check became a literal U+FEFF. The fingerprint didn't match until that session found the character and fixed it. Later a PowerShell command of mine that held the same escape was refused for holding U+FEFF.
- Why: text passed through a tool call is JSON, where a single-backslash unicode escape is read as the character. Any agent that writes the template out can do this, not only the Edit tool.
- Rule going forward: the templates and skills hold no single-backslash unicode escape: match an invisible character by its code (`charCodeAt(0) === 0xfeff`) or a property class (`\p{Cf}`). A test checks the shipped files.
- Evidence: the first live run's log (a local file, `s1-claude.json`, not kept in the repo), the reply's note on line 103 of the script; `tests/hardening.test.mjs`, "hold no single-backslash unicode escape".
- Status: promoted to PLAYBOOK "Changing the setup skill or templates"

## 2026-11-16: A fail-before run used a copy of the old script that was one line long
- What went wrong: to show the new hardening tests fail on the old script, `git show HEAD:<script> | Set-Content -NoNewline <file>` made the old copy. Its lines were joined with no separator, so everything after the first `//` was a comment and the copy did nothing. The run reported 8 failures, which looked right but proved nothing; a guard test that should pass on both versions failing gave it away.
- Why: in PowerShell, a native program's output reaches `Set-Content` as separate lines, and `-NoNewline` drops the line breaks between them, not only the last one.
- Rule going forward: copy an old version of a file with a byte-exact redirect (`cmd /c "git show <rev>:<path> > <file>"`), and check the copy with `git hash-object <file>` against `git rev-parse <rev>:<path>` before using it.
- Evidence: the 0.2.0 hardening session: the second fail-before run, with a copy whose hash matched the blob: 8 hardening tests failed, the near-miss and imports tests passed. Seen again in the round-5 timing check: the v0.1.0 copy made the same way exited 0 with no output, until a `cmd /c` copy whose hash matched failed the test at a ratio of 14.6.
- Status: promoted to PLAYBOOK "Running a test against old code"

## 2026-11-16: The Edit tool wrote a \uFEFF escape into the script as a literal BOM
- What went wrong: an edit to `templates/lessons.mjs` meant to add `.replace(/^\uFEFF/, '')` left an invisible U+FEFF character between `^` and `/` instead of the six-character escape. The code still worked, but it hid a character in the source of a change about hidden characters.
- Why: the Edit tool turned `\uFEFF` in the new text into the character itself, in the script and in this entry too (three times). `\x00`-style escapes and doubled-backslash `\\u0000` came through as text.
- Rule going forward: after an edit whose text holds a `\u` escape, in any file, scan the file for non-ASCII characters (`[^\x00-\x7F]`). Write a regex escape for an invisible character with a doubled backslash inside a string (`new RegExp('\\uFEFF')`), or fix it with a byte-level replace.
- Evidence: the 0.2.0 hardening session: a scan found 1 literal U+FEFF in `templates/lessons.mjs`; after the replace, 0 non-ASCII characters.
- Status: promoted to PLAYBOOK "Changing the setup skill or templates"

## 2026-11-16: CI ran the tests with a folder argument, and Node 22 read it as a module
- What went wrong: the first CI run (43957308380) failed on Node 22 on all three systems with "Cannot find module '.../tests'", while Node 20 passed. Locally, `node --test tests/` had passed on Node 26.
- Why: INFERRED from the log: Node 22 took the `tests/` argument as a module to load, not a folder to search. How `--test` reads its arguments differs between Node versions.
- Rule going forward: run the tests with `node --test` and no path argument. It finds `*.test.mjs` files the same way on every version CI uses.
- Evidence: `gh run view 43957308380 --log-failed`; after 52e4438, run 43957556091 passed all six jobs (three systems, Node 22 and 24).
- Status: open

## 2026-11-16: Listing a git archive through a pipe in PowerShell ran past the 2-minute limit
- What went wrong: `git archive $tree | tar -t` in the PowerShell tool ran past the 2-minute limit and was moved to the background, though the archive has 20 entries. The same listing through a file (`git archive -o <file>`, then `tar -tf <file>`) took 176 ms.
- Why: HYPOTHESIZED: the pipe between the two native programs in pwsh 7.7. Not looked into further.
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
