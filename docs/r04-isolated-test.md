# R04 — isolated integration test scenario

This document is the **plan** for running `dsh-wsl-native` 0.8.0 inside a real
DeepSeek Harness Desktop. Nothing here has been executed yet: R03 stops before
any installation. Every step must be approved by the owner before it runs.

The whole scenario is built around one rule: **the working Harness Desktop
profile, its projects and its credentials are never touched.** All state lives in
a throwaway profile directory with throwaway data.

## 0. Verified facts (read from the installed 0.2.1-rc.5 `app.asar`)

These replace the earlier guesses (`DSH_PROFILE_DIR`, `DSH_WSL_HOME`, a
`--profile-dir` flag). Nothing below was executed; the values come from the
shipped sources:

| Item | Verified value | Source |
| --- | --- | --- |
| Desktop build | `@deepseek-ai/dsh-desktop` **0.2.1-rc.5**, commit `d4db512a969fccf0c5cc7ec8fe38e9c1d27af916`, bundled Node 24.21.0 | `app.asar:/package.json`, `/dsh/desktop-runtime.json` |
| Install directory | `%LOCALAPPDATA%\Programs\DeepSeek Harness\` (`app.asar` 175 MB) | filesystem |
| Harness home | `$DSH_HOME`, else `%USERPROFILE%\.dsh` | `@deepseek-ai/dsh-home-paths` (`DSH_HOME_ENV`, `DSH_HOME_DIR_NAME`) |
| Profiles root | `$DSH_HOME/profiles/<name>` | `dsh-app-boot`: `PROFILES_DIR = "profiles"`, `resolveProfileDir()` |
| Desktop profile | `$DSH_HOME/profiles/desktop`, lock file `$DSH_HOME/profiles/desktop/lock` | `dsh-desktop` `resolveDesktopPaths()` |
| Plugin install target | `dsh plugin --profile <name> add <pkg>` runs pnpm **inside that profile directory** | `@deepseek-ai/dsh/lib/plugin-*.js` |
| Electron userData | `app.getPath("userData")` → `%APPDATA%\@deepseek-ai\dsh-desktop` | `dsh-desktop` `main.js` |
| Desktop shell settings | `<userData>\desktop\settings.json` | `readDesktopSettings()` |
| CLI profile override | `--profile <name>` only; `desktop` cannot be booted from the CLI | `@deepseek-ai/dsh/lib/bin.js` |
| Linux runtime root | plugin config `nativeRoot`, else `~/.local/share/dsh-wsl-native`; DSH home for Linux is `<nativeRoot>/dsh-home` | this repo, `src/launcher.ts:179` |

Two consequences that the earlier plan got wrong:

1. **There is no per-profile environment variable.** Isolating the profile means
   pointing `DSH_HOME` at a fresh directory; `profiles/desktop` then lives inside
   it automatically.
2. **`DSH_HOME` does not isolate Electron state.** Update channels, window
   geometry and the desktop `settings.json` live under `userData`, which must be
   redirected separately with Electron's standard `--user-data-dir` switch.

## 1. Preconditions

| Requirement | Value / check |
| --- | --- |
| DSH Desktop | `0.2.1-rc.5`, closed before the test starts |
| Package | `dsh-wsl-native-0.8.0.tgz` with the SHA-256 recorded in the R03 report |
| WSL | WSL2 with at least one distribution; `/etc/wsl.conf` must not be edited |
| Disk | ~2 GB free inside WSL for a separate runtime home |
| Accounts | a **separate Windows user** is recommended; same-user testing is allowed but weakens the isolation claims |
| Network | no requirement; the runtime is local |

Stop if any of these is false. Do not "make it work" by changing the working
profile.

## 2. Isolation layout

```text
Windows
  %TEMP%\dsh-r04\                         <- everything disposable
    dsh-home\                             <- DSH_HOME for the test: profiles, sessions, credentials
      profiles\desktop\                   <- plugin install target for the test only
    user-data\                            <- Electron --user-data-dir for the test
    projects\demo-project\                <- fake project created for the test
    logs\
    dsh-wsl-native-0.8.0.tgz

WSL (inside the test distribution)
  ~/dsh-r04\native\                       <- plugin config nativeRoot for the test
    dsh-home\                             <- Linux DSH_HOME used by the launched runtime
    runtime\                              <- the runtime the plugin installs there
  ~/dsh-r04\projects\demo\                <- fake Linux project, no user files
```

`%TEMP%\dsh-r04` and `~/dsh-r04` are the **only** cleanup roots. Never clean
`%USERPROFILE%`, `$HOME`, or any directory that was not created by this
procedure.

### Fake data

- `projects\demo-project\README.md` — one line of text.
- `projects/demo/hello.txt` — one line of text.
- No real repository, no SSH key, no cloud credential, no `.env` from a real
  project, and no copy of the user's DSH settings.

## 3. Launch procedure (approved steps only)

1. Close the working DSH Desktop. Confirm with the task manager that no
   `dsh`/Electron process for the working profile survives. Do not stop other
   user services.
2. Create the directories listed above.
3. Install the package into the **test profile only**:

   ```powershell
   $cli = 'F:\deepseek harness\resources\runtime\cli\bin\dsh.cmd'
   & $cli plugin --profile r04-test add "$env:TEMP\dsh-r04\dsh-wsl-native-0.8.0.tgz"
   ```

4. Start the desktop app with both roots redirected (verified names only):

   ```powershell
   $env:DSH_HOME = "$env:TEMP\dsh-r04\dsh-home"
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" `
       --user-data-dir "$env:TEMP\dsh-r04\user-data"
   ```

   `DSH_HOME` moves the profile, sessions and credentials; `--user-data-dir` is
   Electron's own switch and moves window state, update settings and logs. If
   either directory already contains a `profiles\desktop` from a previous run,
   the run is not isolated — stop and recreate the tree.

5. In the test profile's `profiles\desktop\cordis.patch.yml`, set the plugin
   config so the Linux runtime is installed under the test directory:

   ```yaml
   - id: dsh-wsl-native
     config:
       nativeRoot: /home/<user>/dsh-r04/native
   ```

   Confirm the effective value with `dsh --profile desktop --dump-config` in the
   test `DSH_HOME` when the app is closed; the plugin itself prints it in the
   panel diagnostics.
5. Open the WSL panel and select the distribution, then set the Linux directory
   to `~/dsh-r04/projects/demo`.

## 4. Checks

Run them in order and record the outcome of each.

| # | Check | Expected | Evidence to keep |
| --- | --- | --- | --- |
| 1 | Panel opens | Three sections render: environments, permissions, Linux directory | screenshot |
| 2 | Language switch | `ru`, `en`, `zh-CN` all render; reload keeps the choice | screenshot ×3 |
| 3 | Environment status | Windows marked current, Linux "starts on demand" | screenshot |
| 4 | First launch | Linux runtime starts in the separate home; progress text appears; no error banner | log from `~/dsh-r04/logs` |
| 5 | Chat | a message in the Linux conversation gets a reply | screenshot |
| 6 | Terminal | a WSL terminal command shows the separate home path | screenshot |
| 7 | Permissions: Protected | a write outside the workspace is refused or asks | screenshot |
| 8 | Permissions: Trusted | the same write asks once, then the grant appears in the list | screenshot |
| 9 | Permissions: Full Access | requires `FULL ACCESS`; expiry is shown; after revocation, Protected again | screenshot |
| 10 | Grant revoke | the revoked grant disappears and the operation asks again | screenshot |
| 11 | Reconnect | kill the runtime from the diagnostics section, reconnect, conversation recovers | screenshot |
| 12 | Isolation audit | no file appeared under the working profile, `%APPDATA%`, or the real project | `dir` listing before/after |

## 4a. Interop risk (must be decided before running)

The agent's Linux shell can reach Windows without the plugin (`powershell.exe`,
`/mnt/c/...`), because WSL interop is enabled by default and this plugin does not
change it. That means the isolated profile protects **state**, not **the Windows
user**. Three options, in decreasing strength:

| Option | Isolation | Cost |
| --- | --- | --- |
| **A. Separate local Windows account** `dsh-r04`, own WSL distribution, run everything there | real: the test account cannot read the owner's profile, and its interop reaches only its own user | needs an administrator once; adds a user and a distribution |
| **B. Same account, `DSH_HOME` + `--user-data-dir` + `nativeRoot`** | functional only: state is separate, the Windows account is shared | none; must be stated in the result |
| **C. Windows Sandbox / VM** | strongest, disposable | needs virtualization; WSL inside the sandbox |

Recommendation: **A** if the owner accepts one local account and one extra WSL
distribution; otherwise **B**, with the report explicitly marking every
"isolation" result as state-only. Do not edit `/etc/wsl.conf` to disable
interop — that is a global change outside this task.

## 5. Rollback and cleanup

1. Close the test Desktop instance.
2. Remove the plugin from the test profile:

   ```powershell
   & $cli plugin --profile r04-test remove dsh-wsl-native
   ```

3. Stop only the runtime started by this test, using the test profile's CLI — not
   a global `wsl --shutdown` and not another distribution's process.
4. Delete `%TEMP%\dsh-r04` and `~/dsh-r04` (or `~/dsh-r04/native`) after listing their contents and
   confirming both paths are the ones created in step 2 of the launch procedure.
5. Confirm the working profile is unchanged (file count and modification time of
   its profile directory before/after) and restart the normal Desktop.

If any check fails, keep the logs, restore the previous plugin package with
`plugin add` of the previous `.tgz`, and report the failure without editing the
working profile.

## 6. What this scenario cannot prove

- It does not prove protection against an agent that runs as the same OS user:
  that boundary needs separate accounts, a container, or a hypervisor.
- It does not validate other DSH versions, other distributions, or Windows
  without WSL2.
- It does not test a production upgrade path: that requires the owner's decision
  to install into the working profile.
