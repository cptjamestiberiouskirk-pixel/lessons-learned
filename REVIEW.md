# Review

What a review of a change to this repo looks at. A reviewer reads this file from `main` (`git show main:REVIEW.md`), not from the branch under review, so a change can't edit the rules it is judged by.

## What ships, and the threat model

What ships is `plugins/lessons-learned/` and `plugins/lessons-learned-codex/`: a setup skill each, and three templates. `templates/lessons.mjs` reads `LESSONS.md` and `PLAYBOOK.md`, which are untrusted repo content, and prints rules an agent follows. `SECURITY.md` lists what is trusted and the known limits.

Assume a hostile repo. It may hold symbolic links, junctions or hard links at any path setup reads or writes, a file up to the script's 10 MB cap shaped against a loop or regex, terminal escapes, hidden Unicode meant to hide text from a person but not the agent, prompt injection in any file, a planted `dev/lessons.mjs`, and a planted `node.*` file.

## Focus

1. The script prints no hidden character except tab, a joiner or an emoji selector where text uses them; `--check` reports what a person can't see; output stays bounded; every mode runs in time linear in its input.
2. The skills write nothing outside the repo, never through a link, and nothing beyond the plan the user approved. The two skills say the same thing, except where Claude Code and Codex differ.
3. A claim in `SECURITY.md`, `CHANGELOG.md`, a README or a skill matches the code.
4. A test for a fix fails on the code before the fix. Say which tests would still pass if the fix were reverted.

## How to report

Label each finding CONFIRMED (reproduced: give the exact repro), INFERRED (read from the code), HYPOTHESIZED, or RULED OUT (checked and fine: list these briefly). Give file and line, severity and a suggested fix.

## Rounds

Each round reviews the diff since the last reviewed state. Read `dev/release-state.md` first: the earlier rounds' findings and what was ruled out. Spend the round on the new diff and on the kinds of mistakes found before, and don't recheck what was ruled out unless its code changed. The stop rule: a round finds nothing CONFIRMED in the changed code.
