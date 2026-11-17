# Runs one headless turn in a test repo with this repo's plugin AND the user's
# installed plugins active, hooks included: for testing lessons-learned next to
# another plugin such as Trailmark, in Claude Code or in Codex. Each turn is
# billed. Run with pwsh 7. Unlike run-setup.ps1, hooks are left on.
#
#   ./run-live.ps1 -Tool claude -Repo <dir> -Prompt '<text>' -Log <file.json>
#   ./run-live.ps1 -Tool codex  -Repo <dir> -Prompt '<text>' -Log <file.jsonl> [-AddDir <dir>]
#
# Claude Code: this repo's plugins/lessons-learned is loaded with --plugin-dir
# and an installed lessons-learned is switched off for the run, so the copy on
# disk is the one tested. Codex: the installed lessons-learned-codex is used;
# install it from this folder first (dev/e2e/README.md). -AddDir makes one more
# folder writable for Codex, such as Trailmark's memory folder.
param(
  [Parameter(Mandatory)][ValidateSet('claude', 'codex')][string]$Tool,
  [Parameter(Mandatory)][string]$Repo,
  [Parameter(Mandatory)][string]$Prompt,
  [Parameter(Mandatory)][string]$Log,
  [string]$AddDir
)
$ErrorActionPreference = 'Stop'
# Absolute paths, so -Log and Codex's --cd don't resolve inside the test repo.
$Repo = (Resolve-Path -LiteralPath $Repo).Path
$Log = [IO.Path]::GetFullPath($Log, (Get-Location).Path)
if ($AddDir) { $AddDir = (Resolve-Path -LiteralPath $AddDir).Path }
Push-Location -LiteralPath $Repo
try {
  if ($Tool -eq 'claude') {
    $plugin = Join-Path $PSScriptRoot '..\..\plugins\lessons-learned' | Resolve-Path
    $allowed = @('Read', 'Glob', 'Grep', 'Write', 'Edit', 'Skill',
      'Bash(node:*)', 'Bash(git:*)', 'Bash(npm:*)', 'Bash(mkdir:*)', 'Bash(rm:*)', 'Bash(ls:*)',
      'Bash(cat:*)', 'Bash(tar:*)', 'Bash(mktemp:*)',
      'PowerShell(node *)', 'PowerShell(git *)', 'PowerShell(npm *)')
    $settings = '{"enabledPlugins": {"lessons-learned@lessons-learned": false}}'
    claude -p $Prompt --plugin-dir $plugin --permission-mode acceptEdits --allowedTools @allowed `
      --strict-mcp-config --settings $settings --output-format json 2>&1 | Out-File -LiteralPath $Log -Encoding utf8
    $j = Get-Content -LiteralPath $Log -Raw | ConvertFrom-Json
    "=== session $($j.session_id)"
    "=== reply"; $j.result
    "=== refused tool calls: $(@($j.permission_denials).Count)"
    foreach ($d in $j.permission_denials) { "- $($d.tool_name): $($d.tool_input | ConvertTo-Json -Compress -Depth 5)" }
    "=== turns $($j.num_turns), cost USD $($j.total_cost_usd), is_error $($j.is_error)"
  } else {
    $codex = (Get-Command codex -ErrorAction SilentlyContinue)?.Source ?? "$env:LOCALAPPDATA\Programs\OpenAI\Codex\bin\codex.exe"
    $extra = if ($AddDir) { @('--add-dir', $AddDir) } else { @() }
    $last = "$Log.last.txt"
    & $codex exec --cd $Repo --sandbox workspace-write @extra --json -o $last $Prompt 2>&1 |
      Out-File -LiteralPath $Log -Encoding utf8
    "=== exit $LASTEXITCODE"
    "=== reply"; Get-Content -LiteralPath $last -Raw -ErrorAction SilentlyContinue
  }
} finally { Pop-Location }
