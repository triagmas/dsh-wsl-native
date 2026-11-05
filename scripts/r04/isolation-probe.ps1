# R04-S1 isolation probe: launch the test Desktop without touching the working profile.
#
#   -Phase snapshot  take the baseline of every working root (read-only)
#   -Phase launch    start the Desktop with all roots inside -TestRoot, prove the
#                    redirect by observing writes, wait for a Tray -> Quit
#   -Phase verify    compare the working roots with the baseline
#
# The script never kills the process: quitting is a human action (tray icon ->
# Quit). A new file in the working roots during `launch` is reported as
# ISOLATION: FAIL and blocks the plugin install step.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('snapshot', 'launch', 'verify')]
  [string]$Phase,
  [string]$TestRoot = 'F:\dsh-test',
  [string]$InstallRoot = 'F:\-ToolBox-\DSH',
  [int]$ReadyTimeoutSec = 180,
  [int]$QuitTimeoutSec = 900
)

$ErrorActionPreference = 'Stop'

$workingRoots = @(
  'F:\-ToolBox-\DSH-Data\home',
  (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop'),
  (Join-Path $env:LOCALAPPDATA '@deepseek-aidsh-desktop-updater')
)

function Join-Test([string]$name) { Join-Path $TestRoot $name }

function Get-TreeState {
  param([string[]]$Roots)
  $state = @{}
  foreach ($root in $Roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root -Recurse -Force -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\sessions\\' } |
      ForEach-Object {
        $state[$_.FullName.ToLowerInvariant()] = '{0}|{1}' -f $_.Length, $_.LastWriteTimeUtc.ToString('o')
      }
  }
  return $state
}

function Save-Baseline([string]$Path) {
  $state = Get-TreeState -Roots $workingRoots
  $rows = foreach ($key in $state.Keys) { [pscustomobject]@{ Path = $key; State = $state[$key] } }
  $rows | ConvertTo-Json -Depth 2 | Set-Content -LiteralPath $Path -Encoding UTF8
  "baseline_files=$($state.Count) -> $Path"
}

function Read-Baseline([string]$Path) {
  $state = @{}
  foreach ($row in (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)) { $state[$row.Path] = $row.State }
  return $state
}

function Compare-WithBaseline([string]$BaselinePath) {
  $before = Read-Baseline -Path $BaselinePath
  $after = Get-TreeState -Roots $workingRoots
  $added = @($after.Keys | Where-Object { -not $before.ContainsKey($_) })
  $changed = @($after.Keys | Where-Object { $before.ContainsKey($_) -and $before[$_] -ne $after[$_] })
  $removed = @($before.Keys | Where-Object { -not $after.ContainsKey($_) })
  [pscustomobject]@{ Added = $added; Changed = $changed; Removed = $removed }
}

function Show-Delta($Delta, [string]$Label) {
  "$Label added=$($Delta.Added.Count) changed=$($Delta.Changed.Count) removed=$($Delta.Removed.Count)"
  foreach ($path in $Delta.Added) { "  + $path" }
  foreach ($path in $Delta.Changed) { "  * $path" }
  foreach ($path in $Delta.Removed) { "  - $path" }
}

function Assert-InsideTest([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if (-not $value) { throw "REFUSING: $name is not set" }
  $full = [IO.Path]::GetFullPath($value)
  $rootFull = [IO.Path]::GetFullPath($TestRoot).TrimEnd('\') + '\'
  if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "REFUSING: $name=$full is outside $TestRoot"
  }
  return $full
}

# ---------------------------------------------------------------- snapshot

if ($Phase -eq 'snapshot') {
  if (-not (Test-Path -LiteralPath $TestRoot)) { throw "missing $TestRoot" }
  Save-Baseline -Path (Join-Test 'evidence\baseline-working.json')
  return
}

# ---------------------------------------------------------------- launch

if ($Phase -eq 'launch') {
  if (-not (Test-Path -LiteralPath $TestRoot)) { throw "missing $TestRoot" }
  $running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    throw "REFUSING: DeepSeek Harness is already running (pid $($running[0].Id)); the single-instance lock would route the window into it"
  }

  foreach ($dir in @('home', 'user-data', 'appdata', 'localappdata', 'temp', 'update-journal', 'pkg', 'projects\demo', 'logs', 'evidence')) {
    New-Item -ItemType Directory -Force -Path (Join-Test $dir) | Out-Null
  }

  $env:DSH_HOME = Join-Test 'home'
  $env:APPDATA = Join-Test 'appdata'
  $env:LOCALAPPDATA = Join-Test 'localappdata'
  $env:TEMP = Join-Test 'temp'
  $env:TMP = Join-Test 'temp'
  $env:DSH_DESKTOP_UPDATE_JOURNAL_DIR = Join-Test 'update-journal'
  $env:ELECTRON_ENABLE_LOGGING = '1'

  $checked = @{}
  foreach ($name in 'DSH_HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'DSH_DESKTOP_UPDATE_JOURNAL_DIR') {
    $checked[$name] = Assert-InsideTest $name
    "$name=$($checked[$name])"
  }

  $baselinePath = Join-Test 'evidence\baseline-working.json'
  if (-not (Test-Path -LiteralPath $baselinePath)) { Save-Baseline -Path $baselinePath }

  $exe = Join-Path $InstallRoot 'DeepSeek Harness.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw "missing $exe" }

  $userData = Join-Test 'user-data'
  $logFile = Join-Test 'logs\chromium.log'
  $arguments = @(
    "--user-data-dir=$userData",
    '--enable-logging=file',
    "--log-file=$logFile"
  )
  "arguments=$($arguments -join ' ')"
  $startedAt = (Get-Date).ToUniversalTime()
  $process = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru
  $process.Id | Set-Content -LiteralPath (Join-Test 'evidence\pid.txt') -Encoding ASCII
  "pid=$($process.Id)"

  $preferences = Join-Path $userData 'Preferences'
  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
  while (-not (Test-Path -LiteralPath $preferences) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path -LiteralPath $preferences) {
    "ISOLATION: PASS (userData redirected; $preferences exists)"
  }
  else {
    'ISOLATION: FAIL (no Preferences inside the redirected userData)'
  }

  foreach ($relative in 'appdata\@deepseek-ai\dsh-desktop', 'user-data', 'logs') {
    $path = Join-Test $relative
    "$relative exists=$(Test-Path -LiteralPath $path)"
  }

  $delta = Compare-WithBaseline -BaselinePath $baselinePath
  Show-Delta -Delta $delta -Label 'working_roots_while_running'
  if ($delta.Added.Count -gt 0 -or $delta.Changed.Count -gt 0) {
    'ISOLATION: FAIL (working roots changed; do not install the plugin, quit via the tray and report)'
  }
  else {
    'ISOLATION: PASS (working roots untouched)'
  }

  'Now quit the test Desktop from the tray icon -> Quit. The script waits; it never kills the process.'
  $quit = $false
  $quitDeadline = (Get-Date).AddSeconds($QuitTimeoutSec)
  while ((Get-Date) -lt $quitDeadline) {
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { $quit = $true; break }
    Start-Sleep -Seconds 1
  }
  if ($quit) { 'quit=graceful' } else { 'quit=timeout (process still running; quit it from the tray, then run -Phase verify)' }

  $afterDelta = Compare-WithBaseline -BaselinePath $baselinePath
  Show-Delta -Delta $afterDelta -Label 'working_roots_after_run'
  return
}

# ---------------------------------------------------------------- verify

if ($Phase -eq 'verify') {
  $pidFile = Join-Test 'evidence\pid.txt'
  if (-not (Test-Path -LiteralPath $pidFile)) {
    'RESULT: N/A (phase launch has not run yet; no pid recorded)'
    return
  }
  $baselinePath = Join-Test 'evidence\baseline-working.json'
  if (-not (Test-Path -LiteralPath $baselinePath)) { throw "missing $baselinePath" }
  $delta = Compare-WithBaseline -BaselinePath $baselinePath
  Show-Delta -Delta $delta -Label 'working_roots_after_run'
  $userDataOk = Test-Path -LiteralPath (Join-Test 'user-data\Preferences')
  $appdataOk = Test-Path -LiteralPath (Join-Test 'appdata\@deepseek-ai\dsh-desktop')
  $logOk = Test-Path -LiteralPath (Join-Test 'logs\chromium.log')
  "redirected_userData=$userDataOk redirected_appdata_logs=$appdataOk chromium_log=$logOk"
  if ($delta.Added.Count -eq 0 -and $delta.Changed.Count -eq 0 -and $userDataOk) {
    'RESULT: PASS'
  }
  else {
    'RESULT: FAIL'
  }
  return
}
