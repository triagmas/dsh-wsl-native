# Instructions for Pi and coding agents

Read `docs/electron-web-shell-spec.md` first. Owner changed the product goal on 2026-11-05: **the old Desktop plugin is canceled**. Do not build or maintain a feature that swaps official DeepSeek Harness Desktop buttons, composer or shortcuts.

The replacement is a **minimal Windows Electron shell for the official DeepSeek Harness Web GUI served by native Ubuntu WSL2**. Keep one fixed local origin and authenticate through the Web startup URL. Electron window must not reimplement the Web GUI. Do not modify installed Windows Desktop, app.asar, working DSH_HOME, WSL setup, host networking or user data without explicit owner approval.

Work on `feat/electron-wsl-web-shell` only; previous PR #1 is closed, `main` and old branches must not be rewritten, and merge is forbidden without owner approval. For R00, replace the old plugin internals **in this new feature branch only** while preserving Git history and MIT attribution.

Inspect upstream `dsh web` tokenized URL behavior and Electron security recommendations before writing the launcher. Fixed localhost origin, safe token handling, WSL process ownership and no silent installation are mandatory. Keep the new app small: an Electron window, WSL process manager and tests — not a second Harness frontend.

**Always report to the owner in Russian**: changed files and +/− lines, tests, Git SHA, real execution evidence, blockers, what was not installed/modified. Canonical source documentation/comments in English.

No VM, Hyper-V, new OS user, new distro, broad security redesign or unrelated infrastructure.
