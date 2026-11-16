# Working on lessons-learned

Before each step listed under "The lessons check" in `PLAYBOOK.md`, follow that section: it runs `node dev/lessons.mjs` and says when to add to `LESSONS.md`.

This repo is a Claude Code plugin marketplace with one plugin. What ships is `plugins/lessons-learned/`: the setup skill and the three templates it writes into a user's repo. Everything else (`dev/`, `tests/`, this file, `LESSONS.md`, `PLAYBOOK.md`) is for working on the plugin.

## Checking a change

- `node --test tests/`: the template script's lookup and `--check`, that the setup skill's fingerprint matches `templates/lessons.mjs`, and that this repo's own `dev/lessons.mjs` matches the template.
- `claude plugin validate .` and `claude plugin validate plugins/lessons-learned --profile directory`.
- `node dev/lessons.mjs --check`.
- A change to the setup skill or templates also gets an end-to-end run: `PLAYBOOK.md`, "Changing the setup skill or templates".

## Conventions

- `templates/lessons.mjs` and `dev/lessons.mjs` stay the same text. After a change to the template, copy it to `dev/` and update the value under "The script's fingerprint" in `SKILL.md`; the tests fail until both are done.
- A change a user would notice gets a line in `CHANGELOG.md` and, at release, a version bump in `plugins/lessons-learned/.claude-plugin/plugin.json`.
- PowerShell means `pwsh` 7, never Windows PowerShell 5.1.
- Docs and the skill are plain and direct: no em or en dashes, short sentences.
- Ask before pushing, publishing or creating a remote.
