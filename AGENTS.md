# Instructions for Pi and other AI agents

## Mandatory: read project context before proposing work

This repository is a **plugin for the official DeepSeek Harness Desktop (Windows)**. The **owner's primary requirement** is that normal New Chat and agent/tool execution default to the **full native Harness in the existing WSL2 Ubuntu** while Desktop remains the Windows UI, without selecting WSL for every task. The existing dual-host chooser is not the intended default UX. This is **not** a new Desktop app, VM project, or security platform.

Before designing, coding or assigning work, read in order:

1. [docs/project-context.md](docs/project-context.md) — owner's intent, non-goals and approved boundaries.
2. [docs/wsl-first.md](docs/wsl-first.md) — mandatory default execution behavior.
3. [docs/product-spec.md](docs/product-spec.md) — requirements, acceptance criteria and localization.
4. [docs/architecture.md](docs/architecture.md) — established implementation.
5. [docs/roadmap.md](docs/roadmap.md) — scope, milestones and merge gates.
6. [docs/status.md](docs/status.md) — verified current state, open blockers.
7. [docs/decisions.md](docs/decisions.md) — decisions already made.
8. [docs/documentation-policy.md](docs/documentation-policy.md) — English-canonical docs and RU/ZH exceptions.

If an idea does not advance the agreed roadmap, do **not** silently turn it into a task. Ask for a new owner decision.

## Language and localization

**Always respond to the owner in Russian**, including interim progress messages, final reports, questions, status updates and test explanations. The language of a prompt, logs or upstream docs does not override this. Only an explicit owner request permits answering in a different language.

**Repository documentation and maintained source comments must be in English before main merge.** The canonical README is `README.md` (English). Translated files `README.ru.md` and `README.zh-CN.md` are allowed; keep the plugin's `en`, `ru`, `zh-CN` UI dictionaries. Do not translate identifiers, shell commands, legal license text, raw log evidence or machine formats.

## Safety and workflow

- Verify actual GitHub HEAD, branch, current Draft PR and working tree before changing code. GitHub is the source of truth.
- Preserve the upstream Windows ↔ WSL feature set, the official Desktop integration, and strict TypeScript. Avoid unrelated rewrites.
- Do not install or launch the user's **working** DeepSeek Harness Desktop/profile or modify owner projects, user credentials, Windows/WSL system configuration or other repositories without explicit permission.
- Do not create Hyper-V/VMs, Windows Sandbox, extra OS users/WSL distros or a new Windows Command Broker as a side task. None belongs to the currently approved roadmap.
- The owner has previously experienced accidental destructive file operations. Never assume `HOME`/`USERPROFILE` is a safe cleanup directory; use checked, exact paths and fake test data.
- Plugin permissions do **not** constitute OS isolation. Be precise about security guarantees.
- Do not merge a pull request without the owner's explicit approval for its exact HEAD.

## Task reports

Report **in Russian**: what changed, branch and HEAD, changed files and +/- lines, commands/tests/CI results, package hash if relevant, open risks, what was **not** run/installed, and the precise next acceptance gate. A written test plan is not an executed integration test.
