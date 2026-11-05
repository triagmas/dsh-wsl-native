# R04-D — minimal local check of package 0.8.0

Scope: verify the shipped 0.8.0 package in the real Desktop 0.2.1-rc.5 against
the existing Ubuntu WSL2 distribution, **without** touching the working profile
and **without** agent commands. Nothing here has been executed; every step needs
the owner's permission.

Working environment that must not change:

| Item | Value |
| --- | --- |
| Desktop installation | `F:\-ToolBox-\DSH` (0.2.1-rc.5, complete, see `docs/r04-isolated-test.md`) |
| Installed CLI | `F:\-ToolBox-\DSH\resources\runtime\cli\bin\dsh.cmd` |
| Owner's Harness home | `F:\-ToolBox-\DSH-Data\home` (`DSH_HOME` in `HKCU\Environment`), 17 third-party plugins |
| WSL | `Ubuntu`, WSL2, default; node v22.23.2, npm 10.9.8 |
| Package under test | `dsh-wsl-native-0.8.0.tgz` built from the agreed commit; record its SHA-256 at build time and quote it with the result (the package contains this document, so a pinned hash would go stale) |

## 0. Already verified without changing anything

| Check | Result |
| --- | --- |
| Package contents | 111 files: `dist/` (62), `docs/` (44), `package.json`, `cordis.patch.yml`, `README.md`, `LICENSE`, `CHANGELOG.md`; no `src/`, no tests, no secrets |
| Bundle wiring | `dsh.bundle.patch = ./cordis.patch.yml` with `insert: [{id: dsh-wsl-native, name: dsh-wsl-native}]`; no manual patch edit needed after `pnpm add` |
| Entries | `main`/`.` → `dist/index.js` (ESM), `./client` → `dist/client.js`, `./service`, `./package.json`; `type: module` |
| Peer range vs installed host | peer `@deepseek-ai/dsh-tools >=0.2.0-rc.2 <0.3.0`; installed `@deepseek-ai/dsh-tools` is **0.2.1-rc.5** → inside |
| Host API used | `defineTool` with `name/description/parameters/isConcurrencySafe/execute` — all supported by the installed `dsh-tools`; `ctx.tools.register`, `ctx.inject`, `ctx.effect`, `ctx.get('profileContext')`, `webServer` service — all present in 0.2.1-rc.5 |
| Client slots used | `main`, `sidebar.panellist`, `sidebar.workspaces`, `sidebar.workspaces.session.menu.item`, `conversation.input.dock`, `conversation.session.header.actions`, `shell.overlay` — all declared by the installed client packages |
| Client bundle size | 241071 / 262144 bytes (loader budget) |
| Client inject list | all seven `@deepseek-ai/dsh-client-*` / `dsh-api-*` packages exist at 0.2.1-rc.5 |
| `doctor` from WSL | WSL channel OK: `Ubuntu`, node v22.23.2, x64, user `triag`; Windows channel `spawn node.exe ENOENT` (no Node.js on Windows — see §1) |
| `list` / `path` | `Ubuntu` WSL2 default; `F:\-ToolBox-\DSH` ↔ `/mnt/f/-ToolBox-/DSH` |
| Package reproducibility | two `npm pack` runs, identical SHA-256 |

## 1. Two real gaps for the first run

1. **Windows Node.js/npm is absent.** `Get-Command node`/`npm` → false;
   `C:\Program Files\nodejs` and nvm absent. The plugin's default install mode is
   `installNetwork: 'auto'`, which on Windows asks Windows npm for its cache
   (`npm config get cache`) and aborts with `NPM_CACHE_REQUIRED` when it cannot.
   The Desktop panel has no setting for this; the CLI does
   (`setup --install-network linux`). Inside Desktop, the Windows channel itself
   does not need Node.js — it runs the Electron binary with
   `ELECTRON_RUN_AS_NODE=1` — so this gap blocks only the dependency install.
2. **The Linux runtime has never been prepared.** `~/.local/share/dsh-wsl-native`
   does not exist, so the first WSL conversation would start with a full download.

## 2. Minimal scenario (all steps need owner permission)

```powershell
$INSTALL = 'F:\-ToolBox-\DSH'
$DSH_CLI = "$INSTALL\resources\runtime\cli\bin\dsh.cmd"
$T       = 'F:\dsh-test'

# 1. test tree only; nothing of the working environment is referenced
New-Item -ItemType Directory -Force -Path "$T\home","$T\user-data","$T\localappdata","$T\pkg","$T\projects\demo" | Out-Null
Copy-Item 'F:\dsh-wsl-native-0.8.0.tgz' "$T\pkg\"        # hash recorded next to the result

# 2. environment for every following DSH command, same shell
$env:DSH_HOME                       = "$T\home"
$env:LOCALAPPDATA                   = "$T\localappdata"
$env:DSH_DESKTOP_UPDATE_JOURNAL_DIR = "$T\update-journal"

# 3. initialize the test profile (one launch, then quit from the tray)
& "$INSTALL\DeepSeek Harness.exe" --user-data-dir "$T\user-data"
```

After the app has been closed completely:

```powershell
# 4. install the package into the test profile through the official CLI
& $DSH_CLI plugin --profile desktop add "$T\pkg\dsh-wsl-native-0.8.0.tgz"
& $DSH_CLI plugin --profile desktop list --depth 0

# 5. launch again and walk the checks below
& "$INSTALL\DeepSeek Harness.exe" --user-data-dir "$T\user-data"
```

Optional, if the owner prefers not to install Node.js on Windows: prepare the
Linux runtime once from WSL, before step 5, so Desktop reuses it instead of
installing:

```bash
node dist/cli.js setup --install-network linux --distro Ubuntu --json
# writes only ~/.local/share/dsh-wsl-native/{runtime,dsh-home}
```

### Checks (no agent commands; UI and local operations only)

1. Panel **WSL 与 Windows** is present in the sidebar; `ru`, `en`, `zh-CN` switch
   and survive a restart; no untranslated key.
2. Distro list shows `Ubuntu`; user and project pickers work.
3. **Start WSL conversation** on `F:\dsh-test\projects\demo`: the Linux runtime is
   prepared or reused, the Linux DSH starts and its page opens in the same window.
4. A WSL conversation is marked `WSL`; switching between Windows and WSL
   conversations keeps both drafts.
5. Terminal in the Linux runtime runs `pwd` / `whoami` and reports the test
   directory and the WSL user.
6. `Protected` is the default; a write outside the workspace and an `exec` on a
   denied root ask or refuse.
7. `Trusted` with a `write` grant on the fake workspace root proceeds in scope and
   still asks outside it.
8. `Full Access` requires the phrase and a lifetime, and returns to `Protected`
   when the window expires.
9. Grants: create, use, revoke, and expiry each change the decision; a Windows
   grant does not authorize a Linux write.
10. Connection recovery: stop only the test runtime, see the notice, reconnect.
11. Nothing outside `F:\dsh-test` and `~/.local/share/dsh-wsl-native` changed; the
    working `F:\-ToolBox-\DSH-Data\home` file names and sizes are identical to a
    snapshot taken before step 3.

### What this cannot show

Windows command execution is not exercised by the panel checks unless a Windows
tool call is made; that call is an agent command and is out of scope here. The
plugin, like the host, runs as the same OS user, so this is a functional check,
not a security boundary.

## 3. Rollback

1. Quit the test Desktop; confirm no `DeepSeek Harness` process and no
   `F:\dsh-test\home\profiles\desktop\lock`.
2. `& $DSH_CLI plugin --profile desktop remove dsh-wsl-native` with the same
   `DSH_HOME`, or delete only `F:\dsh-test\home\profiles\desktop\node_modules\dsh-wsl-native`.
3. Delete exactly `F:\dsh-test` after listing it, and — only if step 5 created it —
   `~/.local/share/dsh-wsl-native`.
4. Re-check the working snapshot; start the working Desktop only if the owner
   asks for it.
