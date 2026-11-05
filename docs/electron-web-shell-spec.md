# DSH WSL Web Shell — replacement project specification

**Decision:** 2026-11-05. The earlier Desktop plugin concept is canceled; PR #1 was closed without merge. This document is the new product contract for the same repository. It replaces the goal of `dsh-wsl-native`, but does **not** delete its Git history or authorize a merge.

## User outcome

Double-click a Windows executable and see the **unmodified official DeepSeek Harness Web GUI** in a standalone window, as an application. No browser address bar, tabs or editable URL. The actual DeepSeek Harness is a native Linux process in the **already installed Ubuntu WSL2**.

```text
Windows .exe (Electron's built-in Chromium, no custom chat interface)
  -> fixed local origin http://127.0.0.1:3080
     -> dsh web --host 127.0.0.1 --port 3080 --no-open
        -> DeepSeek Harness agents / sessions / models / tools inside Ubuntu WSL2
```

The app should start a **managed, app-owned** Web server in WSL on demand, rather than require the user to run commands for every launch. It must not replace, patch or use the official **Windows Desktop** installation.

## Source verification

- [Upstream CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md): `dsh web`, `--host`, `--port`, `--no-open`, localhost listener.
- [Official Web bundle](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/README.md): Web GUI, **fresh startup URL contains an ephemeral auth token**; opening this URL sets an authenticated browser cookie then redirects to a URL without the token. Therefore Electron must not blindly load only `http://127.0.0.1:3080` on a fresh profile.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): disable Node integration, enable sandbox and context isolation, prevent foreign navigation/new windows and unsafe external URI handling.

## Minimal scope (MVP)

1. **One Windows Electron BrowserWindow.** It displays the existing DSH Web GUI, not a hand-built replica. Title, icon, resize, close, minimize/maximize and basic loading/error/retry; no URL field or browser chrome.
2. **Start or connect only to an authenticated app-owned Web runtime.** Discover existing Ubuntu and Linux Node / installed DSH without changing working Windows Harness. Launch `dsh web --host 127.0.0.1 --port 3080 --no-open` using `wsl.exe -d Ubuntu --exec ...` with fixed/sanitized arguments. If DSH is missing, show an actionable setup message; do not silently install from network. If port 3080 is occupied by an unknown listener, refuse rather than load an arbitrary local site.
3. **Authentication:** read server stdout startup line, extract and validate the ephemeral tokenized URL strictly for `http://127.0.0.1:3080`, load it exactly once within an isolated Electron session and never include the token in console, crash logs, screenshots or committed files. Subsequent browsing stays on the fixed origin; no user-visible address.
4. **Security:** `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`, no privileged preload or Node IPC in Web GUI, deny all unrelated navigations and new windows. An explicit safe policy may open trusted HTTPS links in the system browser only. Do not disable Electron safeguards for convenience.
5. **Processes:** gracefully stop only the Linux DSH Web process this app actually owns when closing (or deliberately keep it running with explicit state, but never indiscriminately `wsl --shutdown`). Handle startup timeouts, refusal to bind localhost, unavailable WSL, auth failure and graceful restart.
6. **Build:** TypeScript and maintained Electron version, pinned dependencies, a usable Windows EXE and a local test plan. Check package licensing, keep original fork history. The GUI is supplied by DSH and therefore inherits upstream translations, themes and normal chat functions.
7. **Protect user's environment:** never edit `F:\-ToolBox-\DSH`, `F:\-ToolBox-\DSH-Data\home`, installed Desktop profiles, user projects or system networking. Use only an isolated app profile and explicitly approved test directories. Ubuntu runtime installation or local end-to-end tests need separate owner approval.

## What we explicitly do NOT build

- Any plugin that hides or replaces official Windows Desktop buttons, central composer or hotkeys.
- A custom web UI, chat implementation, new Harness backend, browser extension or bespoke command broker.
- VM/Hyper-V/new WSL distro, Windows service, external/public HTTP binding, global proxy, new user accounts.
- An arbitrary address field or navigation to untrusted websites inside the app.
- Uncontrolled auto-updates of Harness, Windows Desktop or Electron.

## Deliverable stages

**R00 — clean migration, no runtime changes:** confirm the official Web server auth/startup contract and fixed-port availability; review Electron/WSL lifecycle; create the replacement implementation in `feat/electron-wsl-web-shell` **without merging**; remove old plugin source, build scripts and package files *from this feature branch only*. Keep LICENSE and attribution; update README, tests and CI for the new application. Preserve old feature branch and closed PR for history.

**R01 — real MVP:** compile and package standalone Electron app; on launch start existing Ubuntu's `dsh web`, ingest token startup URL, display unchanged Web GUI, enforce fixed-origin and shutdown/retry. Unit tests for URL validation, port conflict, process lifecycle and navigation. `npm run verify` green; report package hash, output path and changed lines.

**R02 — real-world acceptance:** with owner's separate approval test WSL + Windows EXE against dummy project; show screenshots and verify Web GUI, session creation, tool execution in Linux, second launch, failure/recovery and shutdown, with no changes to working Desktop profile. Then request explicit review/merge and optional repository rename.

## Acceptance criterion

Start Windows EXE → the original DSH Web GUI appears without address bar → type in **its original composer** → agent and tools execute in existing Ubuntu WSL2; no altered Windows DSH Desktop, no second UI, no button replacement.

**Reporting:** owner-facing updates in Russian, canonical repo docs and comments in English. GitHub is source of truth. Do not install, delete user files, change working Desktop or merge without approval.
