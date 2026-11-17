# Changelog

## 0.2.0 (unreleased)

Codex support, and hardening against untrusted repo content.

- A Codex copy, `lessons-learned-codex`, with the skill `lessons-setup`. It shares the templates with the Claude Code plugin word for word, and sets up the same files, so a repo can be worked on from both. Install: `codex plugin marketplace add cptjamestiberiouskirk-pixel/lessons-learned`.
- `dev/lessons.mjs` treats `LESSONS.md` and `PLAYBOOK.md` as untrusted. It refuses a symbolic link, anything that isn't a regular file, a file with a second hard link and a file over 10 MB. It prints control and invisible characters (terminal escapes, bidirectional overrides, zero-width and Unicode tag characters) as `<U+XXXX>`, and `--check` reports them as bad. U+FE0E or U+FE0F right after an emoji, and a zero-width joiner after a non-ASCII character, pass where emoji and scripts use them; a run of them, or one elsewhere, is bad. Printed lines are cut at 2,000 characters, and a problem message names a title, section or `From:` name by its first 200; `--all` prints at most 50 lessons, a lookup at most 50 results with the playbook sections first, and `--check` at most 50 problems. Characters with ordinary uses (the zero-width non-joiner, direction marks, the soft hyphen) are spelled out but not counted as bad, unless the character after one is spelled out too. The checks run in time linear in the file's size.
- Setup doesn't run a repo's existing script until its fingerprint matches this version's, and runs a path check that stops on any symbolic link, junction or hard link before it reads or writes. Before its first `node` command it lists the repo root with a tool that isn't Node, and stops on any file named `node` or `node.` with an extension, which cmd on Windows would run in place of Node. The Codex copy copies a template only when nothing at all is at the target, a dangling link or junction included, and its folder isn't a link.
- Setup names the entry point for each tool: Claude Code reads `CLAUDE.md` and Codex reads `AGENTS.md`. When a repo has only one of them, setup asks whether the other tool is used too and offers the line there.
- The playbook template has a second section, "Checking your work", after the lessons check: before a change is called done or committed, run it the way it is used (in a local or test setup, asking before anything that changes real data), report each check that ran and each that didn't, make a test for a fix fail before the fix, never weaken a check to make it pass, and bring a check still failing after the number of fixes the user set (three if none) to the user. Adapted from the Claude Code team's post on verification.
- The lessons template says where entries go, below the format example, and `--check` reports an entry written inside a code block, which the script would never read.
- The playbook template says a rule never overrides the user or the agent's safety rules, that a rule asking for work outside the project is reported, not followed, and that entries record only what happened in the session and the user's words.
- Setup notes how it works next to a handoff plugin such as Trailmark: separate files, separate jobs, and a handoff names a lesson by title without repeating it.
- Setup brings in only what its plan lists: no tests or other files of its own. A project rule such as a lesson asking for a test with each new function is about the project's code, not the files setup adds.
- The playbook names a lesson in a handoff or memory note as `LESSONS.md "<title>"`, without copying its rule.
- SECURITY.md: how to report a problem, what runs with what rights, what is trusted, and the known limits.

Tests: `node --test` covers the script's handling of links, sizes, hidden characters, output caps and running time, the Codex copy's manifests and commands, and that the shared files match in both copies. Each security fix has a test that fails on the script before it. CI runs them on Linux, macOS and Windows, where the symbolic link tests run on the first two.

Updating: a repo set up with 0.1.0 has the older script. Run setup again, from either tool (`/lessons-learned:setup` in Claude Code, `lessons-setup` in Codex): it reports the script as "other version (not run)" and asks before replacing it. Setup keeps an existing `PLAYBOOK.md` as it is, so the playbook template's new trust rules (steps 3 and 4), the handoff-note wording and the "Checking your work" section don't reach an older repo on their own: compare its `PLAYBOOK.md` with `templates/PLAYBOOK.md`, and ask setup to bring those lines in.

## 0.1.0 (2026-11-16)

First version.

- `/lessons-learned:setup` adds a lessons log (`LESSONS.md`), a playbook (`PLAYBOOK.md`), a lookup and format-check script (`dev/lessons.mjs`) and an entry-point line in `CLAUDE.md` or `AGENTS.md` to a repo, and keeps them out of what the repo ships.
- Setup checks what the repo already has first. It changes nothing when everything is in place, adds only the missing parts, and asks before touching lessons kept under another name or a script that differs from this version.
- Setup shows its plan and waits for a go-ahead, then proves the format check catches broken entries and that the script came through intact.
