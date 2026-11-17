# Lessons Learned for Codex

lessons-learned-codex adds the lessons check to a repo from Codex. Its one skill, `lessons-setup`, adds a dated log of what went wrong (`LESSONS.md`), a playbook of checklists, with a check of your work before a change is called done and steps built from the log (`PLAYBOOK.md`), a small script that finds lessons by topic, checks the log's format and lists lessons whose evidence may be stale (`dev/lessons.mjs`), and one line in `AGENTS.md` that points each chat at the check. Cursor, Windsurf, OpenCode and GitHub Copilot read `AGENTS.md` too, and setup offers the line in `GEMINI.md` for Gemini CLI. It is the Codex copy of [lessons-learned](https://github.com/cptjamestiberiouskirk-pixel/lessons-learned); the templates are the same files in both.

Once a repo is set up, the plugin isn't needed: the files are in the repo, so Codex and Claude Code sessions both follow them, with or without the plugin.

## Install

You need Node.js 22 or later and the Codex CLI.

```text
codex plugin marketplace add cptjamestiberiouskirk-pixel/lessons-learned
```

Then install **lessons-learned-codex** from that marketplace: in the ChatGPT desktop app, open the Plugins directory and choose it, or with the CLI run `codex plugin add lessons-learned-codex@lessons-learned-codex`. The plugin has no hooks, so either way works. To confirm it is installed, run `codex plugin list` and look for `lessons-learned-codex ... installed, enabled`; a new chat then has the `lessons-setup` skill.

## Use

In a chat in the repo, ask to set up lessons learned (or name the skill, `lessons-setup`). It checks what the repo already has, shows a plan and waits for your go-ahead before it writes anything.

## How it differs from the Claude Code plugin

- The skill is `lessons-setup`, not `lessons-learned:setup`.
- It finds the templates in its own plugin folder, and refuses a plugin folder whose path holds a double quote, `$`, a backtick, `%`, `!` or other characters a shell could read differently.
- It copies the templates with a Node command that won't write over a file or link already at the target.
- It names `AGENTS.md` as the entry point when the repo has neither `AGENTS.md` nor `CLAUDE.md`.

## With Trailmark

[Trailmark](https://github.com/cptjamestiberiouskirk-pixel/trailmark) keeps a handoff note outside the repo and brings it into each chat with hooks. The two plugins can be installed together: they write to different places, and each does its own job. The handoff says where the work stands; the lessons say how to do it without repeating mistakes. A handoff may name a lesson by its title but doesn't repeat its rule.

## Security

See [SECURITY.md](https://github.com/cptjamestiberiouskirk-pixel/lessons-learned/blob/main/SECURITY.md).
