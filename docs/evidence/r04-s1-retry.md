# R04-S1 Retry — isolation PASS, plugin not loaded yet

Branch `feat/r01-typescript`, HEAD `2f3e914` (probe gate fix) on top of the
WSL-first client work `cb3ad67`. Package under test:
`F:\dsh-test\pkg\dsh-wsl-native-0.8.0-cb3ad67.tgz`, SHA-256
`e56e1739dbdd6e0a7ade55a6c0121853d13ab0c1b705f345579d3b3825c9412f`,
851 897 bytes.

## 1. Isolation cycle — PASS

| Phase | Result |
|---|---|
| `-Phase snapshot` | baseline 3263 files, 0 read errors |
| `-Phase launch` | exit 0, pid 26028, `quit=graceful`, `launch_checks=ok` |
| `-Phase verify` (first run) | **FAIL** — only `test_appdata_fresh` failed |
| `-Phase verify` (after gate fix) | **PASS**, exit 0 |

The first verify failure was a wrong gate, not a leak:

- `app.getPath('logs')` resolves under `userData` on this build, so the run wrote
  `F:\dsh-test\user-data\logs` and never touched `APPDATA`;
- `F:\dsh-test\appdata` stayed empty, which the old gate read as a leak;
- the real leak check (`working_roots_unchanged`) passed: 0 added, 0 changed,
  0 removed across `F:\-ToolBox-\DSH-Data\home`,
  `%APPDATA%\@deepseek-ai\dsh-desktop` and
  `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater`.

Fix in `scripts/r04/isolation-probe.ps1` (commit `2f3e914`): gate 5 is now
`test_appdata_isolated` — fresh files **or** an untouched working tree while the
redirected root stays readable. Selftest grew to 20 checks, all passing.

Fresh evidence from that run: `user-data` (settings, caches, `Local State`,
`DIPS`, `Session Storage`, `background-close-confirmed`), `logs\chromium.log`
(2964 B), `quit_graceful`, `running_processes=0`.

## 2. Install into the isolated profile — PASS

```
DSH_HOME=F:\dsh-test\home  APPDATA=…\appdata  LOCALAPPDATA=…\localappdata
F:\-ToolBox-\DSH\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add
  F:\dsh-test\pkg\dsh-wsl-native-0.8.0-cb3ad67.tgz
```

- `add_exit=0`, `dependencies: + dsh-wsl-native 0.8.0`;
- pnpm store and virtual store both inside `F:\dsh-test\localappdata`;
- `package.json` → `dsh.profile.bundles = ['@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app', 'dsh-wsl-native']`;
- installed copy carries `dsh.bundle.patch`, `dsh.client.inject` (7 packages,
  all present in the installation) and `dist/client.js` with the WSL-first
  markers;
- no Windows Node.js is installed; the CLI runs on the shipped Electron binary
  (`ELECTRON_RUN_AS_NODE=1`), so this is not a blocker.

## 3. Second launch — isolation still PASS, client bundle absent

- launched with `--user-data-dir=F:\dsh-test\user-data`, `APPDATA`,
  `LOCALAPPDATA`, `TEMP`, `DSH_HOME`, update journal all inside `F:\dsh-test`;
- window appeared (`pid=30960`), working roots re-checked while running:
  **3263 = 3263, 0 added, 0 changed, 0 removed**;
- `evidence\window-1.png` shows the stock sidebar: native **New Session**, no
  plugin panel entry, no `New chat in WSL` button;
- `logs\chromium.log` lists **57** client plugin modules and
  `dsh-wsl-native` is not among them.

So the client half is not in the renderer graph. The host half is not observable
from the logs we have: the main process writes to stderr, which the probe did not
capture. Verification of the remaining items (single primary WSL control,
Windows secondary control, RU/EN/ZH switching, unbound shortcut command) needs
that host diagnostic before any UI conclusion is possible.

## 4. Blocked on

Closing the current test instance through **Tray → Quit** (the probe and this
session never call `Stop-Process`), then a relaunch with
`--remote-debugging-port` and stderr redirected to
`F:\dsh-test\logs\host-stderr.log` to read the plugin load error.

No working-profile mutation was observed at any point in this cycle.
