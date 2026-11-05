# Current project status

**Snapshot date:** 2026-11-05. This is a written status, not an authorization to run an installer or merge a PR. Recheck GitHub HEAD and CI before acting.

## Repository

- Repository: [triagmas/dsh-wsl-native](https://github.com/triagmas/dsh-wsl-native).
- Upstream: [Han-1413141/dsh-wsl-native](https://github.com/Han-1413141/dsh-wsl-native) v0.7.0, MIT.
- Development: [Draft PR #1](https://github.com/triagmas/dsh-wsl-native/pull/1), `feat/r01-typescript` against upstream-based `main`.
- Last functional plugin commit at the time of this snapshot: `b27cae3` (R03.1).
- Last pre-documentation task HEAD: `71a86fc1bf02338eed79a098b710d04b5cba8b20` (R04-B1 documentation correction).
- **The current PR HEAD is expected to advance for documentation commits. Verify it rather than assuming the snapshot SHA is still current.**
- Target release candidate: `dsh-wsl-native@0.8.0` for official DSH Desktop `0.2.1-rc.5`.

## What is implemented

- Host, worker, client and panel migrated from JavaScript/JSX to strict TypeScript/TSX.
- EN/RU/ZH-CN localized plugin UI and a generated client-only dictionary slice.
- Protected, Trusted and Full Access plugin permission modes with form validation, grant management and expiry.
- Unit and legacy regression tests restored and expanded.
- **WSL-first default New Chat (source level, R04-W1):** one primary *New chat in WSL* control replaces the dual-host pair, the Windows session is an explicit secondary control, and the routing plan has no Windows branch. A `dsh-wsl-native.session.new` shortcut command exists unbound; the shipped `Ctrl+N` cannot be claimed directly (the shortcut catalog refuses the conflict), so assigning it is a documented two-step manual action.
- `.tgz` package generation, i18n and package checks, CI on Ubuntu/Windows × Node 22/24.

**Latest reported tests:** 183 total, 181 passed, 2 skipped, 0 failed (after the R04-W1 routing tests). Previous PR run [41990323643](https://github.com/triagmas/dsh-wsl-native/actions/runs/41990323643) succeeded. Do not report those as results for later commits without checking the new runs.

## What has not been validated

- This 0.8.0 candidate has **not** been installed in the real official Desktop on the owner's machine.
- The real Desktop → existing WSL2 Ubuntu → native Linux DSH → conversation workflow has **not** passed a live acceptance run for this candidate.
- Source-level security policy tests do **not** establish OS-level isolation.

## Environment discovered by read-only checks

- Official installed Windows Desktop is at `F:\-ToolBox-\DSH` with bundled runtime/CLI.
- The owner's working DSH home is `F:\-ToolBox-\DSH-Data\home`; it contains user-managed plugins and must not be modified without explicit permission.
- A stale installation remnant exists on C:. Do not run or delete it.
- Existing Ubuntu WSL2 is the integration target. **No new distro or virtualization platform is required by the product specification.**

## Next action

**Owner's priority clarified on 2026-11-05:** [WSL-first execution](wsl-first.md), not a recurring Windows/WSL chooser. R04-W0 audited the Desktop API ([audit](r04-w0-integration-audit.md)); R04-W1 implemented the supported part ([details](r04-w1-wsl-first.md)): one primary WSL control and an unbound shortcut command. The shipped New Session button and `Ctrl+N` remain the host's and are not intercepted. The v0.8.0 package has not been loaded in the real Desktop, so this is a source-level behaviour, not accepted integration evidence. The R04-S1 test profile/isolation work may be reused for later approved live acceptance. The missing-Windows-Node observation in earlier reports is obsolete: owner confirmed Node.js v24.22.2 and npm 11.19.1 installed. Latest reported R04-S1 Fix.1 is commit `e976122`; do not infer real Desktop integration success from its selftests.

## Blockers

1. **Normal Desktop New Chat → WSL native execution is implemented in source but not proven live, and the shipped control/shortcut stay Windows-owned.** The plugin's primary control is WSL-first; making DSH's own button and `Ctrl+N` WSL-first needs the upstream seat described in the audit.
2. **Real integration evidence missing** (not a dependency on Hyper-V or a new Windows installation).
3. **English repository language gate not complete** until legacy Chinese text throughout maintained docs/source comments is handled.
4. **Owner's explicit authorization** still required for any local Desktop launch/install and for merge.

## Scope safeguard

Do not spend another cycle investigating VM/Hyper-V/Windows Sandbox, new OS accounts or a bespoke Windows Broker unless the owner expressly changes the project scope. The owner asked for a working plugin, not an additional infrastructure project.

## Report format for Pi

All messages to the owner **in Russian**: current HEAD, changed file count and added/deleted lines, tests/CI, evidence, blockers, and precise statement of any installation, system change or merge. Cite this status and the roadmap rather than reconstructing project intent from scattered chats.
