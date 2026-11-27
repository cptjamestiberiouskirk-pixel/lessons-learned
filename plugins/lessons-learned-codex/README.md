# Lessons Learned for Codex

lessons-learned-codex adds the lessons check to a repo from Codex. Its one skill, `lessons-setup`, adds a dated log of what went wrong (`LESSONS.md`), a playbook of checklists, with a check of your work before a change is called done and steps built from the log (`PLAYBOOK.md`), a small script that finds lessons by topic, checks the log's format, lists lessons whose evidence may be stale and, with `--lint`, finds rules a session may not be able to follow (`dev/lessons.mjs`), and one line in `AGENTS.md` that points each chat at the check. Cursor, Windsurf, OpenCode and GitHub Copilot read `AGENTS.md` too, and setup offers the line in `GEMINI.md` for Gemini CLI. It is the Codex copy of [lessons-learned](https://github.com/cptjamestiberiouskirk-pixel/lessons-learned); the templates are the same files in both.

Once a repo is set up, the plugin isn't needed: the files are in the repo, so Codex and Claude Code sessions both follow them, with or without the plugin.

## Install

You need Node.js 22 or later and the Codex CLI.

```text
codex plugin marketplace add cptjamestiberiouskirk-pixel/lessons-learned
```

Then install **lessons-learned-codex** from that marketplace: in the ChatGPT desktop app, open the Plugins directory and choose it, or with the CLI run `codex plugin add lessons-learned-codex@lessons-learned-codex`. To confirm it is installed, run `codex plugin list` and look for `lessons-learned-codex ... installed, enabled`; a new chat then has the `lessons-setup` skill.

## Use

In a chat in the repo, ask to set up lessons learned (or name the skill, `lessons-setup`). It checks what the repo already has, shows a plan and waits for your go-ahead before it writes anything. For a script from an earlier release, it names the release and what changed since, and asks before it replaces it. It also offers two checks that run `node dev/lessons.mjs --doctor` and fail only on an error: a CI step, and a pre-commit hook in the hook manager the repo uses (or a new `.githooks/pre-commit`, which you turn on yourself). It adds each only if you name it.

## The lessons gate

The plugin has two hooks, the same files as in the Claude Code plugin: the lessons gate (`hooks/lessons-gate.mjs`), here, and the lint hook (`hooks/lessons-lint.mjs`), below. Codex runs a plugin's hook only after you trust it, and saves the trust for each hook on its own. In the Codex CLI, run `/hooks` in a chat and trust it there. In the Codex desktop app, open Settings > Hooks and trust it under From Plugins, or select Review hooks in the composer when it shows. Both save the trust in Codex's `config.toml`, so trusting it in one covers the other. In a repo whose `PLAYBOOK.md` has "## The lessons check", the gate then denies an `apply_patch` edit, and a shell command that runs `git commit` or `git push`, until Codex has written a visible `Lessons checked:` line in this turn, after its last commit or push to that repo. In the session's own repo, where `dev/lessons.mjs` is this release's or an earlier release's (0.2.0 to 0.4.0), it also needs a lookup with that script. It only reads, and lets the call through when it can't tell. It looks at the clock at points as it reads. Once 6 seconds have passed, it denies the call at its next look at the clock, since Codex runs a call whose hook its 10 second timeout ends; the next turn starts fresh. Until that look its reading goes on.

To turn it off, turn the hook off in the CLI's `/hooks` or the app's Settings > Hooks, or start Codex with `LESSONS_GATE=off` in its environment. [SECURITY.md](https://github.com/cptjamestiberiouskirk-pixel/lessons-learned/blob/main/SECURITY.md) says how it reads Codex's records and what gets past it.

## The lint hook

The second hook, `hooks/lessons-lint.mjs`, runs after an `apply_patch` once you trust it, as the gate does. When the patch changes `LESSONS.md`, `PLAYBOOK.md` or a rule file that `--lint` reads, in a repo set up as the gate's are, it tells Codex what `--lint` finds in that file, apart from `unreached`, at most 9 findings, errors first. When the patch adds a lesson, it also names the open lessons and PLAYBOOK steps whose rules the new one overlaps (the `second-sighting` and `dup-rule` leads), so Codex can promote the lesson instead of adding a second one. When it finds nothing, it says nothing. It never blocks the edit. It runs this plugin's own copy of the script, imported into its own process, never the repo's `dev/lessons.mjs`. A write through the shell isn't seen. Turn it off as the gate: in `/hooks`, in Settings > Hooks, or with `LESSONS_GATE=off`, which turns off both.

## How it differs from the Claude Code plugin

- The skill is `lessons-setup`, not `lessons-learned:setup`.
- It finds the templates in its own plugin folder, and refuses a plugin folder whose path holds a double quote, `$`, a backtick, `%`, `!` or other characters a shell could read differently.
- It copies the templates with a Node command that won't write over a file or link already at the target.
- It names `AGENTS.md` as the entry point when the repo has neither `AGENTS.md` nor `CLAUDE.md`.
- Its gate looks at `apply_patch` and shell commands, and a `Lessons checked:` line counts only in its own turn. In Claude Code a line also carries on past a background task's notification.

## With Trailmark

[Trailmark](https://github.com/cptjamestiberiouskirk-pixel/trailmark) keeps a handoff note outside the repo and brings it into each chat with hooks. The two plugins can be installed together: they write to different places, and each does its own job. The handoff says where the work stands; the lessons say how to do it without repeating mistakes. A handoff may name a lesson by its title but doesn't repeat its rule.

## Security

See [SECURITY.md](https://github.com/cptjamestiberiouskirk-pixel/lessons-learned/blob/main/SECURITY.md).
