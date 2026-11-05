# Project context and owner intent

**Canonical project brief** — read this document before proposing architecture changes, implementing features, reviewing a PR, or drafting the next Pi task.

## What we are building

`dsh-wsl-native` is a community plugin for the **official DeepSeek Harness Desktop on Windows**. It connects that existing Desktop application to a **full, native DeepSeek Harness runtime in an existing WSL2 Linux distribution**.

It is not a replacement Desktop app, a new agent harness, a Windows installer, a security product, or a virtualization project.

The intended experience is simple:

1. Open the official Harness Desktop already installed on Windows.
2. Use the plugin's Windows/WSL interface to select an existing WSL distribution and Linux workspace.
3. Launch or reuse the Linux Harness runtime in WSL; display Linux conversations and workspaces through the official Desktop.
4. Switch between Windows and Linux conversations while each runtime keeps its own environment, tools, files and session state.
5. Use existing cross-OS tools intentionally when a task requires them.

### Primary delivery

Modernize the existing upstream plugin [Han-1413141/dsh-wsl-native](https://github.com/Han-1413141/dsh-wsl-native), preserving its functioning architecture:

- Migrate the JavaScript and JSX codebase to **TypeScript and TSX with `strict: true`**.
- Preserve original Windows ↔ WSL2 connectivity, embedded native Linux Harness, conversations, tools and workspace management.
- Maintain Russian, English and Simplified Chinese UI translations.
- Provide user-configurable **Protected / Trusted / Full Access** permission modes, reusing the existing Harness approval mechanisms where appropriate.
- Build an installable `.tgz` and verify compatibility with the targeted official Desktop build.

## Sources of truth

1. Explicit owner instructions and approvals.
2. This file: product intent and **non-goals**.
3. [Product specification](product-spec.md): functional and acceptance requirements.
4. [Architecture](architecture.md): current system and boundaries.
5. [Roadmap](roadmap.md): approved sequence, statuses and gates.
6. [Current status](status.md): last verified progress and open blockers.
7. Existing source code, tests, GitHub Issues and Draft PR.

When documents disagree with behavior, inspect the code and record the discrepancy. Do not silently redefine the product.

## Strict scope boundaries

Do not turn an integration plugin into:

- A separately built Desktop application or a replacement for the official Harness UI.
- An all-new Windows Command Broker, restricted-token service, bespoke approval framework or incompatible Windows exec API.
- A Hyper-V, VMware, Windows Sandbox, VM, separate-Windows-account, or new-WSL-distribution project.
- A broad security hardening initiative unrelated to a demonstrated blocking defect.
- A migration to Rust or an unrelated repository.

Such work is **outside the current scope** unless the owner explicitly chooses it as a new goal. Mention a genuine risk briefly and precisely without treating an optional mitigation as an approved project.

## Safety and approvals

- A plugin-level allowlist is **not an operating-system sandbox**. Existing WSL interop and mounted Windows drives can bypass the plugin. Never claim otherwise.
- The owner has experienced accidental destructive file operations; use explicit, verified paths and fake test files. Avoid interpreting `HOME` or `USERPROFILE` as a safe deletion target.
- Do not run or modify the working Desktop profile, install a plugin there, alter WSL/Windows system settings, delete owner data, or merge a PR without the owner's explicit approval.
- An isolated application **profile** is state separation, not execution security; document this limitation without inventing new infrastructure requirements.
- Development and CI tests may proceed in their established project/test areas, respecting the task's permissions.

## Working arrangement

- Repo: `triagmas/dsh-wsl-native`; original upstream: `Han-1413141/dsh-wsl-native` v0.7.0 (MIT).
- Current work: Draft [PR #1](https://github.com/triagmas/dsh-wsl-native/pull/1), `feat/r01-typescript`, targeting plugin 0.8.0 / Desktop 0.2.1-rc.5.
- Windows installation discovered on the owner's machine: `F:\-ToolBox-\DSH`. The working Harness home is separately managed. Neither path is permission to modify it.
- All reports and user-directed communications from Pi/agents **must be in Russian**. English is the canonical language for repository documentation and source comments; the application's translations are `en`, `ru` and `zh-CN`.

## Definition of success

A packaged TypeScript plugin loads into the official Windows Desktop, connects to the existing WSL2 Ubuntu runtime and opens native Linux Harness conversations/workspaces without breaking existing Windows conversations. Tests, CI, localization and documentation pass; behavior requiring a real Desktop run is recorded as **not validated** until it has actually run. The owner separately approves any installation or merge.
