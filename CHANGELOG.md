# Changelog

## 0.3.0 (unreleased)

Ideas taken from Google's Elephant-Goldfish Model, a plugin for designing and reviewing specs with agents: a check that docs still match the code, and review by a reader with no context.

- `node dev/lessons.mjs --stale` lists open and promoted lessons whose `Evidence` names a file in backticks (by its path from the repo root, holding a `/` or ending in an extension that starts with a letter) that is gone, or a `search "text"` after it that the file no longer holds. It is a lead for closing a lesson, not a verdict, and exits 0. It looks a name up under the repo root one part at a time, follows no link (it checks the file's real path too, since a junction to a volume path looks like a folder), reads only a regular file of at most 1 MB with one hard link, searches for at most 200 characters of text, never prints a file's text, and checks at most 100 names.
- The playbook template's step 6 says when to run it: after a change that deletes, moves or renames files, and before a release.
- The playbook template's step 5: before a promoted step goes in, a reviewer with no context (a subagent, where the tool can start one) reads only the step and its lessons, and checks that the step says what their rules say, no more and no less, and can be followed by someone who wasn't in the session. Without one, the session says so and asks the user to read the step.
- The lessons template says what makes a good entry: a rule someone else can follow, about this project, with evidence that can be checked later, and no open lesson that already covers it (if one does, promote that one). The format's `Evidence` line shows the form `--stale` reads: `` `path/from/root`, search "text" ``.
- Setup names the agents that read `AGENTS.md` (Cursor, Windsurf, OpenCode, GitHub Copilot) and offers the entry line in `GEMINI.md` for Gemini CLI, which reads that file unless its settings name `AGENTS.md`. It looks for rules kept in `GEMINI.md` too, and the path check covers it.
- The README notes that a design-review plugin such as Elephant-Goldfish Model works beside this one: it writes specs under `docs/designs/` and review reports, not these files.

Tests: `tests/stale.test.mjs` covers `--stale`. Each of its guards (a link on the way, a junction to a volume path, one into a folder that differs from the repo's only by Unicode case, a repo opened through a link, a name in another case, a hard link, the size limit, the 200-character search limit counted in code points, `..` in a name, the 100-name cap, the 50-lesson cap, the cut of a long name, skipping closed lessons) has a test that fails on a mutant with that guard removed. A growth test fails on a long search text without the limit.

Updating: the playbook and lessons template changes don't reach a repo set up with 0.2.1 or earlier on their own, since setup keeps an existing `PLAYBOOK.md` and `LESSONS.md`. Run setup again to replace the script (it reports "other version (not run)" and asks), and ask it to bring in steps 5 and 6 of "The lessons check" and the lessons header.
## 0.2.1 (unreleased)

Closes the two items left open by 0.2.0's review.

- Both setup skills bring a template in with one copy command that no longer relies on a create-only write, which isn't enough on Windows: through a dangling junction it creates an empty folder where the junction points, and in a probe it wrote through a dangling file symbolic link. It writes the template under a random name beside the target and gives it the target's name with a hard link, which fails on anything at that name and follows no link. If the hard link fails for any other reason (Codex's sandbox on Windows refuses one, and a FAT drive has none), it renames the file into place, which also writes through no link. It refuses a target given as an absolute path, and a source folder or target folder that is a link. It also refuses a target folder or relative source folder whose real path is not the one its path names, such as a junction to a volume path, which 0.2.0 took for a plain folder. At the end it checks that the target's folder is still the one it looked at, and that the target is the very file it wrote, with one name. It also refuses a source that isn't a plain file with one name, or that changes between its look and its read. A repo opened through a junction is accepted, where the 0.2.0 Codex copy refused it.
- The Claude Code skill no longer writes a template straight to its place with the Write tool. It writes it into a staging folder with a random name and brings it in with the same copy command as Codex, so a link made at the target after the path check isn't followed.
- In Claude Code, setup now runs a few more `node` commands (making and removing the staging folder, and one copy for each template), so it may ask for approval more often.
- `--check` keeps a message only for the 50 problems it prints, and counts the rest. A bad `From:` name past those 50 isn't made into a message at all. A `PLAYBOOK.md` with 465,000 bad `From:` names now runs in 40 MB of heap on Node 26, where 0.2.0 needed 256 MB (128 MB against 256 MB on Node 18).

## 0.2.0 (2026-11-16)

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
