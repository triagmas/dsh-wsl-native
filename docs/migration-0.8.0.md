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

Not yet migrated (known gap, tracked for the next change): `src/client-session.mjs`,
`src/conversation-model.mjs`, and the eight presentational `.jsx` panel files.
They are loaded through `allowJs: true` with `checkJs: false`, so they cannot
silently break the typed modules, but they are not yet type-checked themselves.

### Toolchain

```bash
npm run typecheck    # tsc -p tsconfig.json --noEmit
npm run lint         # eslint .
npm run i18n:check   # key/placeholder parity + client slice freshness
npm test             # tsc to .test-build, then node --test
npm run build        # esbuild bundles + declarations
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

## 3. Permission modes

| Mode | Intent | Notes |
| --- | --- | --- |
| `Protected` (default) | Safe default for untrusted work | Commands run with the plugin's deny rules: state and secret roots, `~/.ssh`, `~/.aws`, credential files, and Windows `System32`/`Program Files` are refused. Symlink escapes are refused after resolution. |
| `Trusted` | Read-mostly work in the user's own Linux files | Same deny rules, fewer confirmations for writes inside the selected workspace. Time-boxed grants. |
| `Full Access` | Explicit, user-initiated unrestricted work | Requires the literal confirmation phrase `FULL ACCESS`, is capped at 24 hours, and is never granted by the agent. |

Guarantees that are actually enforced:

- Tool arguments cannot carry policy fields (`mode`, `permissions`, `grant`,
  `userInitiated`, `confirm`, …). `src/index.ts` rejects them before any work
  starts, so the agent cannot widen its own authority.
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
- `node scripts/test.mjs` — 53 tests, 53 pass, 0 fail (i18n, paths, permissions,
  worker over a real stdio child, handoff signing, inheritance merge, routes).
- `npm run build` — host, worker, CLI, client bundle, and declarations emitted;
  client bundle within the DSH size cap.

Nothing in this release has been installed into a working Harness Desktop
profile by the development process, and no user project, global DSH setting, or
WSL configuration was modified.
