# LESSONS

A dated log of what went wrong while working on this project, newest first. For development only: whatever the project builds, packages or releases never includes it. When to add, promote or close an entry: `PLAYBOOK.md`, "The lessons check".

Format, checked by `node dev/lessons.mjs --check`. A field's text may go on over indented lines.

```
## YYYY-MM-DD: short title
- What went wrong:
- Why:
- Rule going forward:
- Evidence: a commit, a file and the text to search for, a test, a run, or the user's words
- Status: open | promoted to PLAYBOOK "<section>" | closed: <why the rule no longer holds>
```

Entries go below this line, newest first: a new one goes right here, above the others. An entry inside the block above is never read.
