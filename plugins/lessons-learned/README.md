# lessons-learned

A lessons-learned log and a playbook for Claude Code, kept in each repo.

Claude Code forgets a project's mistakes between sessions, so the same ones come back. This plugin sets up a small system in the repo that stops that:

- **`LESSONS.md`**: a dated log of what went wrong, why, and the rule going forward, with evidence.
- **`PLAYBOOK.md`**: checklists for the project's recurring work. Its first section, "The lessons check", is what Claude runs before each significant step: look up the lessons that apply, write a visible `Lessons checked:` line, follow the rules, and log anything that goes wrong before moving on. A lesson seen twice becomes a playbook step.
- **`dev/lessons.mjs`**: finds lessons by topic (`node dev/lessons.mjs save test`) and checks the format of both files (`--check`). It reads and never writes.
- **One line in `CLAUDE.md`** (or `AGENTS.md`) that points every session at the lessons check.

All of it lives in the repo, so it keeps working for anyone who clones the repo, with or without this plugin.

## Install

```
/plugin marketplace add <path or GitHub URL of this repo>
/plugin install lessons-learned@lessons-learned
```

## Use

In the repo you want to set up, run:

```
/lessons-learned:setup
```

Or just ask Claude to add lessons learned or a playbook to the project. Setup first checks what the repo already has, including the same idea under other names (a `gotchas.md`, rules kept in `CLAUDE.md`). It then shows a plan and waits for your go-ahead, and adds only what's missing. It finishes by proving the format check catches broken entries, and it doesn't commit.

## Requirements

Node.js for `dev/lessons.mjs`. It uses only Node's built-in modules. In a project without Node, setup asks whether to use it anyway or port the script.

## Limits

A session follows the lessons check by hand, because the instructions tell it to. The script checks only the format of the two files, not whether the check was run.
