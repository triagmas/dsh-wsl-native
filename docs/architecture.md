# Architecture — official Windows Desktop ↔ native WSL2 Harness

**Scope:** `dsh-wsl-native@0.8.x`. This document describes the **existing** plugin architecture, not a new Desktop, security Broker or virtual machine. **New owner requirement (2026-11-05): [WSL-first default execution](wsl-first.md).** The existing optional dual-host UI does not satisfy this requirement: normal Desktop New Chat should route to native Linux Harness and Linux tools by default, without choosing WSL. Implementing this still requires validating official Desktop integration points; do not claim it is already supported. Source-code and runtime evidence take precedence over outdated docs.

Read [project context](project-context.md), [product specification](product-spec.md) and [decisions](decisions.md) first.

## 1. System overview

~~~mermaid
flowchart LR
    D["Official DeepSeek Harness Desktop (Windows)"] --> P["dsh-wsl-native plugin (TypeScript)"]
    D --> WH["Windows DSH sessions and workspaces"]
    P --> CP["Control panel and DSH RPC"]
    P --> POOL["Persistent stdio JSONL connection pool"]
    POOL --> WW["Windows Node worker"]
    POOL --> LW["Existing WSL2 Linux Node worker"]
    LW --> LF["Linux files, Bash and projects"]
    WW --> WF["Windows files and PowerShell"]
    P --> L["Native Linux Harness launcher"]
    L --> LH["Native Linux DSH runtime and home"]
    LH --> LS["Linux sessions / workspace / tools"]
    D <-->|"Official guest/browser surface and limited navigation metadata"| LH
~~~

Two distinct DSH runtime environments coexist:

- **Windows runtime:** supplied and managed by the installed official Desktop.
- **Linux runtime:** a complete, separately managed DSH instance running in an existing Ubuntu/WSL2 Linux filesystem.

The plugin **bridges** them and exposes Linux conversations through the official Desktop. It does not change the Windows runtime into a Linux process, clone Windows sessions into Linux or replace the official Desktop application.

## 2. Host and transport

The plugin integrates with DSH through its published/observed Cordis/DSH interfaces. The host entry point registers tools, service state, the management controller and a React client.

- Windows → WSL connections use `wsl.exe --exec` to start a Linux Node worker in the selected distribution/user.
- WSL → Windows connections can use WSL interoperability to start a Windows Node worker.
- Persistent workers exchange request-ID-tagged **JSONL on stdio**; the bridge does not require a new publicly listening TCP command service.
- A connection is reused for an environment/target identity, and simultaneous callers share the establishment operation.
- Cancellation, deadlines and connection failures are propagated; failed mutating operations are **not blindly retried**.

The original design specifies bounded frame sizes and concurrent requests (2 MiB JSONL frames, up to 32 pending client requests and 16 worker operations). Maintain such bounds and recheck the current implementation before altering values.

Key modules: `src/index.ts`, `src/service.ts`, `src/connector.ts`, `src/rpc.ts`, `src/worker.ts`, `src/process.ts`.

## 3. Native Linux runtime

The launcher is responsible for creating/reusing a self-contained native Linux DSH installation and its data home, running it in WSL2 and exposing its authenticated local browser endpoint to the Windows Desktop container.

- `src/launcher.ts` selects a Linux `nativeRoot`; the default is under the Linux user's `~/.local/share/dsh-wsl-native`.
- The managed runtime and Linux `dsh-home` are under that root, separate from the Windows Harness home.
- The Linux runtime is a real Linux execution environment. Put Linux projects under Linux paths such as `/home/<user>/projects` for native filesystem semantics.
- A path under `/mnt/c` or another mounted Windows drive remains Windows-backed storage; a path conversion does not copy a project into Linux.
- The launcher uses the selected environment and manages readiness, reuse, cancellation, teardown and start lock coordination.

Key modules: `src/launcher.ts`, `src/install-cache.ts`, `src/localhost.ts`, `src/handoff.ts`, `src/handoff-auth.ts`.

**Important acceptance distinction:** a unit test for the launcher does not prove the candidate package can launch the native runtime from the official installed Desktop. That requires a real, owner-approved integration run.

## 4. Desktop panel and conversations

The plugin contributes its panel through DSH UI extension points, uses React/TSX and the UI primitives supplied by the official host, and follows official theme tokens.

Its Windows/WSL view is meant to provide:

- Environment selector, Linux user and workspace path/browse controls.
- Start/reconnect/status/stop management for the native Linux DSH.
- Windows and WSL conversations/workspaces in the existing Desktop navigation, with WSL indicators.
- Session switching, re-entry, project management, and optional task handoff.
- A separate permissions section with the chosen mode and grants.

The official Desktop supplies guest/browser containment APIs. The plugin uses the existing guest mechanism and a limited, authenticated navigation channel to show the Linux DSH client in the same window; it does not ship its own Electron executable.

Existing conversation state belongs to its respective runtime. Switching views is not a cross-OS migration of the model's running context. The implementation preserves drafts and avoids automatically replaying a message or write after ambiguous connection failure.

Key modules: `src/client.tsx`, `src/page.tsx`, `src/native-sidebar.tsx`, `src/native-workspaces.ts`, `src/sidebar.tsx`, `src/conversations.tsx`, `src/conversation-model.ts`, `src/client-session.ts`, `src/conversation-guest.ts`, `src/desktop-view.ts`, `src/desktop-mailbox.ts`, `src/work-handoff.ts`.

## 5. Workspaces and cross-environment handoff

The plugin projects Linux workspace/session metadata into Windows navigation without replacing Windows' own workspace store. Host, distro, user and actual session identifiers must be kept distinct to prevent cross-host ID collisions.

- A Linux directory selection is validated before the active settings change.
- Operations already dispatched remain bound to their original environment even if the user changes the selection.
- A handoff transfers an explicitly chosen **work description or draft**, not an entire private session database.
- Existing drafts must not be silently overwritten.
- Ambiguous sends must not be repeated automatically.

Key modules: `src/workspace-commands.ts`, `src/workspace-dialogs.tsx`, `src/workspace-projection.ts`, `src/work-handoff.ts`, `src/handoff-dialog.tsx`.

## 6. File and process operations

The original plugin supports both directions:

- Bash in Linux and PowerShell / executable invocations in Windows.
- Directory listing, text read/write, SHA-256-checked file transfer, path conversion and background jobs.
- Opening Windows files/directories and the clipboard, where the host supports it.

Where possible, file operations write to a temporary sibling, verify expected content/hash, then atomically rename. An atomic rename is not a substitute for disk snapshots or OS-level isolation.

Long-running processes, timeouts and cancellation are owned by the worker/connection lifecycle; a UI refresh must not blindly repeat an already-started command.

## 7. Permission model and its real limits

The 0.8.0 fork implements three UI modes using `src/permissions/*`, `src/policy.ts`, the control routes and the UI form contract:

| Mode | Intended behavior |
| --- | --- |
| Protected | Conservative default; out-of-policy operations require DSH approval or are denied |
| Trusted | Time-limited grants for supported `capability`, target OS and optional file root |
| Full Access | User confirms `FULL ACCESS` and duration; mode expires (at most 24 h) |

The UI separates `target: windows|wsl` from `root`. Execution grants cannot be made safe merely by assigning an executable name or working directory; their actual scope is broader than file-root grants.

**This is not a security sandbox.** An agent with the same OS-user privileges can still use `powershell.exe` through WSL interop or directly access mounted Windows files. The Desktop's own `danger-full-access` setting is a separate switch. Do not describe Protected/Trusted or a separate `DSH_HOME` as a hard OS boundary.

The owner wants **practical configurable autonomy**, not approval on every individual build command. An independent Windows Command Broker, restrictions incompatible with upstream exec, restricted tokens, and VM/Hyper-V infrastructure are not current deliverables.

See [migration and permission behavior](migration-0.8.0.md).

## 8. Authentication and trusted routing

The panel calls DSH's authenticated control endpoints through host RPC rather than introducing an unrestricted network execution port. Controls that change permission policies are intended for user surfaces; tool argument policy fields are rejected.

The Windows Desktop guest uses the official DSH guest-browser acquisition/release mechanism. Origin checks, signed navigation handoff and limited metadata transfer are employed as available.

**Security caveat:** same-user code or compromised dependencies can defeat application-layer controls. Describe actual mitigations, not theoretical containment.

## 9. Plugin/config inheritance

When preparing the Linux runtime from the Windows host, the upstream integration can inherit selected main-host plugins, settings and model account configuration. Linux-local changes take precedence under the merge rules, and sessions remain distinct. Inheritance does not guarantee Windows-specific plugins work on Linux.

Inherited credentials are sensitive. Testing must use fake data or explicit owner permission; do not copy real account secrets into acceptance fixtures.

See [inheritance guide](inheritance.md) (legacy language translation pending).

## 10. Localization and build

- All maintained host and panel modules are TypeScript/TSX and checked with `strict`.
- Three UI dictionaries: `en`, `ru`, `zh-CN` in `src/i18n/`.
- The client bundle includes a generated slice of only the required messages, enforced by `npm run i18n:check`.
- The DSH browser client bundle must remain under **262,144 bytes**.
- `npm run verify` covers type checking, lint, i18n, tests, build and package verification.
- CI uses Ubuntu/Windows with Node 22/24; live Desktop acceptance remains a separate gate.

English is required for canonical source comments and documentation before merge. Russian and Chinese UI dictionaries and separately labeled translated docs are preserved.

## 11. Packaging and test boundaries

`package.json` publishes bundled `dist/index.js`, `dist/service.js`, `dist/worker.js`, `dist/client.js`, `dist/cli.js` and generated declarations. The Desktop uses its packaged CLI for plugin management under the active `DSH_HOME` and `profiles/desktop`.

On the owner's machine, the valid installed Desktop was found under `F:\-ToolBox-\DSH`; the working Harness home is separate and must not be modified without approval. Old C: installation remnants must not be used for integration.

Plan first: verify package, paths and profile identity. Only after explicit owner permission, perform a minimal real Desktop UI load, then WSL-native integration using fake data. No VM/Hyper-V, new Windows accounts or WSL distro are prerequisites of this plugin.

## 12. Component inventory

| Area | Main modules |
| --- | --- |
| Host/plugin registration | `src/index.ts`, `src/policy.ts` |
| Controller/configuration | `src/service.ts`, `src/routes.ts` |
| Transport and worker | `src/rpc.ts`, `src/connector.ts`, `src/worker.ts`, `src/process.ts` |
| Linux launcher | `src/launcher.ts`, `src/install-cache.ts` |
| Cross-host navigation | `src/handoff.ts`, `src/handoff-auth.ts`, `src/desktop-view.ts` |
| UI | `src/client.tsx`, `src/page.tsx`, `src/components.tsx`, `src/client.css` |
| Sessions/workspaces | `src/conversation-model.ts`, `src/workspace-commands.ts`, `src/native-workspaces.ts` |
| Permissions | `src/permissions/`, `src/permissions-form.ts`, `src/permissions-ui.tsx` |
| i18n | `src/i18n/`, build and translation-check scripts |
| Package/test | `package.json`, `scripts/`, `test/`, GitHub Actions |

For the authoritative current file paths, consult the actual source tree. Preserve the established modules and contracts unless a real test demonstrates a necessary fix.

## 13. Project handoff

For a fresh agent session, read [project context](project-context.md), [product spec](product-spec.md), [roadmap](roadmap.md), [status](status.md) and [decisions](decisions.md) **before proposing any changes**. The task is complete when the actual packaged TypeScript plugin is tested in the existing Desktop ↔ WSL2 workflow and accepted by the owner, not when extra infrastructure has been designed.
