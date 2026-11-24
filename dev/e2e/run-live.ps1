# Runs one headless turn in a test repo with this repo's plugin AND the user's
# installed plugins active, hooks included: for testing lessons-learned next to
# another plugin such as Trailmark, in Claude Code or in Codex. Each turn
# counts against the signed-in account: its plan's usage, or a charge with an
# API key. Run with pwsh 7. Unlike run-setup.ps1, the user's own settings,
# hooks and plugins are loaded too.
#
#   ./run-live.ps1 -Tool claude -Repo <dir> -Prompt '<text>' -Log <file.json> [-Settings '<json>']
#   ./run-live.ps1 -Tool codex  -Repo <dir> -Prompt '<text>' -Log <file.jsonl> [-AddDir <dir>]
#                  [-Marketplace <repo root>] [-Resume <thread id>]
#
# Claude Code: this repo's plugins/lessons-learned is loaded with --plugin-dir
# and an installed lessons-learned is switched off for the run, so the copy on
# disk is the one tested. Codex: the installed lessons-learned-codex is used;
# install it from this folder first (dev/e2e/README.md). -AddDir makes one more
# folder writable for Codex, such as Trailmark's memory folder.
# -Marketplace points the lessons-learned-codex marketplace at that folder for
# this run only. Without it, `codex exec` refreshes the marketplace from GitHub
# when it starts and puts the released copy back over one installed from here.
# -Resume sends the prompt as the next turn of that Codex thread.
param(
  [Parameter(Mandatory)][ValidateSet('claude', 'codex')][string]$Tool,
  [Parameter(Mandatory)][string]$Repo,
  [Parameter(Mandatory)][string]$Prompt,
  [Parameter(Mandatory)][string]$Log,
  [string]$AddDir,
  [string]$Marketplace,
  [string]$Resume,
  # Claude Code only: the --settings JSON. Keep the enabledPlugins entry, so an
  # installed lessons-learned stays off and the copy on disk is the one tested.
  [string]$Settings = '{"enabledPlugins": {"lessons-learned@lessons-learned": false}}'
)
$ErrorActionPreference = 'Stop'
# Absolute paths, so -Log and Codex's --cd don't resolve inside the test repo.
$Repo = (Resolve-Path -LiteralPath $Repo).Path
$Log = [IO.Path]::GetFullPath($Log, (Get-Location).Path)
if ($AddDir) { $AddDir = (Resolve-Path -LiteralPath $AddDir).Path }
if ($Marketplace) { $Marketplace = (Resolve-Path -LiteralPath $Marketplace).Path }
Push-Location -LiteralPath $Repo
try {
  if ($Tool -eq 'claude') {
    $plugin = Join-Path $PSScriptRoot '..\..\plugins\lessons-learned' | Resolve-Path
    $allowed = @('Read', 'Glob', 'Grep', 'Write', 'Edit', 'Skill',
      'Bash(node:*)', 'Bash(git:*)', 'Bash(npm:*)', 'Bash(mkdir:*)', 'Bash(rm:*)', 'Bash(ls:*)',
      'Bash(cat:*)', 'Bash(tar:*)', 'Bash(mktemp:*)',
      'PowerShell(node *)', 'PowerShell(git *)', 'PowerShell(npm *)')
    claude -p $Prompt --plugin-dir $plugin --permission-mode acceptEdits --allowedTools @allowed `
      --strict-mcp-config --settings $Settings --output-format json 2>&1 | Out-File -LiteralPath $Log -Encoding utf8
    $j = Get-Content -LiteralPath $Log -Raw | ConvertFrom-Json
    "=== session $($j.session_id)"
    "=== reply"; $j.result
    "=== refused tool calls: $(@($j.permission_denials).Count)"
    foreach ($d in $j.permission_denials) { "- $($d.tool_name): $($d.tool_input | ConvertTo-Json -Compress -Depth 5)" }
    "=== turns $($j.num_turns), cost USD $($j.total_cost_usd), is_error $($j.is_error)"
  } else {
    $codex = (Get-Command codex -ErrorAction SilentlyContinue)?.Source ?? "$env:LOCALAPPDATA\Programs\OpenAI\Codex\bin\codex.exe"
    $extra = if ($AddDir) { @('--add-dir', $AddDir) } else { @() }
    $mk = @()
    if ($Marketplace) {
      $mk = @('-c', 'marketplaces.lessons-learned-codex.source_type="local"',
        '-c', "marketplaces.lessons-learned-codex.source='$Marketplace'")
    }
    $last = "$Log.last.txt"
    if ($Resume) {
      # `exec resume` takes no --cd or --sandbox: it runs in the current folder
      # (the repo, from Push-Location above), and the sandbox is set with -c.
      & $codex @mk exec -c 'sandbox_mode="workspace-write"' resume --json -o $last $Resume $Prompt 2>&1 |
        Out-File -LiteralPath $Log -Encoding utf8
    } else {
      & $codex @mk exec --cd $Repo --sandbox workspace-write @extra --json -o $last $Prompt 2>&1 |
        Out-File -LiteralPath $Log -Encoding utf8
    }
    "=== exit $LASTEXITCODE"
    $thread = Get-Content -LiteralPath $Log | Select-String '"thread.started"' | Select-Object -First 1
    if ($thread) { "=== thread $(($thread.Line | ConvertFrom-Json).thread_id)" }
    # Codex's home is CODEX_HOME, or .codex in the user's home on any system.
    $codexHome = $env:CODEX_HOME
    if (-not $codexHome) { $codexHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
    $cache = Join-Path $codexHome 'plugins/cache/lessons-learned-codex/lessons-learned-codex'
    $installed = @(Get-ChildItem -LiteralPath $cache -Name -ErrorAction SilentlyContinue) -join ', '
    "=== installed lessons-learned-codex: $(if ($installed) { $installed } else { "(none found in $cache)" })"
    "=== reply"; Get-Content -LiteralPath $last -Raw -ErrorAction SilentlyContinue
  }
} finally { Pop-Location }
