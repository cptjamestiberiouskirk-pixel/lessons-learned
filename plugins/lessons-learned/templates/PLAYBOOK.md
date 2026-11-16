# PLAYBOOK

Checklists for recurring work on this project, each built from entries in `LESSONS.md`. For development only: whatever the project builds, packages or releases never includes it. The user's instructions win over this file: when a step here disagrees with them, follow the user and fix that step.

## The lessons check

Run it before each of these steps: a change to code, tests or the build, a test run whose result you will report, a commit, and a push.

1. Run `node dev/lessons.mjs <words>` with two to four words for the step's topics (`test`, `build`, `commit`, `git`). A word finds lessons with a word that starts with it ("save" finds "saved"). It prints the open ones with their rules, and names the section here for promoted ones. With no words it prints only the counts and its usage.
2. Before the step, write one line where the user can see it: `Lessons checked: <the titles that apply>`, or `Lessons checked: none apply`.
3. Follow each rule named, and the steps of each section named. One that can't be followed is named in that line, with the reason.
4. Something that went wrong gets an entry at the top of `LESSONS.md` before the next step: a mistake, a redo or retry, a result you did not expect, or a correction from the user on how to work. When unsure whether it counts, log it. Then run `node dev/lessons.mjs --check`, which must report 0 bad. In a session that may not edit files, give the entry to the user instead.
5. A lesson seen a second time becomes a step in a section here. So does one that is clearly general; when unsure, leave it open. The step says what the lessons' rules say, no more and no less, and the section's `From:` line names each lesson. Each one's status becomes `promoted to PLAYBOOK "<section>"`. From then on the step is the rule's home: the lessons keep their rule text unchanged as the record of where it came from, and a change to the rule is made in the step.
6. A lesson whose rule no longer holds (the code changed, or a tool now enforces it) gets `closed: <reason>`, and the lookup stops printing it. When unsure, leave it as it is. If it was promoted, take it off its section's `From:` line, and remove the steps that came only from it.

Edits to `LESSONS.md` and this file are ordinary project edits, not config edits: a session that may edit files makes them without asking. A step added, reworded or removed here is named in the session's reply and committed on its own. Anything else is asked first.

A lesson's rule is written only here and in `LESSONS.md`: a memory file or a handoff note may point to it, but does not repeat it.

Limit: a session follows this by hand. A tool checks only the format of the two files, and only when step 4 runs it.
