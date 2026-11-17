# Working on lessons-learned

Before each step listed under "The lessons check" in `PLAYBOOK.md`, follow that section: it runs `node dev/lessons.mjs` and says when to add to `LESSONS.md`.

This repo is a plugin marketplace for Claude Code (`.claude-plugin/`) and Codex (`.agents/plugins/`), with one plugin in two copies. What ships is `plugins/lessons-learned/` (Claude Code) and `plugins/lessons-learned-codex/` (Codex): a setup skill each, and the three templates it writes into a user's repo, the same files in both. Everything else (`dev/`, `tests/`, `.claude/`, this file, `LESSONS.md`, `PLAYBOOK.md`, `REVIEW.md`) is for working on the plugin.

## Checking a change

Before a commit, run the `verify` skill (`.claude/skills/verify/SKILL.md`). Why each check is there, and what makes a test worth having: `dev/TESTING.md`. What a review looks at: `REVIEW.md`, read from `main`.

- `node dev/release-check.mjs` runs all of the below that don't need a model and prints what each found.
- `node --test`: the template script's lookup, `--check` and hardening, and properties tried on random text (`tests/property.test.mjs`); that both skills' fingerprints match `templates/lessons.mjs`; that the shared files are the same in both copies; that this repo's own `dev/lessons.mjs` matches the template.
- `node --test` on Linux. On Windows the release check runs it under WSL, from a copy on WSL's own file system. Inode reuse, case and heap use differ there, and in 0.2.1 two tests that passed on Windows failed on Linux.
- `claude plugin validate .` and `claude plugin validate plugins/lessons-learned --profile directory`. Codex has no validate command: `tests/codex.test.mjs` checks the Codex manifests and marketplace, and installing with `codex plugin add` is the real check.
- `node dev/lessons.mjs --check`.
- A change to a setup skill or the templates also gets an end-to-end run: `PLAYBOOK.md`, "Changing the setup skill or templates".

## Conventions

- `templates/lessons.mjs` in both copies and `dev/lessons.mjs` stay the same text. After a change to the template, copy it to the other two places and update the value under "The script's fingerprint" in both `SKILL.md` files; the tests fail until all are done.
- A change to one setup skill gets the same change in the other, unless it is about how the two tools differ.
- A change a user would notice gets a line in `CHANGELOG.md` and, at release, a version bump in both plugins' manifests (`.claude-plugin/plugin.json`, and the Codex pair `plugin.json` and `.codex-plugin/plugin.json`) and in the script's header.
- Deferred findings and review rounds are recorded in `dev/release-state.md`.
- A test for a fix fails on the code before the fix (`LESSONS_SCRIPT=<old copy> node --test`). A check still failing after three fixes goes to the user.
- A commit message ends its body with a `Verified:` line naming the checks that ran, or `Verified: none` and why.
- PowerShell means `pwsh` 7, never Windows PowerShell 5.1.
- Docs and the skill are plain and direct: no em or en dashes, short sentences.
- Ask before pushing, publishing or creating a remote.
