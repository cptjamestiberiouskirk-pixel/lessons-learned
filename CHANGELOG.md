# Changelog

## 0.1.0 (unreleased)

First version.

- `/lessons-learned:setup` adds a lessons log (`LESSONS.md`), a playbook (`PLAYBOOK.md`), a lookup and format-check script (`dev/lessons.mjs`) and an entry-point line in `CLAUDE.md` or `AGENTS.md` to a repo, and keeps them out of what the repo ships.
- Setup checks what the repo already has first. It changes nothing when everything is in place, adds only the missing parts, and asks before touching lessons kept under another name or a script that differs from this version.
- Setup shows its plan and waits for a go-ahead, then proves the format check catches broken entries and that the script came through intact.
