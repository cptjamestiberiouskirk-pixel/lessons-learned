# lessons-learned

A Claude Code plugin that adds a lessons-learned log (`LESSONS.md`) and a playbook (`PLAYBOOK.md`) to a repo, so Claude stops repeating the same mistakes in that project.

This repo is a plugin marketplace with one plugin. See [plugins/lessons-learned/README.md](plugins/lessons-learned/README.md) for what it does and how to use it.

```
/plugin marketplace add <path or GitHub URL of this repo>
/plugin install lessons-learned@lessons-learned
```

## Working on the plugin

This repo uses its own lessons check: see [CLAUDE.md](CLAUDE.md) and [PLAYBOOK.md](PLAYBOOK.md).

- Tests: `node --test tests/`
- Validation: `claude plugin validate .` and `claude plugin validate plugins/lessons-learned --profile directory`
- End-to-end runs of the setup skill (billed): [dev/e2e/README.md](dev/e2e/README.md)
- The icon is drawn by `node dev/make-icon.mjs`.

Changes are listed in [CHANGELOG.md](CHANGELOG.md).
