# End-to-end runs of the setup skill

These scripts run `/lessons-learned:setup` in real, headless Claude Code sessions, with the plugin loaded from this checkout. Each turn is billed: a full scenario costs roughly $0.30 to $0.90.

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

Don't trust the session's report alone: check the repo afterwards (`git status`, `node dev/lessons.mjs --check`, the fingerprint command in the skill).

Each run turns off hooks and MCP servers from your own setup, so other plugins don't act on the test repo. `-ReadOnly` runs the session in plan mode, so it can't change files. Use it to try setup on a real repo, such as one that already has the lessons check.

Refused tool calls in the output usually come from the short allow list in `run-setup.ps1` (it doesn't allow PowerShell or chained `echo` commands), not from the skill. An interactive session would ask the user instead.
