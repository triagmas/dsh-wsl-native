# R04-S1: launch the test Desktop with real isolation

`--user-data-dir` as two argv tokens is ignored by Chromium: a following token is
a positional argument, so Electron falls back to the default `userData`. The
first R04-S1 run hit exactly that and wrote Chromium cache into the working
`%APPDATA%`. This script passes the switch as one token and proves isolation by
observing writes, not by trusting the argument.

## What has to be redirected, and why

| Path source | Default | Redirect | Evidence |
| --- | --- | --- | --- |
| `app.getPath('userData')` | `%APPDATA%\@deepseek-ai\dsh-desktop` | `--user-data-dir=F:\dsh-test\user-data` | Desktop settings, shortcuts, background-close marker, updater `userDataPath` all read it |
| `app.getPath('logs')` | `%APPDATA%\<name>\logs` (independent of the switch) | `APPDATA=F:\dsh-test\appdata` | `persistCrashReport`, `pruneCrashReports` |
| `sessionData` | equals `userData` unless overridden; never overridden here | covered by the switch | no `setPath`, no `sessionData` in the build |
| updater cache | `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater` | `LOCALAPPDATA=F:\dsh-test\localappdata` | electron-updater `getAppCacheDir()` |
| native addon cache | `%LOCALAPPDATA%\node-addon-native-custom-loader\native-cache` | same | the first run wrote `native-cache\...` into the test tree, not into the working one |
| update journal | unset | `DSH_DESKTOP_UPDATE_JOURNAL_DIR=F:\dsh-test\update-journal` | the first run wrote `1793869427787-*.jsonl` there |
| Harness home | `%USERPROFILE%\.dsh` | `DSH_HOME=F:\dsh-test\home` | the first run created `profiles\desktop` there with zero plugins |
| Chromium log | none | `--enable-logging=file --log-file=F:\dsh-test\logs\chromium.log` | keeps renderer warnings in the test tree |

`APPDATA` is redirected because `logs` does not follow `--user-data-dir`; without
it a crash report would land in the working profile's directory. `TEMP`/`TMP`
are redirected for the same reason — anything the app extracts at startup goes to
the test tree.

## Procedure

```powershell
cd <repo>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\r04\isolation-probe.ps1 -Phase snapshot
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\r04\isolation-probe.ps1 -Phase launch
# click the tray icon -> Quit when the window is up; the launch phase waits for it
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\r04\isolation-probe.ps1 -Phase verify
```

`launch` refuses to start when:

- `F:\dsh-test` is missing,
- any redirected variable resolves outside `F:\dsh-test`,
- a `DeepSeek Harness` process is already running (the single-instance lock would
  route the new window into it, and nothing would be proven).

During the run it polls for `F:\dsh-test\user-data\Preferences` (proof that
Electron actually used the redirected `userData`) and compares the working
`%APPDATA%\@deepseek-ai\dsh-desktop` against the snapshot taken in `snapshot`.
A new file there is reported as `ISOLATION: FAIL` and the run must stop before
installing anything; the script never kills the process.

## Gate before R04-S1 step 6

Install the plugin only when all of these hold:

1. `F:\dsh-test\user-data\Preferences` and `Local State` exist and are newer than
   the launch time.
2. `F:\dsh-test\appdata\@deepseek-ai\dsh-desktop` exists (log directory followed
   `APPDATA`).
3. The working `%APPDATA%\@deepseek-ai\dsh-desktop` has no new file and no size
   change compared with the snapshot.
4. The working `F:\-ToolBox-\DSH-Data\home` is unchanged.
5. The app exited through Tray → Quit (`quit=graceful`).

Otherwise: STOP, no plugin install, report the delta.
