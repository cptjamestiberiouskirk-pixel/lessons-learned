# LESSONS

A dated log of what went wrong while working on the lessons-learned plugin, newest first. For development only: it sits outside `plugins/lessons-learned`, so an installed plugin never includes it. When to add, promote or close an entry: `PLAYBOOK.md`, "The lessons check".

Format, checked by `node dev/lessons.mjs --check`. A field's text may go on over indented lines.

```
## YYYY-MM-DD: short title
- What went wrong:
- Why:
- Rule going forward:
- Evidence: a commit, a file and the text to search for, a test, a run, or the user's words
- Status: open | promoted to PLAYBOOK "<section>" | closed: <why the rule no longer holds>
```

## 2026-11-16: Listing a git archive through a pipe in PowerShell ran past the 2-minute limit
- What went wrong: `git archive $tree | tar -t` in the PowerShell tool ran past the 2-minute limit and was moved to the background, though the archive has 20 entries. The same listing through a file (`git archive -o <file>`, then `tar -tf <file>`) took 176 ms.
- Why: HYPOTHESIZED: the pipe between the two native programs in pwsh 7.7. Not looked into further.
- Rule going forward: in the PowerShell tool, list an archive through a temp file, not a pipe.
- Evidence: the MVP session, 2026-11-16: the backgrounded call, then the timed file-based listing.
- Status: open

## 2026-11-16: A shell copy out of the plugin folder was refused
- What went wrong: a change to the setup skill told it to copy the templates with `cp` or `Copy-Item`. Its end-to-end run refused both as an edit of a "sensitive file", and the session stopped with nothing set up. The change had been made without an end-to-end run.
- Why: the plugin folder is outside the repo being set up, and Claude Code's permission check asks for approval for any shell command that touches it, even one that only reads. The Read tool reads there without asking.
- Rule going forward: the setup skill brings templates in with the Read and Write tools, never with a shell command on the plugin folder. A change to the setup skill or the templates gets an end-to-end run on a fresh test repo before it is committed.
- Evidence: fc61131 ("Setup writes templates out and checks the script's fingerprint"); the run's refusal "requested permissions to edit ... templates\LESSONS.md which is a sensitive file".
- Status: promoted to PLAYBOOK "Changing the setup skill or templates"

## 2026-11-16: A setup run's copy of the script differed from the template only in line endings
- What went wrong: after the first end-to-end run of setup, a byte compare of the run's `dev/lessons.mjs` with the template failed: 8,485 bytes with no CRLF against 8,683 bytes with 198. The text was the same.
- Why: the template was a byte copy of Deep Belt's script, whose checkout had CRLF from `core.autocrlf=true`, and this repo had no `.gitattributes`. The setup session wrote the file with LF.
- Rule going forward: compare a copy of the script with its template with line endings ignored, as the setup skill's fingerprint does. Text files here are LF in every checkout (`.gitattributes`).
- Evidence: `.gitattributes`, search "eol=lf"; `plugins/lessons-learned/skills/setup/SKILL.md`, search "line endings ignored".
- Status: open

## 2026-11-16: A commit message passed with -F - in PowerShell was read as a path
- What went wrong: the first commit, run in the PowerShell tool as `git commit -F - @'...'@`, failed with "pathspec 'Add the lessons-learned plugin ...' did not match any file(s)" and committed nothing.
- Why: `-F -` reads the message from stdin, and PowerShell passed the here-string as one more argument, not as stdin.
- Rule going forward: in the PowerShell tool, give a commit message with `-m @'...'@`.
- Evidence: the session that made 2f94516: the failed call, then the same message with `-m`, which made the commit.
- Status: open
