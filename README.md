# DSH WSL Web Shell — Windows Electron application

**Status: new direction, implementation not yet complete.** The previous `dsh-wsl-native` plugin approach was canceled on 2026-11-05 because it required replacing parts of the official DeepSeek Harness Desktop UI. [The old PR #1](https://github.com/triagmas/dsh-wsl-native/pull/1) was closed without merge; the previous source remains in Git history.

## What this project will become

A minimal **Windows .exe built with Electron** that opens the **unmodified official DeepSeek Harness Web GUI** served by **native DeepSeek Harness in an existing Ubuntu WSL2**. One standalone application window, no browser address bar, no editable site URL, no custom chat UI and no modifications to the official Windows Desktop.

- App window: Electron/Chromium on Windows.
- Fixed local destination: `http://127.0.0.1:3080`.
- Runtime: native Linux `dsh web --host 127.0.0.1 --port 3080 --no-open` in WSL2 Ubuntu.
- Authentication: privately consume the ephemeral tokenized Web startup URL, then use the Web GUI session cookie. The token is **never shown or logged**.
- Execution: Harness models, conversations, shell tools and files run in WSL Linux; Windows Electron is only the window.

**Do not treat this description as a working release yet.** The original plugin files in the new feature branch still require replacement.

See the [new product specification](docs/electron-web-shell-spec.md) for implementation stages, security, fixed-origin behavior and acceptance.

## Development policy

- Work only on `feat/electron-wsl-web-shell` until owner acceptance. Preserve `main` and the closed plugin branch.
- Do not alter the official installed Desktop, `app.asar`, working DSH profiles, global network settings or WSL installation without explicit consent.
- English is canonical for source and documentation; the owner receives Russian reports.
- Provide a packaged Windows EXE and real end-to-end evidence before proposing any merge.

Original project: [Han-1413141/dsh-wsl-native](https://github.com/Han-1413141/dsh-wsl-native), MIT; original LICENSE and attribution retained in repository history.
