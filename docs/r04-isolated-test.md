# R04 — isolated Desktop integration test (preflight)

Status: **READY for the isolated run once §7 is answered.** The install-path
blocker of the first preflight is resolved: it came from reading the wrong
directory (§0.1). Nothing in this document has been executed: no install, no
Desktop launch, no directories created.

R04 verifies that `dsh-wsl-native@0.8.0` works inside the official DeepSeek
Harness Desktop 0.2.1-rc.5 without touching the owner's working environment. It
is an integration test of the shipped plugin, not a development task.

## 0. Verified environment facts

Everything below was read from the installed build (`app.asar`), from
`dsh-*` packages inside it, and from the file system. The values replace the
guesses in the earlier draft (`DSH_PROFILE_DIR`, `DSH_WSL_HOME`, a separate
`r04-test` profile).

| Item | Verified value | Evidence |
| --- | --- | --- |
| Desktop build | `@deepseek-ai/dsh-desktop` 0.2.1-rc.5, Electron 44.7.0, Node 24.21.0 | `app.asar:/package.json`, crash log header, `dsh/desktop-runtime.json` |
| Install root | **`F:\-ToolBox-\DSH`** | `HKCU\...\Uninstall` entry `InstallLocation`, the Start-menu shortcut, `Uninstall DeepSeek Harness.exe` |
| Installed CLI | `F:\-ToolBox-\DSH\resources\runtime\cli\bin\dsh.cmd` (sets `ELECTRON_RUN_AS_NODE=1` itself) | the file's own contents, `apps/desktop/README.md` |
| Stale directory | `C:\Users\<owner>\AppData\Local\Programs\DeepSeek Harness` — **not an installation**, do not use (§0.1) | no registry entry, no uninstaller, 1582 of 1583 unpacked files missing |
| Harness home | `$DSH_HOME`, else `%USERPROFILE%\.dsh` | `dsh-home-paths`: `DSH_HOME_ENV`, `DSH_HOME_DIR_NAME` |
| Profiles root | `$DSH_HOME\profiles\<name>` | `dsh-app-boot`: `PROFILES_DIR`, `resolveProfileDir()` |
| Profile the Desktop boots | **always** `$DSH_HOME\profiles\desktop` | `main.js`: `activeProject = resolveDesktopPaths().profile` |
| Profile lock | `$DSH_HOME\profiles\desktop\lock` | `resolveDesktopPaths()`, `withFileLock` |
| `DSH_HOME` reaches the host | yes on Windows; the login-shell environment read returns the inherited environment unchanged on `win32` | `desktopNodeEnvironment()`, `readDesktopLoginShellEnvironment()` |
| Plugin install target | `profiles\desktop` of the **same** `DSH_HOME` | `dsh plugin --profile <name>` → `resolveProfileDir()` |
| Supported install CLI | `<install>\resources\runtime\cli\bin\dsh.cmd`, which runs `<install>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js` under Electron in Node mode with `manageDesktopProfile: true` | the `.cmd` file, `dsh-desktop-host/lib/cli.js` |
| pnpm used by that CLI | `<install>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs` | same file, `runDesktopCli(runtimeDir, supportDir)` |
| Electron userData | `app.getPath("userData")`; **no `app.setPath` call in the build**, so `--user-data-dir` is honoured | `main.js` |
| Desktop shell state | `readDesktopSettings(userData)`, `<userData>\desktop\settings.json`, `<userData>\logs`, `<userData>\background-close-confirmed`, shortcut bookkeeping under `<userData>` | `main.js` |
| Updater cache | `%LOCALAPPDATA%\<appName>-updater`, **not** under userData | `electron-updater/out/AppAdapter.js` `getAppCacheDir()` |
| pnpm environment | every `DSH_*` variable and secret-looking variable is stripped before pnpm runs | `dsh-subprocess` `scrubbedParentEnv()` |
| Office engine target | `$DSH_HOME\dsh-runtimes\dsh-primary-runtime` | `dsh-desktop-host/lib/index.js` |

Consequences that drive the plan:

1. There is no per-profile environment variable. Isolation means pointing
   `DSH_HOME` at a fresh directory; `profiles\desktop` then lives inside it.
2. The Desktop cannot be told to boot another profile, so the plugin must be
   installed into `profiles\desktop` **of the test `DSH_HOME`**. Installing into
   any other profile name would never load.
3. `--user-data-dir` covers window state, desktop settings and logs, but **not**
   the updater cache: `%LOCALAPPDATA%` must be redirected as well, or the test
   writes into the working installation's update cache.
4. `dsh plugin` needs the profile lock free, so the Desktop must be fully quit
   (tray → Exit), not merely closed to the tray.

### 0.1 Why `resources/runtime` appeared to be missing

The first preflight inspected `C:\Users\<owner>\AppData\Local\Programs\DeepSeek Harness`
and concluded that the installation had no runtime. That directory is **not the
installation**. Verified facts:

| Fact | Value |
| --- | --- |
| Registry (`HKCU\...\Uninstall`, key `1bf39983-…`) | `InstallLocation = F:\-ToolBox-\DSH`, `DisplayVersion = 0.2.1-rc.5`, uninstaller present there |
| Start-menu shortcut | `F:\-ToolBox-\DSH\DeepSeek Harness.exe` |
| Package under test, real install | `resources/runtime/{bin,cli,office-skills,primary-runtime,versions.json}` all present; `versions.json` = node 24.21.0, pnpm 11.28.5; `primary-runtime/runtime.json` = python 3.12.14 + wheel map; `runtime/cli/bin/dsh.cmd` present |
| Integrity of the packed runtime | `desktop-runtime.json` lists 17187 files; all exist in the asar (13-file SHA-256 spot check: no mismatch); 1583 unpacked entries exist in `app.asar.unpacked` — **1583 of 1583** |
| Chromium payload next to the exe | `icudtl.dat`, `locales\`, `resources.pak`, `chrome_*_percent.pak`, `snapshot_blob.bin`, `LICENSES.chromium.html`, `app-update.yml`, `default_app.asar`, `tray.ico`, `icon.png`, `elevate.exe` — present |
| Stale directory on C: | only `DeepSeek Harness.exe`, `resources\app.asar` (same SHA-256 as the F: copy) and one `koffi.node`; **no** `locales`, `icudtl.dat`, `*.pak`, `app-update.yml`, `resources\runtime`, uninstaller, or 1582 of the 1583 unpacked files |

The residue is the documented uninstaller behaviour: it "keeps deleting siblings
after a locked file; residue never stops uninstallation and is not reported"
(`apps/desktop/README.md`). The three surviving files are exactly the ones a
running instance holds open — the exe, the asar and the loaded native module. So
the stale directory is left over from the pre-F: installation, removed on
2026-11-04 12:28 while the application was running, and everything else moved to
`F:\-ToolBox-\DSH`.

Consequences for R04:

- Nothing needs to be repaired or reinstalled. The runtime, pnpm, Chromium
  payload and update feed exist in the real installation.
- The stale C: directory must not be used, deleted or "repaired" during R04.
- The two installations are the same release: both `app.asar` files hash to
  `e1b6f25fa937da98…`, so the earlier findings about profile layout, userData
  and `--user-data-dir` still hold.

## 1. Test tree

Windows, on `F:` (local fixed NTFS, 113 GB free), a new directory that does not
exist yet:

```text
F:\dsh-r04\
  dsh-home\                     DSH_HOME for the test: profiles, sessions, credentials, runtimes
    profiles\desktop\           the only profile the Desktop boots; plugin install target
  user-data\                    Electron --user-data-dir
  localappdata\                 LOCALAPPDATA override: updater cache and other per-user caches
  update-journal\               DSH_DESKTOP_UPDATE_JOURNAL_DIR
  projects\                     fake projects, one per scenario
    demo-windows\               plain folder, no symlinks, no junction
  pkg\dsh-wsl-native-0.8.0.tgz  the package under test (SHA-256 recorded)
  evidence\                     transcripts, screenshots, `Get-ChildItem` listings
  snapshot-before.json          manifest of the working environment (§6)
```

Linux side (only with a dedicated WSL distribution, see §3): the plugin config
`nativeRoot` points at `/home/r04/dsh-r04/native`, giving the runtime
`/home/r04/dsh-r04/native/runtime` and the Linux DSH home
`/home/r04/dsh-r04/native/dsh-home`.

Not used as test roots: `%TEMP%`, the owner's `%USERPROFILE%`, `C:\Users\<owner>\.dsh`,
`%APPDATA%\@deepseek-ai\dsh-desktop`, `%LOCALAPPDATA%\Programs\DeepSeek Harness`,
and any existing project directory.

### 1.1 Checks before any file is created

```powershell
# the test root must not exist
Test-Path 'F:\dsh-r04'                       # must be False
# F: is a real local volume, not a network or removable mount
fsutil fsinfo drivetype F:                   # "Fixed"
# nothing to traverse into: the path has no parent links
# (F:\dsh-r04 does not exist, so there are no reparse points on it yet;
#  after creation, verify with:)
fsutil reparsepoint query 'F:\dsh-r04'       # must report no reparse point
# the working profile must not be reused
Test-Path 'F:\dsh-r04\dsh-home\profiles\desktop\package.json'   # must be False
```

`F:\` itself contains a junction (`F:\BL4`) and the owner's directories
(`_hermes`, `CODE`, `hermes`, `LLM`, …). The test never traverses them, but they
remain readable by anyone who can read `F:` — which is why §3 matters.

The fake projects are created with `New-Item -ItemType Directory`; afterwards
`fsutil reparsepoint query` on each one must report no reparse point. No file
from the owner's work is copied, linked or opened.

## 2. Launch sequence

One PowerShell window, one session. `DSH_HOME` must be set in the same session
as every DSH command; a new terminal without it would target the working profile.

```powershell
$INSTALL = 'F:\-ToolBox-\DSH'                       # verified InstallLocation, never the stale C: copy
$DSH_EXE = "$INSTALL\DeepSeek Harness.exe"
$DSH_CLI = "$INSTALL\resources\runtime\cli\bin\dsh.cmd"   # sets ELECTRON_RUN_AS_NODE itself
$R04     = 'F:\dsh-r04'

$env:DSH_HOME                         = "$R04\dsh-home"
$env:LOCALAPPDATA                     = "$R04\localappdata"
$env:DSH_DESKTOP_UPDATE_JOURNAL_DIR   = "$R04\update-journal"

# guard: refuse to continue unless the test home is the active one
if (-not $env:DSH_HOME.StartsWith("$R04\")) { throw 'refusing: DSH_HOME is not the R04 test home' }
if (Test-Path "$env:DSH_HOME\profiles\desktop\package.json") { throw 'refusing: test profile already initialized' }

New-Item -ItemType Directory -Force -Path $env:DSH_HOME,"$R04\user-data","$R04\localappdata","$R04\update-journal","$R04\projects","$R04\pkg","$R04\evidence" | Out-Null
```

1. **First launch — initializes the test profile.** The Desktop creates and owns
   `profiles\desktop`; the CLI refuses to run against an uninitialized profile.

   ```powershell
   & $DSH_EXE --user-data-dir "$R04\user-data"
   ```

   Expected observables: the welcome window appears; `$env:DSH_HOME\profiles\desktop\package.json`
   and `lock` exist; `$R04\user-data\desktop\settings.json`, `$R04\user-data\Local State`,
   `$R04\user-data\logs` appear; `%APPDATA%\@deepseek-ai\dsh-desktop` gains nothing
   new (§6 compares snapshots).

2. **Quit fully.** Tray → Exit. Then verify:

   ```powershell
   Get-Process | Where-Object { $_.Path -eq $DSH_EXE }     # must be empty
   Test-Path "$env:DSH_HOME\profiles\desktop\lock"         # must be False
   ```

3. **Install the plugin into that profile.**

   ```powershell
   & $DSH_CLI plugin --profile desktop add "$R04\pkg\dsh-wsl-native-0.8.0.tgz"
   ```

   `dsh.cmd` starts the Electron binary in Node mode with the bundled pnpm from
   `resources\runtime\primary-runtime\dependencies\pnpm`, so no system Node or
   pnpm is needed (verified present, §0.1). `dsh-wsl-native` ships
   `dsh.bundle.patch`, so pnpm alone wires the bundle layer; no manual patch edit
   is needed. The installed command refuses an uninitialized Desktop profile
   instead of creating one, which is why step 1 must come first.

   Verify before launching:

   ```powershell
   Select-String -Path "$env:DSH_HOME\profiles\desktop\package.json" -Pattern 'dsh-wsl-native'
   Get-ChildItem "$env:DSH_HOME\profiles\desktop\node_modules\dsh-wsl-native" | Select-Object Name
   # cordis.yml is an empty entry list by design; the bundle layer comes from
   # package.json's dsh.profile.bundles plus the package's own dsh.bundle.patch
   ```

   Only `<test DSH_HOME>\profiles\desktop` may change in this step. The owner's
   working home is `F:\-ToolBox-\DSH-Data\home` (from `HKCU\Environment`) and
   must not change; if it does, stop and roll back.

4. **Second launch — the test run.**

   ```powershell
   & $DSH_EXE --user-data-dir "$R04\user-data"
   ```

   Confirm the Desktop boots the test profile, not the working one: while it
   runs, `$env:DSH_HOME\profiles\desktop\lock` exists and its mtime is current,
   while `F:\-ToolBox-\DSH-Data\home\profiles\desktop` mtimes stay at the values
   recorded in `snapshot-before.json`.

Re-running the guard in step 0 before each DSH command is required; the
`DSH_HOME` value is the only thing that decides which profile is used.

### 2.1 Not needed

The earlier pnpm-free fallback is withdrawn: the bundled pnpm exists in the real
installation, so the supported command works. Do not place files into a profile
by hand.

## 3. Isolation from the working Windows user

Same-account isolation (`DSH_HOME` + `--user-data-dir` + `LOCALAPPDATA`) separates
**state**, not **authority**: the test still runs as the owner, and the agent's
Linux shell can reach Windows through WSL interop (`powershell.exe`, `/mnt/c/…`)
regardless of the plugin. Three options:

| Option | What it isolates | Cost / limit |
| --- | --- | --- |
| **A. Separate local Windows account `dshr04` + WSL distribution registered under it** | the whole user context: own `%USERPROFILE%`, `%APPDATA%`, `%LOCALAPPDATA%`, own WSL distro, its own interop target | needs an administrator once. **`F:` is a shared volume**: by default other local users can read `F:\_hermes`, `F:\CODE`, etc. The account alone is *not* protection unless the owner adds explicit deny ACEs for `dshr04` on those directories (an owner-side ACL change, not part of R04) |
| **B. Same account, state-only isolation** | profile, userData, caches | no admin; every "isolation" result must be reported as state-only. Interop and `F:` remain reachable |
| **C. Hyper-V or VMware VM with only `F:\dsh-r04` shared** | strongest and disposable | needs a hypervisor plus nested virtualization for WSL2; nothing of the owner's Windows is reachable except the share |

Recommendation: **A** if the owner accepts one local account, one WSL
distribution and the ACL decision on `F:`; otherwise **C**; **B** only if the
goal is a functional check and the report states plainly that isolation was not
execution-level.

Do not edit `/etc/wsl.conf`, `.wslconfig`, or global WSL settings to disable
interop: that is a machine-wide change outside this test.

### 3.1 What this machine has today

| Item | State | Consequence |
| --- | --- | --- |
| OS | Windows 10 Pro, build 26300.9711, 16 logical CPUs, 31.1 GiB RAM | a VM is feasible: 4 vCPU / 12 GiB / 60 GB leaves the host usable |
| Hypervisor | `HypervisorPresent = True`, `vmcompute` running, but no `vmms.exe` and no Hyper-V PowerShell module | only the WSL2 platform is enabled; the Hyper-V role is **not** installed |
| Windows Sandbox | `WindowsSandbox.exe` absent, feature not enabled | and WSL2 is not supported inside Windows Sandbox, so it is not an option for R04 |
| VMware | `C:\Program Files\VMware\VMware Workstation` holds only `darwin.iso` / `darwinPre15.iso` | Workstation itself is not installed |
| WSL | one distribution, `Ubuntu`, version 2, running | a second distribution can be registered without touching this one |
| Free space | C: 59.5 GiB, F: 104.9 GiB | enough for a VM image on F: or C: |
| Working Harness home | `DSH_HOME = F:\-ToolBox-\DSH-Data\home` (HKCU), 17 third-party plugins, Electron data still under `%APPDATA%` on C: | R04 must never point at this home |

### 3.2 Requirements if option C is chosen

1. Enable a hypervisor: the Hyper-V role (Windows 10/11 Pro, administrator,
   reboot) or VMware Workstation 17 (nested VT-x/EPT). Both are machine changes
   and need explicit owner approval.
2. Nested virtualization must be on for the guest — `Set-VMProcessor
   -ExposeVirtualizationExtensions $true` on Hyper-V, "Virtualize Intel VT-x/EPT"
   on VMware. Without it `wsl --install` fails inside the guest.
3. Guest resources: Windows 10/11 Pro x64, 4 vCPU, 12 GiB RAM, 60–80 GB disk.
4. Inside the guest: `wsl --install -d Ubuntu`, then install Desktop 0.2.1-rc.5
   from the same installer and run §2 with the guest's own paths.
5. Shares: expose only `F:\dsh-r04` (or nothing, passing the package by ISO).
   Disable clipboard/file sharing and other guest integrations for the run.
6. Rollback is deleting the VM; the host install, its profile and its plugins are
   never involved.

## 4. Scenario checklist

Each item records an observable and an artifact under `F:\dsh-r04\evidence`.
No real project is opened and no real API key is used; model calls are not part
of the checks (the panel, the host and the Linux runtime can be exercised without
a completed conversation). If a check needs a model, use the local/fake endpoint
only.

| # | Check | Pass condition |
| --- | --- | --- |
| 1 | Plugin install | `plugin --profile desktop add` exits 0; `node_modules\dsh-wsl-native` present; profile `package.json` lists it; nothing outside the test tree changed |
| 2 | Desktop starts isolated | app window opens; `<test DSH_HOME>\profiles\desktop\lock` created; working `~/.dsh` mtimes unchanged |
| 3 | Panel and three languages | "WSL 与 Windows" panel is visible; `ru`, `en`, `zh-CN` switch from the UI; the choice survives a restart; no untranslated key is shown |
| 4 | Linux host startup | clicking the WSL start button prepares the runtime under the test `nativeRoot` and reports the Linux `DSH_HOME`; no file appears under `~/.local/share/dsh-wsl-native` of the working user |
| 5 | Fake project | a WSL conversation opens on `projects\demo`-equivalent inside the test tree; the workspace shown is the fake one, never an owner directory |
| 6 | WSL terminal | a terminal opens in the Linux runtime and runs `pwd` / `whoami`; output matches the test distro and test directory |
| 7 | Protected mode | the default mode is `Protected`; a write outside the workspace and an `exec` on a denied root ask or refuse; both are recorded |
| 8 | Trusted mode | granting `write` on the fake workspace root lets an in-scope write proceed without a second prompt; an out-of-scope write still asks |
| 9 | Full Access | the form requires the phrase and a duration; after the chosen window the mode returns to `Protected` and the same operation asks again |
| 10 | Grants and revocation | a grant created from the form authorizes only its target and root; revoking it makes the same operation ask; expiry does the same |
| 11 | Connection recovery | killing the Linux runtime (only the test one) shows a recovery notice and the reconnect restores the conversation; the Windows side keeps working |
| 12 | No changes to the working environment | §6 snapshot diff is empty apart from allowed entries |

## 5. Read / write inventory

Read by the test:

- `<install>\**` — `DeepSeek Harness.exe`, `resources\app.asar`,
  `resources\app.asar.unpacked` (read-only).
- `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\installer.exe` — only if an
  update check runs; never written by the test when `LOCALAPPDATA` is redirected.
- Windows system files, DLLs, fonts, `%SystemRoot%\System32`, the WSL
  distribution's own files.
- `F:\dsh-r04\**` — the test tree.
- With option A: the test account's own profile only.

Written by the test:

- `<test DSH_HOME>` = `F:\dsh-r04\dsh-home`:
  `.anonymous-user-id`, `sessions\`, `storages\`, `attachments\`, `dsh-memento\`,
  and a credentials file **only** if a sign-in step is performed — R04 must not
  sign in with production credentials,
  `profiles\desktop\` (`package.json`, `pnpm-lock.yaml`, `node_modules\`,
  `cordis.yml`, `cordis.patch.yml`, `pnpm-workspace.yaml`, `lock`,
  `.plugin-manager\logs\`), `dsh-runtimes\dsh-primary-runtime\`.
- `<test userData>` = `F:\dsh-r04\user-data`: `desktop\settings.json`,
  `background-close-confirmed`, `logs\`, `Local State`, `Cache`, `Code Cache`,
  `GPUCache`, `DIPS`, shortcut bookkeeping.
- `<test LOCALAPPDATA>` = `F:\dsh-r04\localappdata`: `<appName>-updater\`,
  and any per-user cache Electron derives from it.
- `<test update journal>` = `F:\dsh-r04\update-journal`.
- Linux: `<test nativeRoot>\runtime`, `<test nativeRoot>\dsh-home`, plus the
  package manager cache of that distribution.
- Unavoidable outside the test tree, and recorded as such:
  `%APPDATA%\Microsoft\Windows\Recent` (jump lists, from the shell),
  Windows event/temp files, and GPU shader caches under the driver.

Never touched: the owner's working home `F:\-ToolBox-\DSH-Data\home` (with its 17
third-party plugins), the installed application `F:\-ToolBox-\DSH`, the stale
`C:\Users\<owner>\AppData\Local\Programs\DeepSeek Harness` copy, the owner's
Electron userData, both updater caches, any owner project, any other WSL
distribution.

## 6. Snapshot and rollback

Before the first launch, record a manifest of the working environment
(read-only, no file content leaves the machine):

```powershell
# the owner's working roots, as configured in HKCU\Environment and on disk
$paths = @('F:\-ToolBox-\DSH-Data\home', "$env:APPDATA\@deepseek-ai\dsh-desktop")
Get-ChildItem -Recurse -Force -File $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\sessions\\|\\.credentials\.yaml$' } |
  Select-Object FullName, Length, LastWriteTimeUtc |
  ConvertTo-Json -Depth 2 | Set-Content 'F:\dsh-r04\snapshot-before.json'
```

After the last launch, repeat into `snapshot-after.json` and compare. Allowed
differences: none under `F:\-ToolBox-\DSH-Data\home` (file names and sizes are
compared, not contents, and session files are excluded to avoid reading chats);
only `logs\` growth under the working userData, and only if the working app was
started at all — it must not be during R04.

Rollback, in order, without deleting anything that is not ours:

1. Quit the test Desktop completely; verify no process and no test lock file.
2. Remove the plugin from the test profile with the same CLI and the same
   `DSH_HOME` (`plugin --profile desktop remove dsh-wsl-native`), or delete only
   `<test DSH_HOME>\profiles\desktop\node_modules\dsh-wsl-native`.
3. Verify the working environment: `snapshot-after.json` vs `snapshot-before.json`,
   then confirm the working Desktop still starts normally **outside** R04.
4. List the test tree, then delete exactly that path:
   `Get-ChildItem -Recurse 'F:\dsh-r04' | Measure-Object` and
   `Remove-Item -Recurse -Force 'F:\dsh-r04'`. No wildcards, no `%TEMP%`, no
   `~`, no owner directory.
5. With option A: unregister only the distribution and the account created for
   R04, after listing them. The owner's profile, projects and existing
   distribution stay untouched.
6. Keep `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\installer.exe` — it
   belongs to the working installation.

## 7. Owner actions required before R04

1. **Nothing to repair.** The real installation `F:\-ToolBox-\DSH` is complete,
   including `resources\runtime`; the earlier blocker was a stale directory on
   C: (§0.1). Only decide whether the leftover C: copy may stay untouched for the
   whole run — it must not be used, repaired or deleted during R04.
2. **Choose the isolation level** from §3 (A, B or C), and for A approve one
   local Windows account, one WSL distribution, and the decision about ACLs on
   the shared `F:` volume.
3. **Approve the paths**: create `F:\dsh-r04` and its subdirectories, and the
   test `nativeRoot` for the Linux runtime.
4. **Guarantee the working Desktop is closed** for the whole run, so the working
   profile and its lock are never involved.
5. **Confirm no credentials are needed**: the checks must run without production
   API keys; if a model is required, name the local/fake endpoint to use.
6. **Confirm the package**: `dsh-wsl-native-0.8.0.tgz` built from the agreed
   commit. Record its SHA-256 next to `snapshot-before.json` at R04 start and
   quote it in the result; the hash is not pinned here because the package
   contains this document.

## 8. What this scenario cannot prove

- That the plugin is safe to install into a **working** profile. R04 runs in a
  disposable one; it does not test migration of existing sessions or plugins.
- That Windows execution is isolated from the agent. The plugin forwards Windows
  commands and runs as the same OS user; R04 checks behaviour, not a security
  boundary. Under option A the boundary comes from the account and the ACLs, not
  from the plugin.
- That a repaired installation behaves like the current one: after the runtime
  is restored, the first checks must re-confirm version, profile path and
  `--user-data-dir` behaviour.
- Anything about the working profile's third-party plugins: the working
  installation already carries entries that are not part of upstream
  (`dsh-better-sidebar` appears in its logs), so its state must be treated as
  owner data, not as a baseline.
