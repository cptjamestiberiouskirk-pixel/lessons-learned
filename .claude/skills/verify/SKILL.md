---
name: verify
description: Verify a change to the lessons-learned plugin before it is committed, by running it and collecting evidence. Use before every commit in this repo, when asked to verify, test or check a change, and after fixing review findings.
---

# Verify a change

Verification here means running the change and reporting what was seen, not reading the diff. Why each step is here: `dev/TESTING.md`.

## 1. Always

Run `node dev/release-check.mjs`. It must report every check passed and none skipped. A skip needs `--allow-skip` and a reason in the report. Inside the tests, `node --test` skips the symlink tests on Windows without Developer Mode (`dev/release-state.md`, RS-T-winsymlink), and each OS skips the tests written for another; name them in the report. On Windows the check "node --test on Linux" runs the tests under WSL, where the symlink tests do run. Without WSL it is skipped, and that skip needs `--allow-skip` and a reason like any other.

## 2. A change to the script or the tests

The script is `plugins/lessons-learned/templates/lessons.mjs`, with its copies in the Codex folder and `dev/`.

- Copy the version before the change as `PLAYBOOK.md` "Running a test against old code" says.
- In pwsh, run `$env:LESSONS_SCRIPT = '<that copy>'; node --test`, then `$env:LESSONS_SCRIPT = $null`. Each new or changed test for a fix must fail there and pass on the new script. A test that passes on both doesn't prove the fix: say so, or change its input until it fails on the old one.
- A timing test must fail on the slow version, with input that makes every step of the slow path do real work.

## 3. A change to a setup skill or the templates

Run it end to end, as `PLAYBOOK.md` "Changing the setup skill or templates" says. Each turn counts against the signed-in account: its plan's usage, or a charge with an API key. The CLI's cost for a turn is roughly $0.30 to $1, an estimate on a plan.

- Claude Code: `pwsh -File dev/e2e/make-test-repos.ps1 -Root <new temp folder>`, then `dev/e2e/run-setup.ps1` on `node-app` (two turns: the plan, then "Go ahead."), and on any test repo whose case the change touches.
- Codex: reinstall the plugin from this checkout so its cache has the change (`codex plugin remove lessons-learned-codex@lessons-learned-codex`, then `codex plugin add lessons-learned-codex@lessons-learned-codex`, each with the `-c` pair from `dev/e2e/README.md`), then `pwsh -File dev/e2e/run-live.ps1 -Tool codex -Marketplace . -Repo <temp folder>/node-app -Log <temp folder>/codex.jsonl -Prompt '<the setup request>'` on a fresh `node-app`, and `-Resume <thread id>` for the second turn. Without `-Marketplace`, `codex exec` puts the released copy back when it starts. Check that the run printed the version under test as installed. Afterwards, reinstall without `-c`.
- Check each repo afterwards, not only the session's reply: `git status`, `node dev/lessons.mjs --check`, and the fingerprint command in the skill.

## 4. Report

List each command run and its result, and each check not run, with the reason. End the commit message with a `Verified:` line naming the checks that ran, or `Verified: none` and why.

## When a check keeps failing

Fix and rerun at most three times. If it still fails, stop and bring the failure to the user with what was tried. Never make a check pass by changing the check in the same change without saying so, by adding a sleep or a retry, or by skipping it.
