# R04 — isolated Desktop integration test (preflight)

Status: **BLOCKED** — do not run until §7 is answered. Nothing in this document has
been executed: no install, no Desktop launch, no directories created.

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
| Install root | `C:\Users\<owner>\AppData\Local\Programs\DeepSeek Harness` | file system; single install on this machine |
| Harness home | `$DSH_HOME`, else `%USERPROFILE%\.dsh` | `dsh-home-paths`: `DSH_HOME_ENV`, `DSH_HOME_DIR_NAME` |
| Profiles root | `$DSH_HOME\profiles\<name>` | `dsh-app-boot`: `PROFILES_DIR`, `resolveProfileDir()` |
| Profile the Desktop boots | **always** `$DSH_HOME\profiles\desktop` | `main.js`: `activeProject = resolveDesktopPaths().profile` |
| Profile lock | `$DSH_HOME\profiles\desktop\lock` | `resolveDesktopPaths()`, `withFileLock` |
| `DSH_HOME` reaches the host | yes on Windows; the login-shell environment read returns the inherited environment unchanged on `win32` | `desktopNodeEnvironment()`, `readDesktopLoginShellEnvironment()` |
| Plugin install target | `profiles\desktop` of the **same** `DSH_HOME` | `dsh plugin --profile <name>` → `resolveProfileDir()` |
| Supported install CLI | `<install>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js` run by the Electron binary in Node mode, `manageDesktopProfile: true` | `dsh-desktop-host/lib/cli.js` |
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

### 0.1 Blocker found during preflight

`<install>\resources\runtime` **does not exist** on this machine.
`dir /a` of `resources` lists only `app.asar` and `app.asar.unpacked`, and no
`pnpm.mjs` / `bin\` / `primary-runtime` exists anywhere in the installation.

The supported install CLI hard-codes
`<resources>\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs`
(`runDesktopCli`), so `dsh plugin --profile desktop add …` cannot run as
installed: it would fail before touching the profile. This is not a plugin
defect and cannot be worked around inside the plugin. See §7, action 1.

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
$DSH_EXE = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"   # resolve BEFORE overriding LOCALAPPDATA
$DSH_CLI = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
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
   $env:ELECTRON_RUN_AS_NODE = '1'
   & $DSH_EXE $DSH_CLI plugin --profile desktop add "$R04\pkg\dsh-wsl-native-0.8.0.tgz"
   Remove-Item Env:\ELECTRON_RUN_AS_NODE
   ```

   The CLI loads `resourceDir\dsh` out of the asar and runs pnpm from
   `resources\runtime\primary-runtime\dependencies\pnpm` — the path that is
   missing today (§0.1). `dsh-wsl-native` ships `dsh.bundle.patch`, so pnpm
   alone wires the bundle layer; no manual patch edit is needed.

   Verify before launching:

   ```powershell
   Select-String -Path "$env:DSH_HOME\profiles\desktop\package.json" -Pattern 'dsh-wsl-native'
   Get-ChildItem "$env:DSH_HOME\profiles\desktop\node_modules\dsh-wsl-native" | Select-Object Name
   # cordis.yml is an empty entry list by design; the bundle layer comes from
   # package.json's dsh.profile.bundles plus the package's own dsh.bundle.patch
   ```

   Only `<test DSH_HOME>\profiles\desktop` may change in this step. If anything
   under `C:\Users\<owner>\.dsh` changes, stop and roll back.

4. **Second launch — the test run.**

   ```powershell
   & $DSH_EXE --user-data-dir "$R04\user-data"
   ```

   Confirm the Desktop boots the test profile, not the working one: while it
   runs, `$env:DSH_HOME\profiles\desktop\lock` exists and its mtime is current,
   while `C:\Users\<owner>\.dsh\profiles\desktop` mtimes stay at the values
   recorded in `snapshot-before.json`.

Re-running the guard in step 0 before each DSH command is required; the
`DSH_HOME` value is the only thing that decides which profile is used.

### 2.1 Fallback install without pnpm (only with owner approval)

If the runtime payload cannot be repaired before R04, the same result can be
produced without pnpm, because the plugin has no runtime dependencies:

```powershell
$dest = "$env:DSH_HOME\profiles\desktop\node_modules\dsh-wsl-native"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
tar -xzf "$R04\pkg\dsh-wsl-native-0.8.0.tgz" -C $R04\pkg          # package/ → unpacked tree
Copy-Item -Recurse "$R04\pkg\package\*" $dest
# add "dsh-wsl-native" to dsh.profile.bundles in $env:DSH_HOME\profiles\desktop\package.json
```

This is **not** the supported install path: it skips pnpm's dependency graph and
the profile lock. It is acceptable only inside a disposable profile, must be
labelled as such in the result, and must not be used on the working profile.

## 3. Isolation from the working Windows user

Same-account isolation (`DSH_HOME` + `--user-data-dir` + `LOCALAPPDATA`) separates
**state**, not **authority**: the test still runs as the owner, and the agent's
Linux shell can reach Windows through WSL interop (`powershell.exe`, `/mnt/c/…`)
regardless of the plugin. Three options:

| Option | What it isolates | Cost / limit |
| --- | --- | --- |
| **A. Separate local Windows account `dshr04` + WSL distribution registered under it** | the whole user context: own `%USERPROFILE%`, `%APPDATA%`, `%LOCALAPPDATA%`, own WSL distro, its own interop target | needs an administrator once. **`F:` is a shared volume**: by default other local users can read `F:\_hermes`, `F:\CODE`, etc. The account alone is *not* protection unless the owner adds explicit deny ACEs for `dshr04` on those directories (an owner-side ACL change, not part of R04) |
| **B. Same account, state-only isolation** | profile, userData, caches | no admin; every "isolation" result must be reported as state-only. Interop and `F:` remain reachable |
| **C. Windows Sandbox / Hyper-V VM with only `F:\dsh-r04` shared** | strongest and disposable | needs virtualization; WSL inside the sandbox; the share must be read-write for `F:\dsh-r04` only |

Recommendation: **A** if the owner accepts one local account, one WSL
distribution and the ACL decision on `F:`; otherwise **C**; **B** only if the
goal is a functional check and the report states plainly that isolation was not
execution-level.

Do not edit `/etc/wsl.conf`, `.wslconfig`, or global WSL settings to disable
interop: that is a machine-wide change outside this test.

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

Never touched: `C:\Users\<owner>\.dsh`, `%APPDATA%\@deepseek-ai\dsh-desktop`,
`%LOCALAPPDATA%\Programs\DeepSeek Harness`, `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater`,
any owner project, any other WSL distribution.

## 6. Snapshot and rollback

Before the first launch, record a manifest of the working environment
(read-only, no file content leaves the machine):

```powershell
$paths = @("$env:USERPROFILE\.dsh", "$env:APPDATA\@deepseek-ai\dsh-desktop")
Get-ChildItem -Recurse -Force -File $paths |
  Select-Object FullName, Length, LastWriteTimeUtc |
  ConvertTo-Json -Depth 2 | Set-Content 'F:\dsh-r04\snapshot-before.json'
```

After the last launch, repeat into `snapshot-after.json` and compare. Allowed
differences: none for `~/.dsh`; only `logs\` growth under the working userData
(if the working app was started at all — it must not be during R04).

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

1. **Repair the installation.** `<install>\resources\runtime` is missing, so the
   supported plugin-install CLI cannot run (§0.1). Reinstall/repair 0.2.1-rc.5
   from the vendor installer, then confirm
   `resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs` and
   `resources\runtime\bin` exist. Alternatively approve the manual placement
   fallback in §2.1 for the test profile only.
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
