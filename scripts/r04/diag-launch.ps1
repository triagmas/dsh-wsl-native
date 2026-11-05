param(
  [string]$TestRoot = 'F:\dsh-test',
  [string]$InstallRoot = 'F:\-ToolBox-\DSH',
  [int]$ReadyTimeoutSec = 180
)

# Diagnostic launch: same redirect as the isolation probe, but stdout and stderr
# are captured so a failing plugin load becomes visible instead of a missing
# client module. This script never terminates the application.

$ErrorActionPreference = 'Stop'

if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0) {
  'REFUSING: DeepSeek Harness is already running'
  exit 1
}

$userData = Join-Path $TestRoot 'user-data'
$logs = Join-Path $TestRoot 'logs'
$hostOut = Join-Path $logs 'host-stdout.log'
$hostErr = Join-Path $logs 'host-stderr.log'
foreach ($path in @($userData, $logs)) {
  if (-not (Test-Path $path)) { throw "REFUSING: $path is missing; run -Phase snapshot first" }
}

$env:DSH_HOME = Join-Path $TestRoot 'home'
$env:APPDATA = Join-Path $TestRoot 'appdata'
$env:LOCALAPPDATA = Join-Path $TestRoot 'localappdata'
$env:TEMP = Join-Path $TestRoot 'temp'
$env:TMP = Join-Path $TestRoot 'temp'
$env:DSH_DESKTOP_UPDATE_JOURNAL_DIR = Join-Path $TestRoot 'update-journal'
$env:ELECTRON_ENABLE_LOGGING = '1'

foreach ($name in 'DSH_HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'DSH_DESKTOP_UPDATE_JOURNAL_DIR') {
  $value = [Environment]::GetEnvironmentVariable($name)
  if (-not $value.StartsWith($TestRoot)) { throw "REFUSING: $name=$value is outside $TestRoot" }
}

$startedAt = (Get-Date).ToUniversalTime()
$startedAt.ToString('o') | Set-Content (Join-Path $TestRoot 'evidence\diag-started-at.txt') -Encoding ASCII

$exe = Join-Path $InstallRoot 'DeepSeek Harness.exe'
$arguments = @(
  "--user-data-dir=$userData",
  '--enable-logging=file',
  "--log-file=$(Join-Path $logs 'chromium.log')"
)
$process = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru `
  -RedirectStandardOutput $hostOut -RedirectStandardError $hostErr
$process.Id | Set-Content (Join-Path $TestRoot 'evidence\diag-pid.txt') -Encoding ASCII
"pid=$($process.Id)"
"started_at=$($startedAt.ToString('o'))"
"stderr=$hostErr"
"stdout=$hostOut"

$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
$title = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $running = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
  if (-not $running) { 'process exited before a window appeared'; break }
  if ($running.MainWindowTitle) { $title = $running.MainWindowTitle; break }
}
"window=$title"

# Give the plugin loader time to fail loudly, then report what it wrote.
Start-Sleep -Seconds 20
foreach ($file in @($hostErr, $hostOut)) {
  if (Test-Path $file) {
    $size = (Get-Item $file).Length
    "log=$file bytes=$size"
    if ($size -gt 0) {
      '--- tail ---'
      Get-Content $file -Tail 40
    }
  }
}
