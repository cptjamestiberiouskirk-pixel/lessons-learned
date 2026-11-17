# lessons-learned

A plugin for Claude Code and Codex that adds a lessons-learned log (`LESSONS.md`) and a playbook (`PLAYBOOK.md`) to a repo, so the agent stops repeating the same mistakes in that project.

This repo holds two copies of the plugin, with the same templates:

- **Claude Code**: [plugins/lessons-learned](plugins/lessons-learned/README.md)

  ```
  /plugin marketplace add cptjamestiberiouskirk-pixel/lessons-learned
  /plugin install lessons-learned@lessons-learned
  ```

- **Codex**: [plugins/lessons-learned-codex](plugins/lessons-learned-codex/README.md)

  ```
  codex plugin marketplace add cptjamestiberiouskirk-pixel/lessons-learned
  codex plugin add lessons-learned-codex@lessons-learned-codex
  ```

Setup writes everything into the repo, so a repo set up from one tool works from the other too, once the entry line is in both `CLAUDE.md` and `AGENTS.md` (setup offers this). Cursor, Windsurf, OpenCode and GitHub Copilot read `AGENTS.md` too, and setup offers the line in `GEMINI.md` for Gemini CLI. It can be installed next to a handoff plugin such as [Trailmark](https://github.com/cptjamestiberiouskirk-pixel/trailmark): they write to different places and do different jobs. The same goes for a design-review plugin such as [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model), which writes specs under `docs/designs/` and review reports: a finding that keeps coming back in its reviews is a good candidate for a lesson.

Security: [SECURITY.md](SECURITY.md).

## Working on the plugin

This repo uses its own lessons check: see [CLAUDE.md](CLAUDE.md) and [PLAYBOOK.md](PLAYBOOK.md).

- Every check a release needs: `node dev/release-check.mjs`
- Tests alone: `node --test`
- End-to-end runs of the setup skill (billed): [dev/e2e/README.md](dev/e2e/README.md)
- The icon is drawn by `node dev/make-icon.mjs`.

Changes are listed in [CHANGELOG.md](CHANGELOG.md).
