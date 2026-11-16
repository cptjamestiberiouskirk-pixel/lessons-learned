# lessons-learned

A Claude Code plugin that adds a lessons-learned log (`LESSONS.md`) and a playbook (`PLAYBOOK.md`) to a repo, so Claude stops repeating the same mistakes in that project.

This repo is a plugin marketplace with one plugin. See [plugins/lessons-learned/README.md](plugins/lessons-learned/README.md) for what it does and how to use it.

```
/plugin marketplace add <path or GitHub URL of this repo>
/plugin install lessons-learned@lessons-learned
```

Tests for the lessons script: `node --test tests/`.
