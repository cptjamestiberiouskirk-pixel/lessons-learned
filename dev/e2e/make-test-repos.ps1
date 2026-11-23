# Makes throwaway git repos for end-to-end runs of /lessons-learned:setup.
# Writes only under -Root, which must not exist yet. Run with pwsh 7.
#
#   node-app        a fresh Node package with a "files" list: setup should plan,
#                   then build all five parts
#   gotchas-app     keeps lessons in GOTCHAS.md: setup should stop and ask
#   full-app        all five parts already in place: setup should change nothing
#   old-script-app  like full-app, but dev/lessons.mjs differs from the plugin's:
#                   setup should report "other version" and ask before replacing
#   release-app     the three files as release 0.3.1 wrote them (from the v0.3.1
#                   tag): setup should report "release 0.3.1", give what changed
#                   since, and ask before replacing
param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Root) { throw "$Root already exists" }
$templates = Join-Path $PSScriptRoot '..\..\plugins\lessons-learned\templates' | Resolve-Path
$checkout = Join-Path $PSScriptRoot '..\..' | Resolve-Path
git -C $checkout rev-parse -q --verify 'refs/tags/v0.3.1' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'release-app needs the v0.3.1 tag: run git fetch --tags' }

function Put($path, $text) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  [IO.File]::WriteAllText($path, $text.Replace("`r`n", "`n"))
}

function NodePackage($dir, $name) {
  Put "$dir/package.json" @"
{
  "name": "$name",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.js",
  "files": ["src"],
  "scripts": { "test": "node --test" }
}
"@
  Put "$dir/src/index.js" "export const add = (a, b) => a + b;`n"
}

$entry = 'Before each step listed under "The lessons check" in `PLAYBOOK.md`, follow that section: it runs `node dev/lessons.mjs` and says when to add to `LESSONS.md`.'

$a = Join-Path $Root 'node-app'
NodePackage $a 'node-app'
Put "$a/CLAUDE.md" "# node-app`n`nA tiny library. Run ``npm test`` before each commit.`n"

$b = Join-Path $Root 'gotchas-app'
Put "$b/README.md" "# gotchas-app`n`nA small service.`n"
Put "$b/GOTCHAS.md" @'
# Gotchas

- 2026-10-03: the config loader reads `.env` only from the repo root. Running from `src/` silently uses defaults. Always run from the root.
- 2026-10-20: `npm run build` leaves stale files in `out/`. Delete `out/` first.
'@
Put "$b/CLAUDE.md" "# gotchas-app`n`nRead GOTCHAS.md before changing the build or config.`n"

foreach ($name in 'full-app', 'old-script-app') {
  $d = Join-Path $Root $name
  NodePackage $d $name
  Put "$d/CLAUDE.md" "# $name`n`n$entry`n`nA tiny library. Run ``npm test`` before each commit.`n"
  Put "$d/LESSONS.md" ([IO.File]::ReadAllText("$templates/LESSONS.md"))
  Put "$d/PLAYBOOK.md" ([IO.File]::ReadAllText("$templates/PLAYBOOK.md"))
  $script = [IO.File]::ReadAllText("$templates/lessons.mjs")
  if ($name -eq 'old-script-app') {
    # A changed copy: no --all mode in the usage line.
    $was = $script
    $script = $script.Replace("[--check | --all | --stale |", "[--check | --stale |")
    if ($script -ceq $was) { throw 'old-script-app: the usage line to change is not in the template' }
  }
  Put "$d/dev/lessons.mjs" $script
}

# release-app: each file byte for byte from the tag, through cmd's redirect, and
# checked against the tag's blob before use.
$e = Join-Path $Root 'release-app'
NodePackage $e 'release-app'
Put "$e/CLAUDE.md" "# release-app`n`n$entry`n`nA tiny library. Run ``npm test`` before each commit.`n"
New-Item -ItemType Directory -Force -Path "$e/dev" | Out-Null
foreach ($pair in @(@('LESSONS.md', 'LESSONS.md'), @('PLAYBOOK.md', 'PLAYBOOK.md'), @('lessons.mjs', 'dev/lessons.mjs'))) {
  $blob = "v0.3.1:plugins/lessons-learned/templates/$($pair[0])"
  $out = Join-Path $e $pair[1]
  cmd /c "git -C `"$checkout`" show $blob > `"$out`""
  if ((git -C $checkout hash-object --no-filters $out) -ne (git -C $checkout rev-parse $blob)) { throw "release-app: $($pair[1]) is not the tag's copy" }
}

foreach ($name in 'node-app', 'gotchas-app', 'full-app', 'old-script-app', 'release-app') {
  $r = Join-Path $Root $name
  git -C $r init -q -b main
  git -C $r -c core.autocrlf=false add -A
  git -C $r -c user.name=Test -c user.email=test@example.invalid commit -q -m 'Initial commit'
  "$name : $(git -C $r log --oneline)"
}
