# R04-S1 — plugin load check in the real Desktop: stopped at the first launch

Date: 2026-11-05. Repo `triagmas/dsh-wsl-native`, branch `feat/r01-typescript`,
HEAD `1e30e64a7699d533de8789bd1681c9b0f93edd73` (matches the expected HEAD).
Nothing was merged; the working profile `F:\-ToolBox-\DSH-Data\home` was not
modified.

## What passed

| Step | Result |
| --- | --- |
| HEAD check | `1e30e64` == expected, tree clean |
| `npm run verify` | typecheck, lint, i18n, **175 tests (173 pass, 2 skipped)**, build, `check:package` — all green |
| Client bundle | 241071 / 262144 bytes |
| Package | `dsh-wsl-native-0.8.0.tgz`, 121 files, 837573 bytes, SHA-256 `98998fbbb03a527069231660a3e3e53375b1a0d5ad03cfc53086cf9e32a2aabf`, reproducible (two packs, same hash) |
| `F:\dsh-test` | absent before the run; created with `home`, `user-data`, `localappdata`, `update-journal`, `pkg`, `projects\demo`, `evidence` |
| Package copy | present in `F:\dsh-test\pkg`, SHA-256 matches the build |
| Snapshot of the working environment | 3252 files recorded before the launch (`evidence\snapshot-before.json`) |
| Launch guard | PowerShell script refused to start if `DSH_HOME`, `LOCALAPPDATA` or `DSH_DESKTOP_UPDATE_JOURNAL_DIR` pointed outside `F:\dsh-test` — all three passed |
| Isolated Harness home | the test profile was created under `F:\dsh-test\home\profiles\desktop` (`package.json`, `cordis.yml`, `cordis.patch.yml`), zero plugins, bundles `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` — i.e. `DSH_HOME` worked |
| Desktop start | pid 25216, window title `DeepSeek Harness`, responding |

## What failed and why the run stopped

`--user-data-dir` did not take effect: `F:\dsh-test\user-data` stayed empty and
Chromium wrote into the real `%APPDATA%\@deepseek-ai\dsh-desktop`.

Cause: the switch was passed as two argv tokens (`--user-data-dir <path>`).
Chromium's command line parser only accepts `--switch=value`; a following token
is treated as a positional argument, so Electron fell back to the default
`userData`. The application itself does not touch `--user-data-dir` and never
calls `app.setPath` (verified in the extracted `main.js`, 516716 bytes).

### Effect on the working environment

| Root | Files before | Files after | Changed |
| --- | --- | --- | --- |
| `F:\-ToolBox-\DSH-Data\home` (working Harness home) | 2882 | 2882 | **0** |
| `%APPDATA%\@deepseek-ai\dsh-desktop` (working Electron userData) | 150 | 153 | 3 new, 17 modified (size or mtime) |

The touched files are Chromium bookkeeping only: `Code Cache\js\*` (3 new),
`Code Cache\js\index-dir\the-real-index`, `DIPS-wal`, `Preferences` (129 bytes,
keys `electron` and `spellcheck` only), `Local Storage\leveldb\*`,
`Session Storage\000003.log`, `blob_storage\*`. No profile, no settings and no
plugin data of the working Harness were created or altered.

### Shutdown

`CloseMainWindow()` did not terminate the process (the app hides to the tray),
so the test instance started by this run (pid 25216) was stopped with
`Stop-Process -Force` after 10 s. No other process was touched.

## Not performed

Steps 6 and 7 of the authorisation — installing the package into the test
profile and checking plugin load, the Windows/WSL panel, `ru`/`en`/`zh-CN`,
Protected/Trusted/Full Access, the permission forms, grants, and console errors —
were **not started**. The instruction to stop immediately on unexpected access to
the working profile was applied. No screenshots and no application logs exist,
because the plugin was never installed and the GUI was not driven.

## Fix prepared, not executed

The launch scenario was corrected after this incident; see
`docs/r04-s1-fix-runbook.md` and `scripts/r04/isolation-probe.ps1`.

1. The switch is now one token, `--user-data-dir=F:\dsh-test\user-data`.
   Chromium's parser accepts only `--switch=value`; the two-token form was the
   whole cause of this incident.
2. `APPDATA` is redirected too, because `app.getPath('logs')` does not follow
   `--user-data-dir` and crash reports would otherwise land in the working
   `%APPDATA%`. `sessionData` needs nothing: the build never calls `setPath`, so
   it equals `userData` and follows the switch.
3. `LOCALAPPDATA` stays redirected: the first run demonstrably wrote
   `node-addon-native-custom-loader\native-cache` into `F:\dsh-test\localappdata`,
   and the updater keeps its download cache there. `TEMP`/`TMP` are redirected
   for the same reason.
4. Isolation is proven by observation, not by the argument: `launch` waits for
   `F:\dsh-test\user-data\Preferences`, checks that
   `F:\dsh-test\appdata\@deepseek-ai\dsh-desktop` and `F:\dsh-test\logs\chromium.log`
   appear, and compares the working roots against a 3261-entry baseline.
5. Quitting is Tray → Quit; the script waits for the process to end and never
   calls `Stop-Process`. `verify` reports `PASS`, `FAIL` or `N/A` (no launch yet).

Status: not executed. A single probe launch is required first, and only a clean
result allows R04-S1 step 6 (plugin install) to continue.

## Artifacts

- `F:\dsh-test\evidence\snapshot-before.json`, `snapshot-after.json`
- `F:\dsh-test\evidence\pid-first.txt`
- `F:\dsh-test\pkg\dsh-wsl-native-0.8.0.tgz` (kept, not cleaned up)
- Launch/stop helper scripts: `%TEMP%\dsh-s1-*.ps1`
