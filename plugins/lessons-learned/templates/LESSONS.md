# LESSONS

A dated log of what went wrong while working on this project, newest first. For development only: whatever the project builds, packages or releases never includes it. When to add, promote or close an entry: `PLAYBOOK.md`, "The lessons check".

Format, checked by `node dev/lessons.mjs --check`. A field's text may go on over indented lines.

```
## YYYY-MM-DD: short title
- What went wrong:
- Why:
- Rule going forward:
- Evidence: a commit, a test, a run, the user's words, or a file and text it holds: `path/from/root`, search "text"
- Status: open | promoted to PLAYBOOK "<section>" | closed: <why the rule no longer holds>
```

A good entry: its rule says what to do next time, and someone who wasn't in the session can follow it. It is about this project, not general advice. Its evidence can be checked later: a commit, a test's name, or a file in backticks by its path from the repo root, with `, search "text"` for text the file holds, at most 200 characters (`node dev/lessons.mjs --stale` checks both). A name counts as a file only if it holds a `/` or ends in an extension, and has only letters, digits, `.`, `_`, `-` and `/`: `Makefile` alone, or `app/[id]/page.tsx`, is skipped. And no open lesson covers it already: look it up first. If one does, that lesson has now been seen a second time, so promote it (`PLAYBOOK.md`, "The lessons check", step 5).

Entries go below this line, newest first: a new one goes right here, above the others. An entry inside the block above is never read.
