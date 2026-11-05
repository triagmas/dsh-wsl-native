# R04 — isolated integration test scenario

This document is the **plan** for running `dsh-wsl-native` 0.8.0 inside a real
DeepSeek Harness Desktop. Nothing here has been executed yet: R03 stops before
any installation. Every step must be approved by the owner before it runs.

The whole scenario is built around one rule: **the working Harness Desktop
profile, its projects and its credentials are never touched.** All state lives in
a throwaway profile directory with throwaway data.

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
    profile\                              <- DSH profile for the test (never %APPDATA%\deepseek-harness)
    config.dsh-profile\
    projects\demo-project\                <- fake project created for the test
    logs\
    dsh-wsl-native-0.8.0.tgz

WSL
  ~/dsh-r04/                              <- separate runtime home (DSH_WSL_HOME)
    home\.dsh\                            <- the Linux-side DSH home for the test
    projects\demo\                        <- fake Linux project, no user files
    logs\
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

4. Start the desktop app with the test profile (separate config root and data
   directory), for example:

   ```powershell
   $env:DSH_PROFILE_DIR   = "$env:TEMP\dsh-r04\profile"
   $env:DSH_WSL_HOME      = "$env:TEMP\dsh-r04\config.dsh-profile"
   & 'F:\deepseek harness\DeepSeek Harness.exe' --user-data-dir "$env:TEMP\dsh-r04\profile"
   ```

   The exact flag names must be read from the installed build before running;
   if the build has no isolated-profile switch, **stop** — the test cannot be
   isolated and must not proceed.
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

## 5. Rollback and cleanup

1. Close the test Desktop instance.
2. Remove the plugin from the test profile:

   ```powershell
   & $cli plugin --profile r04-test remove dsh-wsl-native
   ```

3. Stop only the runtime started by this test, using the test profile's CLI — not
   a global `wsl --shutdown` and not another distribution's process.
4. Delete `%TEMP%\dsh-r04` and `~/dsh-r04` after listing their contents and
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
