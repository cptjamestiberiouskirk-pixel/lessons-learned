# End-to-end runs of the setup skill

`make-test-repos.ps1` and `run-setup.ps1` run `/lessons-learned:setup` in real, headless Claude Code sessions, with the plugin loaded from this checkout. Each turn counts against the account Claude Code is signed in with: the plan's usage with a claude.ai sign-in, or a charge with an API key. The CLI prints a cost of roughly $0.30 to $0.90 for a full scenario; on a plan that is an estimate, not a charge.

```
pwsh -File dev/e2e/make-test-repos.ps1 -Root <new temp folder>
pwsh -File dev/e2e/run-setup.ps1 -Repo <temp folder>/node-app
pwsh -File dev/e2e/run-setup.ps1 -Repo <temp folder>/node-app -SessionId <id from the first run> -Prompt 'Go ahead.' -Resume
```

What each test repo should do:

| Repo | Expected |
|---|---|
| `node-app` | Turn 1 reports all five parts missing except the exclusion (`"files": ["src"]`), shows a plan and waits. After "Go ahead." it builds, every step 5 check passes, and the fingerprint matches. |
| `gotchas-app` | Reports `GOTCHAS.md` as "under another name", stops and asks. Changes nothing. |
| `full-app` | Reports all five present, `--check` 0 bad, fingerprint matching. Changes nothing. |
| `old-script-app` | Reports the script as "present, other version", says what differs (the usage line) and asks before replacing it. |
| `release-app` | Reports the script as "present, release 0.3.1", gives the "0.3.1 to this release" lines and asks before replacing it. Needs the `v0.3.1` tag in this clone. |

The second `node-app` turn can also name an offer, as in `-Prompt 'Go ahead, and add the pre-commit hook.'`. Setup should then write `.githooks/pre-commit`, give the `git config core.hooksPath .githooks` command, and not run it (`git config core.hooksPath` in the repo prints nothing). A plain "Go ahead." takes neither offer.

Don't trust the session's report alone: check the repo afterwards (`git status`, `node dev/lessons.mjs --check`, the fingerprint command in the skill).

Each `run-setup.ps1` run turns off hooks and MCP servers from your own setup, so other plugins don't act on the test repo. `-ReadOnly` runs the session in plan mode, so it can't change files. Use it to try setup on a real repo, such as one that already has the lessons check.

Refused tool calls in the output usually come from the short allow list in `run-setup.ps1`, not from the skill. Through Bash it allows `diff`, `head` and `wc` too, so a session can compare a changed script with the template. A command that reads a file outside the session's folders is refused even when it is allowed, so each turn loads a copy of the plugin from `lessons-e2e/<session id>/` in the temp folder and adds that copy with `--add-dir`. The copy, not this checkout, is what `Write` and `Edit` could reach. Delete `lessons-e2e` when done. It allows `node`, `git`, `npm` and `Get-ChildItem` through PowerShell, but not a command that chains several with `;` or adds others such as `Write-Output`, `Copy-Item` or `Remove-Item`. An interactive session would ask the user instead.

## Live runs with other plugins: `run-live.ps1`

`run-live.ps1` runs one headless turn in Claude Code or Codex with hooks left on, so the user's installed plugins (such as Trailmark) act on the test repo as they would in real use. Use it to test lessons-learned installed next to another plugin, and a repo worked on from both tools.

- `-Tool claude`: loads `plugins/lessons-learned` from this checkout with `--plugin-dir` and switches an installed `lessons-learned@lessons-learned` off for the run. MCP servers stay off.
- `-Tool codex`: uses the installed `lessons-learned-codex`. Install it from this checkout first, from the repo root: `codex plugin marketplace add .` then `codex plugin add lessons-learned-codex@lessons-learned-codex`. After a change to the Codex copy, run `codex plugin remove lessons-learned-codex@lessons-learned-codex` and add it again. If a marketplace named `lessons-learned-codex` is already set up from GitHub, point it here for those two commands only, so `config.toml` is left alone: add `-c marketplaces.lessons-learned-codex.source_type="local" -c "marketplaces.lessons-learned-codex.source='<repo root>'"` to each. Afterwards, remove and add again without `-c` to put the released copy back. Codex runs in its `workspace-write` sandbox; `-AddDir <folder>` makes one more folder writable, such as Trailmark's memory folder.
- `-Log <file>` (required) keeps the raw output: Claude Code's JSON result, or Codex's JSON event stream (`--json`) with the last message beside it in `<file>.last.txt`.

```
pwsh -File dev/e2e/run-live.ps1 -Tool claude -Repo <temp folder>/node-app -Log <temp folder>/s1.json -Prompt '<task>'
pwsh -File dev/e2e/run-live.ps1 -Tool codex -Repo <temp folder>/node-app -Log <temp folder>/s2.jsonl -Prompt '<task>'
```

Check the repo and the other plugin's own state afterwards, not only the replies: `git log`, `node dev/lessons.mjs --check`, and for Trailmark its handoff and `trailmark.js status`.