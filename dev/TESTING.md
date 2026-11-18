# Testing and verifying a change

How this repo checks its own work, and why. Adapted from "How the Claude Code team thinks about verification" (Addy Osmani, 2026-11-16, https://claude.dev/blog/how-the-claude-code-team-thinks-about-verification/). Its idea: when an agent writes most of the code, checks that produce evidence are what let you trust the work without reading every line. Your job becomes saying what "done" means and reading the evidence.

The `verify` skill (`.claude/skills/verify/SKILL.md`) runs the steps below. `REVIEW.md` says what a review looks at.

## Run the change, not only the tests

A change is verified when it has been run the way a user runs it. Here that means a real setup session in Claude Code and in Codex on a fresh test repo (`dev/e2e/`), and then a look at the repo it left: `git status`, `node dev/lessons.mjs --check`, the fingerprint. The session's own report is a claim, not evidence. Unit tests can all pass while setup is broken: a live run once showed a tool writing the script's BOM escape as the character itself, which no unit test saw.

## Three kinds of tests worth having

- **End to end** (`dev/e2e/`). A setup run either works or it doesn't, and a failure says which step broke. These are slow and billed, so they run before a commit of a skill or template change, not on every edit.
- **Property tests** (`tests/property.test.mjs`). A property is a statement that must hold for any input. The test tries it on random text built from the characters the rules care about. Examples here are hard to pick well, since the cases that break code are the ones nobody thought of. The first run of these tests found a bug the example tests had missed for three review rounds. Properties used here:
  - Safety: printed text holds no hidden character but the few allowed.
  - Idempotence: printing text that was already printed changes nothing.
  - Agreement: `--check` reports a rule when the lookup spelled out something in it that has no ordinary use, and never one printed exactly as written.
  
  The generator is seeded, so a failure names the seed and the text to rerun it. Other patterns worth using: a round trip (write, then read back), an invariant (output never over its cap), and equivalence (a fast version matches a slow, plain one).
- **Fail before, pass after** (`LESSONS_SCRIPT=<old copy> node --test`). The version before the change is the oracle: a test for a fix must fail on it. A test that passes on both doesn't prove the fix. For a change that should keep behavior the same, run both versions on the same input and compare the output. Any difference is either a bug or a change that is listed in `CHANGELOG.md`.

## Keep checks fast and honest

- A slow check gets run less. `node --test` takes seconds. Keep it that way.
- One machine's results are not the code's. CI runs Linux, Windows and macOS, and a failure there comes after a push. `node dev/release-check.mjs` also runs `node --test` on Linux: on Windows under WSL, from a copy on WSL's own file system, since a test run on the Windows drive through WSL would get Windows file system behavior. In 0.2.1 that run found two failures the Windows run hid: Linux gave a deleted file's inode number to the next new file, and the new script needed more heap on Node 18 than the test allowed. macOS is left to CI.
- A flaky test teaches you to rerun it instead of fixing the code. Don't add a sleep or a retry. Find the cause, or delete the test and log why in `LESSONS.md`.
- A timing test compares growth, not seconds. It times the full input and a quarter of it, and fails when the full run takes more than 8 times as long: linear work grows about 4 times, quadratic about 16. A busy machine or a slow CI runner slows both runs alike, so the ratio holds where a fixed limit would fail for no reason. Its input must make the slow version fail, and the test is run against the slow version before it is trusted. Growth can't see a cost that an output cap repeats at most a fixed number of times (50 problem messages, say): that cost is linear. Test it by keeping the input and changing only the repeat count, 50 against 1.

## A change can't grade itself

- If a change edits a test along with the code that test checks, the edit to the test is named and justified in the report.
- A review reads `REVIEW.md` from `main`, not from the branch it reviews. (Until `REVIEW.md` is on `main`, the reviewer gets the branch copy and the report says so.)
- Cheap checks first: `node dev/release-check.mjs` before a review, CI or a push.

## When a check keeps failing

Fix and rerun at most three times. If it still fails, stop and bring it to the user with what was tried. A person's attention goes where the checks say something is wrong.

## Reviews

One reviewer per area, briefed by `REVIEW.md`, over several rounds that build on each other. `dev/release-state.md` holds each round's findings, so the next round reads them and skips what was ruled out. A new reviewer is given the diff, not the author's conclusions. Rounds stop when one finds nothing CONFIRMED in the changed code.

## Say how each commit was verified

A commit message ends its body with a `Verified:` line naming the checks that ran, such as `Verified: release-check 6/6, fail-before 5/5, e2e claude+codex node-app`. If none ran, write `Verified: none` and why. Then a log search shows what went in unchecked.

## Turn misses into rules, and prune them

This repo's own method is the plugin's: a mistake gets a `LESSONS.md` entry, and one seen twice becomes a step in `PLAYBOOK.md`. A bug a review or a live run found, that a test should have caught, gets a test that fails before the fix. Checks and notes only grow unless they are pruned. Close a lesson whose rule no longer holds (`node dev/lessons.mjs --stale` finds leads: evidence naming a file that is gone or no longer holds the quoted text), drop a test that another test fully covers, and keep `dev/release-state.md` to the current release.

## Not used here

The article also describes a commit gate with off, observe and enforce modes, a checklist of reliability checks chosen by the diff, and a formal eval of the reviewer built from past incidents. This repo is small and has one maintainer, so these would cost more than they find. `PLAYBOOK.md` sections chosen by the lessons check do the job of the diff-triggered checklist.
