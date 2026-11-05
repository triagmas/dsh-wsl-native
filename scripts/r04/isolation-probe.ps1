# R04-S1 isolation probe: launch the test Desktop without touching the working profile.
#
#   -Phase selftest   exercise the PASS/FAIL logic without starting the Desktop
#   -Phase snapshot   take the baseline of every working root (read-only)
#   -Phase launch     start the Desktop with all roots inside -TestRoot, wait for a
#                     Tray -> Quit, record evidence
#   -Phase verify     check every gate from docs/r04-s1-fix-runbook.md, exit 0/1
#
# Rules encoded here:
#   * no directory is excluded from a working snapshot (sessions included);
#   * a read error makes the snapshot incomplete and therefore a FAIL;
#   * isolation is proven by files created or updated during *this* run, so the
#     test tree is compared with its own pre-launch state and every artefact must
#     be newer than the recorded start time;
#   * the script never kills the process: quitting is Tray -> Quit;
#   * PASS is printed only by -Phase verify (or -Phase selftest for the logic),
#     every violation exits non-zero.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('selftest', 'snapshot', 'launch', 'verify')]
  [string]$Phase,
  [string]$TestRoot = 'F:\dsh-test',
  [string]$InstallRoot = 'F:\-ToolBox-\DSH',
  [int]$ReadyTimeoutSec = 180,
  [int]$QuitTimeoutSec = 900
)

$ErrorActionPreference = 'Stop'

# Captured before any redirect so that the working roots stay the real ones.
$WorkingAppData = $env:APPDATA
$WorkingLocalAppData = $env:LOCALAPPDATA

function Get-WorkingRoots {
  return @(
    'F:\-ToolBox-\DSH-Data\home',
    (Join-Path $WorkingAppData '@deepseek-ai\dsh-desktop'),
    (Join-Path $WorkingLocalAppData '@deepseek-aidsh-desktop-updater')
  )
}

function Get-TestRoots {
  param([string]$Root)
  return @(
    (Join-Path $Root 'user-data'),
    (Join-Path $Root 'appdata'),
    (Join-Path $Root 'localappdata'),
    (Join-Path $Root 'home'),
    (Join-Path $Root 'logs'),
    (Join-Path $Root 'temp')
  )
}

function Get-TreeState {
  param([string[]]$Roots)
  $state = @{}
  $errors = New-Object System.Collections.ArrayList
  foreach ($root in $Roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $readErrors = $null
    $items = Get-ChildItem -LiteralPath $root -Recurse -Force -File -ErrorAction SilentlyContinue -ErrorVariable readErrors
    foreach ($item in $readErrors) {
      [void]$errors.Add("$root :: $($item.Exception.Message)")
    }
    foreach ($item in $items) {
      try {
        $state[$item.FullName.ToLowerInvariant()] = '{0}|{1}' -f $item.Length, $item.LastWriteTimeUtc.ToString('o')
      }
      catch {
        [void]$errors.Add("$($item.FullName) :: $($_.Exception.Message)")
      }
    }
  }
  return [pscustomobject]@{ State = $state; Errors = @($errors) }
}

function Save-State {
  param($Snapshot, [string]$Path)
  $rows = foreach ($key in $Snapshot.State.Keys) { [pscustomobject]@{ Path = $key; State = $Snapshot.State[$key] } }
  $payload = [pscustomobject]@{ Files = @($rows); Errors = @($Snapshot.Errors) }
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Read-State {
  param([string]$Path)
  $payload = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  $state = @{}
  foreach ($row in $payload.Files) { $state[$row.Path] = $row.State }
  return [pscustomobject]@{ State = $state; Errors = @($payload.Errors) }
}

function Compare-States {
  param($Baseline, $Current)
  $added = @($Current.State.Keys | Where-Object { -not $Baseline.State.ContainsKey($_) })
  $changed = @($Current.State.Keys | Where-Object { $Baseline.State.ContainsKey($_) -and $Baseline.State[$_] -ne $Current.State[$_] })
  $removed = @($Baseline.State.Keys | Where-Object { -not $Current.State.ContainsKey($_) })
  $readErrors = @($Baseline.Errors) + @($Current.Errors)
  return [pscustomobject]@{ Added = $added; Changed = $changed; Removed = $removed; ReadErrors = $readErrors }
}

function Show-Compare {
  param($Delta, [string]$Label)
  "${Label}_added=$($Delta.Added.Count) ${Label}_changed=$($Delta.Changed.Count) ${Label}_removed=$($Delta.Removed.Count) ${Label}_read_errors=$($Delta.ReadErrors.Count)"
  foreach ($path in $Delta.Added) { "  + $path" }
  foreach ($path in $Delta.Changed) { "  * $path" }
  foreach ($path in $Delta.Removed) { "  - $path" }
  foreach ($errorText in $Delta.ReadErrors) { "  ! $errorText" }
}

function Get-FreshFiles {
  param([string[]]$Roots, [datetime]$Since, $Before)
  $current = Get-TreeState -Roots $Roots
  $fresh = New-Object System.Collections.ArrayList
  foreach ($key in $current.State.Keys) {
    $value = $current.State[$key]
    $stamp = [datetime]::Parse($value.Split('|')[1], $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
    if ($stamp -le $Since) { continue }
    if ($null -ne $Before -and $Before.State.ContainsKey($key) -and $Before.State[$key] -eq $value) { continue }
    [void]$fresh.Add($key)
  }
  return [pscustomobject]@{ Files = @($fresh); Errors = $current.Errors }
}

function Get-Verdict {
  param($WorkingDelta, $FreshUserData, [bool]$AppDataIsolated, $FreshLogs, [string]$Quit, [string]$StartedAt)
  $checks = [ordered]@{}
  $checks['start_time_recorded'] = -not [string]::IsNullOrWhiteSpace($StartedAt)
  $checks['working_roots_unchanged'] = ($WorkingDelta.Added.Count -eq 0 -and $WorkingDelta.Changed.Count -eq 0 -and $WorkingDelta.Removed.Count -eq 0)
  $checks['working_roots_readable'] = ($WorkingDelta.ReadErrors.Count -eq 0)
  $checks['test_userdata_fresh'] = ($FreshUserData.Files.Count -gt 0 -and $FreshUserData.Errors.Count -eq 0)
  # app.getPath('logs') resolves under userData on Windows, so a run may never
  # touch APPDATA at all. The requirement is that APPDATA is not used, which is
  # proven either by fresh files inside the redirected root or by an untouched
  # working %APPDATA% (also covered by working_roots_unchanged).
  $checks['test_appdata_isolated'] = $AppDataIsolated
  $checks['test_logs_fresh'] = ($FreshLogs.Files.Count -gt 0 -and $FreshLogs.Errors.Count -eq 0)
  $checks['quit_graceful'] = ($Quit -eq 'graceful')
  $failing = @($checks.Keys | Where-Object { -not $checks[$_] })
  return [pscustomobject]@{ Ok = ($failing.Count -eq 0); Checks = $checks; Failing = $failing }
}

function Show-Verdict {
  param($Verdict, [string]$Title)
  "${Title}:"
  foreach ($name in $Verdict.Checks.Keys) {
    $state = if ($Verdict.Checks[$name]) { 'ok' } else { 'FAIL' }
    "  $name=$state"
  }
  if ($Verdict.Ok) { 'RESULT: PASS' } else { "RESULT: FAIL (failing: $($Verdict.Failing -join ', '))" }
}

function Test-InsideRoot {
  param([string]$Path, [string]$Root)
  $full = [IO.Path]::GetFullPath($Path)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  return $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-InsideTest {
  param([string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name)
  if (-not $value) { throw "REFUSING: $Name is not set" }
  if (-not (Test-InsideRoot -Path $value -Root $TestRoot)) {
    throw "REFUSING: $Name=$value is outside $TestRoot"
  }
  return [IO.Path]::GetFullPath($value)
}

function Read-StartedAt {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return [datetime]::Parse((Get-Content -LiteralPath $Path -Raw).Trim(), $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
}

function Read-QuitState {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return 'missing' }
  return (Get-Content -LiteralPath $Path -Raw).Trim()
}

# ---------------------------------------------------------------- phases

if ($Phase -eq 'snapshot') {
  if (-not (Test-Path -LiteralPath $TestRoot)) { throw "missing $TestRoot" }
  $baselinePath = Join-Path $TestRoot 'evidence\baseline-working.json'
  $snapshot = Get-TreeState -Roots (Get-WorkingRoots)
  Save-State -Snapshot $snapshot -Path $baselinePath
  "baseline_files=$($snapshot.State.Count) read_errors=$($snapshot.Errors.Count) -> $baselinePath"
  if ($snapshot.Errors.Count -gt 0) {
    foreach ($errorText in $snapshot.Errors) { "  ! $errorText" }
    'RESULT: FAIL (the baseline is incomplete)'
    exit 1
  }
  'RESULT: PASS'
  exit 0
}

if ($Phase -eq 'launch') {
  if (-not (Test-Path -LiteralPath $TestRoot)) { throw "missing $TestRoot" }
  $running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    $pids = ($running | ForEach-Object { $_.Id }) -join ', '
    throw "REFUSING: DeepSeek Harness is already running (pids $pids); the single-instance lock would route the window into it"
  }

  foreach ($dir in @('home', 'user-data', 'appdata', 'localappdata', 'temp', 'update-journal', 'pkg', 'projects\demo', 'logs', 'evidence')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $TestRoot $dir) | Out-Null
  }

  $env:DSH_HOME = Join-Path $TestRoot 'home'
  $env:APPDATA = Join-Path $TestRoot 'appdata'
  $env:LOCALAPPDATA = Join-Path $TestRoot 'localappdata'
  $env:TEMP = Join-Path $TestRoot 'temp'
  $env:TMP = Join-Path $TestRoot 'temp'
  $env:DSH_DESKTOP_UPDATE_JOURNAL_DIR = Join-Path $TestRoot 'update-journal'
  $env:ELECTRON_ENABLE_LOGGING = '1'

  foreach ($name in 'DSH_HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'DSH_DESKTOP_UPDATE_JOURNAL_DIR') {
    "$name=$(Assert-InsideTest -Name $name)"
  }

  $baselinePath = Join-Path $TestRoot 'evidence\baseline-working.json'
  if (-not (Test-Path -LiteralPath $baselinePath)) {
    $initial = Get-TreeState -Roots (Get-WorkingRoots)
    Save-State -Snapshot $initial -Path $baselinePath
    "baseline_created=$baselinePath files=$($initial.State.Count) read_errors=$($initial.Errors.Count)"
  }

  $testBeforePath = Join-Path $TestRoot 'evidence\test-tree-before.json'
  $testBefore = Get-TreeState -Roots (Get-TestRoots -Root $TestRoot)
  Save-State -Snapshot $testBefore -Path $testBeforePath
  "test_tree_before_files=$($testBefore.State.Count) read_errors=$($testBefore.Errors.Count)"

  $startedAt = (Get-Date).ToUniversalTime()
  Set-Content -LiteralPath (Join-Path $TestRoot 'evidence\started-at.txt') -Value $startedAt.ToString('o') -Encoding ASCII
  "started_at=$($startedAt.ToString('o'))"

  $exe = Join-Path $InstallRoot 'DeepSeek Harness.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw "missing $exe" }

  $arguments = @(
    "--user-data-dir=$(Join-Path $TestRoot 'user-data')",
    '--enable-logging=file',
    "--log-file=$(Join-Path $TestRoot 'logs\chromium.log')"
  )
  "arguments=$($arguments -join ' ')"
  $process = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru
  Set-Content -LiteralPath (Join-Path $TestRoot 'evidence\pid.txt') -Value $process.Id -Encoding ASCII
  "pid=$($process.Id)"

  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $fresh = Get-FreshFiles -Roots @((Join-Path $TestRoot 'user-data')) -Since $startedAt -Before $testBefore
    if ($fresh.Files.Count -gt 0) { break }
    Start-Sleep -Milliseconds 500
  }

  $workingNow = Compare-States -Baseline (Read-State -Path $baselinePath) -Current (Get-TreeState -Roots (Get-WorkingRoots))
  Show-Compare -Delta $workingNow -Label 'working_while_running'
  $workingOk = ($workingNow.Added.Count -eq 0 -and $workingNow.Changed.Count -eq 0 -and $workingNow.Removed.Count -eq 0 -and $workingNow.ReadErrors.Count -eq 0)

  'Now quit the test Desktop from the tray icon -> Quit. The script waits; it never kills the process.'
  $graceful = $false
  $quitDeadline = (Get-Date).AddSeconds($QuitTimeoutSec)
  while ((Get-Date) -lt $quitDeadline) {
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { $graceful = $true; break }
    Start-Sleep -Seconds 1
  }
  $quitState = if ($graceful) { 'graceful' } else { 'timeout' }
  Set-Content -LiteralPath (Join-Path $TestRoot 'evidence\quit.txt') -Value $quitState -Encoding ASCII
  "quit=$quitState"

  $workingAfter = Compare-States -Baseline (Read-State -Path $baselinePath) -Current (Get-TreeState -Roots (Get-WorkingRoots))
  Show-Compare -Delta $workingAfter -Label 'working_after_run'

  $launchOk = $workingOk -and ($workingAfter.Added.Count -eq 0) -and ($workingAfter.Changed.Count -eq 0) -and ($workingAfter.Removed.Count -eq 0) -and ($workingAfter.ReadErrors.Count -eq 0) -and $graceful
  "launch_checks=" + ($(if ($launchOk) { 'ok' } else { 'FAIL' }))
  'verdict_pending: run -Phase verify for the final result'
  if ($launchOk) { exit 0 } else { exit 1 }
}

if ($Phase -eq 'verify') {
  $evidence = Join-Path $TestRoot 'evidence'
  $pidFile = Join-Path $evidence 'pid.txt'
  if (-not (Test-Path -LiteralPath $pidFile)) {
    'RESULT: FAIL (no launch recorded: evidence\pid.txt is missing)'
    exit 1
  }
  $baselinePath = Join-Path $evidence 'baseline-working.json'
  $testBeforePath = Join-Path $evidence 'test-tree-before.json'
  $startedAtPath = Join-Path $evidence 'started-at.txt'
  foreach ($required in $baselinePath, $testBeforePath, $startedAtPath) {
    if (-not (Test-Path -LiteralPath $required)) {
      "RESULT: FAIL (missing evidence file $required)"
      exit 1
    }
  }

  $startedAt = Read-StartedAt -Path $startedAtPath
  $testBefore = Read-State -Path $testBeforePath
  $workingDelta = Compare-States -Baseline (Read-State -Path $baselinePath) -Current (Get-TreeState -Roots (Get-WorkingRoots))
  Show-Compare -Delta $workingDelta -Label 'working_roots'

  $freshUserData = Get-FreshFiles -Roots @((Join-Path $TestRoot 'user-data')) -Since $startedAt -Before $testBefore
  $freshAppData = Get-FreshFiles -Roots @((Join-Path $TestRoot 'appdata')) -Since $startedAt -Before $testBefore
  $freshLogs = Get-FreshFiles -Roots @((Join-Path $TestRoot 'logs')) -Since $startedAt -Before $testBefore
  "fresh_userdata=$($freshUserData.Files.Count) fresh_appdata=$($freshAppData.Files.Count) fresh_logs=$($freshLogs.Files.Count)"
  foreach ($path in $freshUserData.Files) { "  user-data: $path" }
  foreach ($path in $freshAppData.Files) { "  appdata: $path" }
  foreach ($path in $freshLogs.Files) { "  logs: $path" }
  $workingClean = ($workingDelta.Added.Count -eq 0 -and $workingDelta.Changed.Count -eq 0 -and $workingDelta.Removed.Count -eq 0 -and $workingDelta.ReadErrors.Count -eq 0)
  $appDataIsolated = ($freshAppData.Files.Count -gt 0 -and $freshAppData.Errors.Count -eq 0) -or ($workingClean -and $freshAppData.Errors.Count -eq 0)
  "appdata_isolated=$appDataIsolated (fresh=$($freshAppData.Files.Count), working_clean=$workingClean)"
  "appdata_note=Electron keeps logs under userData on Windows; an empty redirected APPDATA is expected when no crash report is written"

  $quit = Read-QuitState -Path (Join-Path $evidence 'quit.txt')
  $stillRunning = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count
  "quit_state=$quit running_processes=$stillRunning"

  $verdict = Get-Verdict -WorkingDelta $workingDelta -FreshUserData $freshUserData -AppDataIsolated $appDataIsolated -FreshLogs $freshLogs -Quit $quit -StartedAt $startedAt.ToString('o')
  Show-Verdict -Verdict $verdict -Title 'verify'
  if ($verdict.Ok -and $stillRunning -eq 0) { exit 0 } else { exit 1 }
}

if ($Phase -eq 'selftest') {
  # A fresh directory per run keeps the synthetic cases reproducible without
  # deleting anything that already exists under the test tree.
  $root = Join-Path $TestRoot ('selftest\' + (Get-Date).ToString('yyyyMMdd-HHmmss-fff'))
  $failures = New-Object System.Collections.ArrayList
  function Check([string]$Name, [bool]$Condition) {
    if ($Condition) { "  ok   $Name" } else { "  FAIL $Name"; [void]$failures.Add($Name) }
  }

  # 1. comparison detects added, changed and removed files
  $work = Join-Path $root 'work'
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  Set-Content -LiteralPath (Join-Path $work 'keep.txt') -Value 'keep' -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $work 'change.txt') -Value 'one' -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $work 'remove.txt') -Value 'gone' -Encoding ASCII
  $base = Get-TreeState -Roots @($work)
  Set-Content -LiteralPath (Join-Path $work 'added.txt') -Value 'new' -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $work 'change.txt') -Value 'one-two-three' -Encoding ASCII
  Remove-Item -LiteralPath (Join-Path $work 'remove.txt') -Force
  $delta = Compare-States -Baseline $base -Current (Get-TreeState -Roots @($work))
  Check 'compare_added' ($delta.Added.Count -eq 1)
  Check 'compare_changed' ($delta.Changed.Count -eq 1)
  Check 'compare_removed' ($delta.Removed.Count -eq 1)

  # 2. session files are part of the snapshot (nothing is excluded)
  $sessions = Join-Path $work 'sessions'
  New-Item -ItemType Directory -Force -Path $sessions | Out-Null
  Set-Content -LiteralPath (Join-Path $sessions 'session.jsonl') -Value '{}' -Encoding ASCII
  $withSessions = Get-TreeState -Roots @($work)
  Check 'sessions_included' (@($withSessions.State.Keys | Where-Object { $_ -like '*\sessions\*' }).Count -eq 1)

  # 3. read errors count as a failure
  $brokenDelta = [pscustomobject]@{ Added = @(); Changed = @(); Removed = @(); ReadErrors = @('denied :: access') }
  $emptyFresh = [pscustomobject]@{ Files = @(); Errors = @() }
  $oneFresh = [pscustomobject]@{ Files = @('x'); Errors = @() }
  $brokenVerdict = Get-Verdict -WorkingDelta $brokenDelta -FreshUserData $oneFresh -AppDataIsolated $true -FreshLogs $oneFresh -Quit 'graceful' -StartedAt '2026-01-01T00:00:00.0000000Z'
  Check 'read_errors_fail' (-not $brokenVerdict.Ok)
  Check 'read_errors_named' (@($brokenVerdict.Failing) -contains 'working_roots_readable')

  # 4. a clean set passes, each missing condition fails
  $cleanDelta = [pscustomobject]@{ Added = @(); Changed = @(); Removed = @(); ReadErrors = @() }
  $passVerdict = Get-Verdict -WorkingDelta $cleanDelta -FreshUserData $oneFresh -AppDataIsolated $true -FreshLogs $oneFresh -Quit 'graceful' -StartedAt '2026-01-01T00:00:00.0000000Z'
  Check 'clean_case_pass' $passVerdict.Ok
  $noUserData = Get-Verdict -WorkingDelta $cleanDelta -FreshUserData $emptyFresh -AppDataIsolated $true -FreshLogs $oneFresh -Quit 'graceful' -StartedAt '2026-01-01T00:00:00.0000000Z'
  Check 'missing_userdata_fail' (-not $noUserData.Ok)
  $appDataIsolated = Get-Verdict -WorkingDelta $cleanDelta -FreshUserData $oneFresh -AppDataIsolated $true -FreshLogs $oneFresh -Quit 'graceful' -StartedAt '2026-01-01T00:00:00.0000000Z'
  Check 'appdata_isolated_pass' $appDataIsolated.Ok
  $appDataLeak = Get-Verdict -WorkingDelta $cleanDelta -FreshUserData $oneFresh -AppDataIsolated $false -FreshLogs $oneFresh -Quit 'graceful' -StartedAt '2026-01-01T00:00:00.0000000Z'
  Check 'appdata_leak_fail' (-not $appDataLeak.Ok)
  Check 'appdata_leak_named' (@($appDataLeak.Failing) -contains 'test_appdata_isolated')
  $noLogs = Get-Verdict -WorkingDelta $cleanDelta -FreshUserData $oneFresh -AppDataIsolated $true -FreshLogs $emptyFresh -Quit 'graceful' -StartedAt '2026-01-01T00:00:00.0000000Z'
  Check 'missing_logs_fail' (-not $noLogs.Ok)
  $noQuit = Get-Verdict -WorkingDelta $cleanDelta -FreshUserData $oneFresh -AppDataIsolated $true -FreshLogs $oneFresh -Quit 'timeout' -StartedAt '2026-01-01T00:00:00.0000000Z'
  Check 'quit_timeout_fail' (-not $noQuit.Ok)
  $noStart = Get-Verdict -WorkingDelta $cleanDelta -FreshUserData $oneFresh -AppDataIsolated $true -FreshLogs $oneFresh -Quit 'graceful' -StartedAt ''
  Check 'missing_start_time_fail' (-not $noStart.Ok)
  $dirtyDelta = [pscustomobject]@{ Added = @('C:\\work\\new.txt'); Changed = @(); Removed = @(); ReadErrors = @() }
  $dirty = Get-Verdict -WorkingDelta $dirtyDelta -FreshUserData $oneFresh -AppDataIsolated $true -FreshLogs $oneFresh -Quit 'graceful' -StartedAt '2026-01-01T00:00:00.0000000Z'
  Check 'working_change_fail' (-not $dirty.Ok)
  Check 'working_change_named' (@($dirty.Failing) -contains 'working_roots_unchanged')

  # 5. stale artefacts are not evidence
  $freshRoot = Join-Path $root 'fresh'
  New-Item -ItemType Directory -Force -Path $freshRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $freshRoot 'old.txt') -Value 'old' -Encoding ASCII
  $staleSince = (Get-Date).ToUniversalTime().AddHours(1)
  $stale = Get-FreshFiles -Roots @($freshRoot) -Since $staleSince -Before $null
  Check 'stale_not_fresh' ($stale.Files.Count -eq 0)
  $recentSince = (Get-Date).ToUniversalTime().AddHours(-1)
  $recent = Get-FreshFiles -Roots @($freshRoot) -Since $recentSince -Before $null
  Check 'recent_is_fresh' ($recent.Files.Count -eq 1)
  $unchanged = Get-FreshFiles -Roots @($freshRoot) -Since $recentSince -Before (Get-TreeState -Roots @($freshRoot))
  Check 'unchanged_not_fresh' ($unchanged.Files.Count -eq 0)

  # 6. path containment
  Check 'inside_allowed' (Test-InsideRoot -Path (Join-Path $TestRoot 'user-data\Preferences') -Root $TestRoot)
  Check 'outside_refused' (-not (Test-InsideRoot -Path 'C:\Windows\Temp\x' -Root $TestRoot))

  if ($failures.Count -eq 0) { 'RESULT: PASS'; exit 0 }
  "RESULT: FAIL ($($failures -join ', '))"
  exit 1
}
