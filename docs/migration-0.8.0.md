# 0.8.0 — TypeScript migration, localization, permission modes

This release keeps the Windows Desktop + WSL runtime architecture unchanged: the
plugin still runs a resident stdio bridge in each enabled WSL distribution, still
launches the native Linux DSH for full-runtime conversations, and still embeds the
Linux client in the Windows window through the official guest mechanism. What
changes is how the plugin is written, translated, and authorized.

- Plugin version: `0.8.0`
- Verified DeepSeek Harness Desktop version: `0.2.1-rc.5`
- Licence: MIT (upstream `Han-1413141/dsh-wsl-native`, base `v0.7.0`)

## 1. Strict TypeScript

All host-side modules are strict TypeScript, compiled by `tsc` with `strict`,
`noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `exactOptionalPropertyTypes`
disabled only where DSH's own types require it, and ES2023 / NodeNext resolution.

| Area | Modules |
| --- | --- |
| Entry points | `src/index.ts`, `src/service.ts`, `src/cli.ts`, `src/worker.ts` |
| Control plane | `src/rpc.ts`, `src/routes.ts`, `src/connector.ts`, `src/launcher.ts`, `src/handoff.ts`, `src/handoff-auth.ts` |
| WSL runtime | `src/worker.ts`, `src/process.ts`, `src/paths.ts`, `src/encoding.ts`, `src/worker-protocol.ts`, `src/install-cache.ts`, `src/inheritance.ts` |
| Permissions | `src/permissions/{types,paths,index}.ts`, `src/policy.ts` |
| Panel runtime | `src/client-types.ts`, `src/conversation-{protocol,guest}.ts`, `src/desktop-{mailbox,view}.ts`, `src/workspace-{commands,projection,session}.ts`, `src/connection-recovery.ts`, `src/native-workspaces.ts`, `src/work-handoff.ts` |
| i18n | `src/i18n/{types,format,core,index,client,en,ru,zh-CN}.ts` |

Explicit types are declared at every boundary that another module, RPC call,
tool, CLI command, or the browser panel consumes: `WorkerRequest`/`WorkerResponse`,
`PermissionMode`/`PermissionDecision`, `LocalizedReason`, `NativeStatus`,
`PanelApi`, and the `ClientContext` structural surface in `src/client-types.ts`.
Typed results (`HarnessResult<T>`, `ProcessResult`, `TransferResult`) replace the
previous untyped return values; `src/errors.ts` defines the error codes so no
module invents ad-hoc strings.

Every client runtime module is typed, including the session model and the
conversation model (`client-session.ts`, `conversation-model.ts`). The eight
presentational panel files (`page`, `components`, `conversations`, `sidebar`,
`native-sidebar`, `workspace-dialogs`, `handoff-dialog`, `inheritance-ui`) are
still `.jsx` and are loaded through `allowJs: true` with `checkJs: false`; their
props cross the typed `ClientModel`/`ConversationModel` boundary, so a change in
the typed modules breaks the build, but the JSX internals are not checked and
their text is not localized yet. This is the remaining TypeScript gap in this
release and the first item of the follow-up change.

### Toolchain

```bash
npm run verify       # everything below, in one command
npm run typecheck    # tsc -p tsconfig.json --noEmit
npm run lint         # eslint .
npm run i18n:check   # key/placeholder parity + client slice freshness
npm test             # compile to .test-build, then node --test (153 tests)
npm run build        # esbuild bundles + declarations
npm run check:package # archive contents, size, secrets, licence
```

`scripts/build.mjs` produces `dist/index.js`, `dist/service.js`, `dist/cli.js`,
`dist/worker.js`, `dist/client.js` and `dist/types/**`. The client bundle is
capped at 262144 bytes because the DSH client loader rejects anything larger;
the current bundle is well under the cap, which is why only the browser-relevant
dictionary slice (`src/i18n/client-strings.ts`) is shipped to the panel.

## 2. Localization (ru, en, zh-CN)

- Russian is the primary interface language; English is the fallback; Simplified
  Chinese keeps compatibility with the upstream project.
- The locale is resolved once per host from the explicit plugin setting, then the
  `DSH_WSL_NATIVE_LOCALE` / `LANG` environment, then the operating-system
  locale, and finally English. The panel receives the resolved locale in the
  status response, so the Windows window and the WSL guest always agree.
- All 301 message keys exist in all three dictionaries. `npm run i18n:check`
  fails the build when a key, an interpolation placeholder, or the generated
  client slice is out of sync — missing translations cannot ship silently.
- Only this plugin's own strings are translated. DeepSeek Harness core, its
  agent output, and official DSH components keep their upstream language.

The panel language switch writes the preference to the plugin state and reloads
the panel strings; nothing else in DSH is touched.

## 3. Permission modes (security closure)

| Mode | Intent | Notes |
| --- | --- | --- |
| `Protected` (default) | Safe default for untrusted work | Commands run with the plugin's deny rules: state and secret roots, `~/.ssh`, `~/.aws`, credential files, and Windows `System32`/`Program Files` are refused. Symlink escapes are refused after resolution. |
| `Trusted` | Read-mostly work in the user's own Linux files | Same deny rules, fewer confirmations for writes inside the selected workspace. Time-boxed grants. |
| `Full Access` | Explicit, user-initiated unrestricted work | Requires the literal confirmation phrase `FULL ACCESS`, is capped at 24 hours, and is never granted by the agent. |

### SEC-01 — Full Access really expires

- `PermissionState` persists `modeIssuedAt` and `modeExpiresAt` next to the mode.
  Every policy read runs a refresh, so the deadline is enforced by the operation
  that would have used the elevated rights, not by a UI timer.
- At the deadline (24 h maximum, `hours` is clamped), on an inconsistent stored
  window, or on a backwards clock jump larger than 60 s, the policy withdraws
  Full Access and returns to `Protected`. Withdrawal drops the window fields and
  is flagged for persistence, so a restart cannot resurrect it.
- `parsePermissionState` never widens: a missing, over-long, future-dated or
  garbage window, an unknown mode, or a malformed grant all narrow the state.
  Hand-editing `mode: "full-access"` into the settings file therefore loads as
  `Protected`.
- Grants are pruned on every read as well, so an expired grant cannot be used.

### SEC-02 — no agent self-escalation

- `userInitiated: true` is gone. Policy mutations (`setMode`, grants, revocation)
  require a `PolicyAuthority` object that only `createUserSurfaceAuthority` can
  mint, and that is only accepted through a process-local `WeakSet`. A look-alike
  object, a boolean flag, or a JSON payload is rejected with `PERMISSION_DENIED`.
- Evidence required to mint: the authenticated control route, or an interactive
  terminal (`stdin.isTTY && stdout.isTTY`). The CLI therefore refuses
  `dsh-wsl permissions`/`grant`/`revoke` from a tool-spawned process, which is
  what the agent's `exec` produces.
- Tool arguments carrying `mode`, `permissions`, `grant`, `grants`,
  `userInitiated`, `confirm`, `authority` or `hours` are rejected before any
  handler runs.
- Remaining limit, stated plainly: the plugin runs as the same WSL/Windows user
  as the agent. Any protection that depends on that user's files is advisory. An
  agent that can allocate a pty (`script -qc …`) or edit the settings file with a
  valid window can still act as that user; only operating-system accounts,
  containers or a hypervisor can separate them. The plugin does not claim more.

### SEC-03 — path decisions on the verifying host

- A path the executing host cannot resolve is never auto-approved for writes, not
  even in Full Access: `UNVERIFIED_PATH` forces the per-call approval. This is
  the WSL-path-from-Windows and Windows-path-from-Linux case.
- UNC shares (`\\server\share`) and Win32 device namespaces (`\\?\`, `\\.\`)
  are hard denials in every mode.
- Mounted Windows drives (`/mnt/*`, `/media/*`, `/run/media/*`, `/Volumes/*`) and
  cross-filesystem targets always require approval outside Full Access, even with
  a matching grant, because POSIX modes do not protect them.
- Symbolic links and NTFS junctions are resolved through their deepest existing
  ancestor; an escape out of every allowed root is a hard denial.
- Empty, relative, oversized and control-character paths are refused.
- `HOME`, `USERPROFILE` and `HOMEDRIVE`/`HOMEPATH` secret roots are read from the
  process environment only, so a request cannot redirect the denied roots.

### Guarantees that are actually enforced

- Tool arguments cannot carry policy fields (`mode`, `permissions`, `grant`,
  `userInitiated`, `confirm`, `authority`, `hours`). `src/index.ts` rejects them
  before any work starts, so the agent cannot widen its own authority.
- Denied paths are refused before the child process is spawned, and the decision
  is reported with a localized reason.
- Grants expire; there is no "remember forever" path.

Limits that the plugin cannot enforce and therefore does not claim:

- `Full Access` is genuine full access to the WSL user account; nothing sandboxes
  it. Only run it against data you would let the agent delete.
- A path allow-list is not a filesystem sandbox. A permitted command that opens
  its own network socket, starts a container, or calls `sudo` is out of scope.
- Windows interop inherits the Windows user's rights; the plugin restricts which
  paths it *passes through*, not what a Windows program does once started.
- Mounted Windows drives (`/mnt/c`, `/mnt/f`, …) bypass Linux file permissions.
  Path checks still apply, but POSIX modes on those mounts do not protect files.

## 4. Install, upgrade, rollback

```powershell
$dshDesktop = 'F:\deepseek harness\resources\runtime\cli\bin\dsh.cmd'
& $dshDesktop plugin --profile desktop add 'C:\Downloads\dsh-wsl-native-0.8.0.tgz'
```

Rollback is the same command against the previous package file; the plugin keeps
no state outside its own profile directory. Uninstall:

```powershell
& $dshDesktop plugin --profile desktop remove dsh-wsl-native
```

Before packaging, verify the archive:

```bash
sha256sum dsh-wsl-native-0.8.0.tgz
```

## 5. Verification performed for this change

- `npx tsc -p tsconfig.json --noEmit` — clean.
- `npx eslint .` — clean.
- `node scripts/check-i18n.mjs` — 3 locales × 301 keys, placeholders matching,
  client slice current.
- `node scripts/test.mjs` — **153 tests, 151 pass, 0 fail, 2 skipped**
  (Windows-only), covering the upstream v0.7.0 suites migrated to `test/legacy/`
  and the new `test/security.test.ts` (expiry, restart, corrupt state, clock
  jumps, authority forgery, CLI escalation, settings edits, symlinks, UNC,
  mounts, empty paths, cross-filesystem writes).
- GitHub Actions matrix — Ubuntu and Windows, Node 22 and 24: typecheck, lint,
  i18n check, tests, build and `npm pack --dry-run` all green.
- `npm run build` — host, worker, CLI, client bundle, and declarations emitted;
  client bundle within the DSH size cap.
- `node scripts/check-package.mjs` — 106 files, no `src/`, tests, temp files or
  secret-like content, MIT licence present, no stale declarations.

Nothing in this release has been installed into a working Harness Desktop
profile by the development process, and no user project, global DSH setting, or
WSL configuration was modified.
