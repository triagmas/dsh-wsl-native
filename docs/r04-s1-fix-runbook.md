# R04-S1: launch the test Desktop with real isolation

`--user-data-dir` as two argv tokens is ignored by Chromium: a following token is
a positional argument, so Electron falls back to the default `userData`. The
first R04-S1 run hit exactly that and wrote Chromium cache into the working
`%APPDATA%`. This scenario passes the switch as one token and proves isolation by
observing writes, not by trusting the argument.

## What has to be redirected, and why

| Path source | Default | Redirect | Evidence |
| --- | --- | --- | --- |
| `app.getPath('userData')` | `%APPDATA%\@deepseek-ai\dsh-desktop` | `--user-data-dir=F:\dsh-test\user-data` | Desktop settings, shortcuts, background-close marker, updater `userDataPath` all read it |
| `app.getPath('logs')` | `userData\logs` in the shipped build, i.e. `F:\dsh-test\user-data\logs` (it does not follow the switch, but it also does not read `APPDATA`) | `APPDATA=F:\dsh-test\appdata` kept as a guard | `persistCrashReport`, `pruneCrashReports` |
| `sessionData` | equals `userData` unless overridden; never overridden here | covered by the switch | no `setPath`, no `sessionData` in the build |
| updater cache | `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater` | `LOCALAPPDATA=F:\dsh-test\localappdata` | electron-updater `getAppCacheDir()` |
| native addon cache | `%LOCALAPPDATA%\node-addon-native-custom-loader\native-cache` | same | the first run wrote `native-cache\...` into the test tree, not into the working one |
| update journal | unset | `DSH_DESKTOP_UPDATE_JOURNAL_DIR=F:\dsh-test\update-journal` | the first run wrote `1793869427787-*.jsonl` there |
| Harness home | `%USERPROFILE%\.dsh` | `DSH_HOME=F:\dsh-test\home` | the first run created `profiles\desktop` there with zero plugins |
| Chromium log | none | `--enable-logging=file --log-file=F:\dsh-test\logs\chromium.log` | keeps renderer warnings in the test tree |
| `TEMP`/`TMP` | system temp | `F:\dsh-test\temp` | anything the app extracts at startup stays in the test tree |

`APPDATA` is redirected because `logs` does not follow `--user-data-dir`; without
it a crash report would land in the working profile's directory.

## Procedure

```powershell
cd <repo>
$probe = 'scripts\r04\isolation-probe.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $probe -Phase selftest   # logic only
powershell -NoProfile -ExecutionPolicy Bypass -File $probe -Phase snapshot   # working baseline
powershell -NoProfile -ExecutionPolicy Bypass -File $probe -Phase launch     # start + wait for Tray -> Quit
powershell -NoProfile -ExecutionPolicy Bypass -File $probe -Phase verify     # final verdict
```

- `selftest` runs every PASS/FAIL branch on synthetic directories under
  `F:\dsh-test\selftest\<timestamp>` and never starts the Desktop.
- `snapshot` writes `evidence\baseline-working.json`. No directory is excluded —
  `sessions` is part of the snapshot. A read error makes the baseline incomplete
  and the phase exits 1.
- `launch` refuses to start when `F:\dsh-test` is missing, when a redirected
  variable resolves outside it, or when a `DeepSeek Harness` process is already
  running (the single-instance lock would route the window into it). It records
  `evidence\started-at.txt`, snapshots the test tree in
  `evidence\test-tree-before.json`, starts the app, waits for fresh files under
  the redirected `userData`, compares the working roots while the app runs, waits
  for the process to end (Tray → Quit), writes `evidence\quit.txt` and exits 1 on
  any violation. It never prints the final verdict and never kills the process.
- `verify` prints the verdict and exits 0 only when all gates pass.

## Gates checked by `verify` (all must hold)

1. `start_time_recorded` — `evidence\started-at.txt` exists.
2. `working_roots_unchanged` — no added, changed or removed file in
   `F:\-ToolBox-\DSH-Data\home`, `%APPDATA%\@deepseek-ai\dsh-desktop` and
   `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater`, `sessions` included.
3. `working_roots_readable` — the baseline and the final snapshot produced no read
   error; an unreadable file is a FAIL, never a silent omission.
4. `test_userdata_fresh` — files exist under `F:\dsh-test\user-data` that are newer
   than the recorded start time and differ from the pre-launch snapshot.
5. `test_appdata_isolated` — `F:\dsh-test\appdata` holds fresh files, **or** the
   working roots are untouched while the redirected root stays readable.
   The second form is required because `app.getPath('logs')` resolves under
   `userData` on Windows (`F:\dsh-test\user-data\logs`), so a clean run writes no
   crash report at all; an empty redirected `APPDATA` is the expected outcome,
   and the leak it guards against is caught by `working_roots_unchanged`.
6. `test_logs_fresh` — same as gate 4 for `F:\dsh-test\logs` (`chromium.log`).
7. `quit_graceful` — `evidence\quit.txt` says `graceful`; `timeout` is a FAIL.

A file that existed before the run is never accepted as proof: freshness requires
both a modification time after the start and a difference from the pre-launch
snapshot. `verify` also fails when a `DeepSeek Harness` process is still alive.

## Install gate (R04-S1 step 6)

Install the plugin only after `-Phase verify` prints `RESULT: PASS` and exits 0.
Otherwise: no install, keep the evidence, report the delta.
