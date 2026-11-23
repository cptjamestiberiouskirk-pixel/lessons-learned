# Runs one headless Claude Code turn in a test repo, with this repo's plugin
# loaded from disk (--plugin-dir, not installed). Prints the reply, the tool
# calls that were refused and the CLI's cost. Each turn counts against the
# signed-in account: its plan's usage (the cost is then an estimate), or a
# charge with an API key. Run with pwsh 7.
#
#   ./run-setup.ps1 -Repo <dir>                          first turn: /lessons-learned:setup
#   ./run-setup.ps1 -Repo <dir> -SessionId <id> -Prompt 'Go ahead.' -Resume
#   -ReadOnly   plan mode: the session can't change files (for real repos)
param(
  [Parameter(Mandatory)][string]$Repo,
  [string]$SessionId = [guid]::NewGuid().ToString(),
  [string]$Prompt = '/lessons-learned:setup',
  [switch]$Resume,
  [switch]$ReadOnly
)
$ErrorActionPreference = 'Stop'
$plugin = Join-Path $PSScriptRoot '..\..\plugins\lessons-learned' | Resolve-Path
$allowed = @('Read', 'Glob', 'Grep', 'Write', 'Edit', 'Skill',
  'Bash(node:*)', 'Bash(git:*)', 'Bash(npm:*)', 'Bash(mkdir:*)', 'Bash(cp:*)',
  'Bash(rm:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(tar:*)', 'Bash(mktemp:*)',
  # On Windows the agent may send the same commands through its PowerShell tool.
  'PowerShell(node:*)', 'PowerShell(git:*)', 'PowerShell(npm:*)', 'PowerShell(Get-ChildItem:*)')
$session = if ($Resume) { @('--resume', $SessionId) } else { @('--session-id', $SessionId) }
$mode = if ($ReadOnly) { 'plan' } else { 'acceptEdits' }

Push-Location -LiteralPath $Repo
try {
  # No hooks, plugins or MCP servers from the user's setup: their settings are
  # not loaded, so the run sees only this plugin, its lessons gate included.
  $raw = claude -p $Prompt --plugin-dir $plugin @session --permission-mode $mode `
    --allowedTools @allowed --strict-mcp-config --setting-sources 'project,local' `
    --output-format json 2>&1
} finally { Pop-Location }

$text = ($raw | Out-String)
try { $j = $text | ConvertFrom-Json } catch { "RAW OUTPUT (not JSON):"; $text; exit 1 }
"=== session $SessionId"
"=== reply"; $j.result
"=== refused tool calls: $(@($j.permission_denials).Count)"
foreach ($d in $j.permission_denials) { "- $($d.tool_name): $($d.tool_input | ConvertTo-Json -Compress -Depth 5)" }
"=== turns $($j.num_turns), cost USD $($j.total_cost_usd), is_error $($j.is_error)"
