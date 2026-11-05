# Roadmap — dsh-wsl-native

**Target:** a reliable 0.8.x community plugin connecting the official Windows DeepSeek Harness Desktop to a native WSL2 Harness runtime.

This roadmap is intentionally small. It is not a roadmap for building another Desktop, security product or virtualization setup. See [project context](project-context.md) and [specification](product-spec.md).

## Completed implementation stages (source/CI evidence)

| Stage | Scope | Status |
| --- | --- | --- |
| R01 | Adapt upstream v0.7.0; move host/client runtime to strict TypeScript; initial EN/RU/ZH locale support; create Draft PR | Done in source |
| R02 | Close identified permission-policy defects; restore upstream regression tests; cross-platform CI | Done in source/CI |
| R03 | Convert remaining JSX to TSX; complete panel localization and permissions UI; package checks | Done in source/CI |
| R03.1 | Fix Full Access confirmation/duration and grant `target` / `root` form contracts | Done in source/CI |
| R04-B1 | Find actual installed Desktop and bundled runtime; correct incorrect install-path assumptions | Done as read-only diagnostics |

**Important:** 'Done in source' does not imply the plugin was installed in the official Desktop.

## Next steps

| Priority | Stage | Work | Exit criteria |
| --- | --- | --- | --- |
| 1 | R04 preparation | Review the [minimal local Desktop test plan](r04-local-test.md) for the existing official installation and Ubuntu; resolve verified prerequisites such as Windows-side Node availability | Correct, executable command/path plan; owner approval required before first run |
| 2 | R04-S1 | Install a test-profile package and verify the official Desktop loads the plugin UI, locales and permission settings **without agent execution** | Real screenshots/logs and an explicit record of the profile used |
| 3 | R04-S2 | Exercise native WSL Host, project selection, Linux conversations, terminal and reconnection using dummy data | Real end-to-end results, failures and fixes reported |
| 4 | Documentation | Make the canonical repo English, preserve EN/RU/ZH UI and add/retain RU/ZH translated README as desired | Full language inventory resolved; English README, active docs, changelog and agent instructions |
| 5 | Release review | Fix confirmed defects only, review tests/CI/packaging, accept UI and migration | Owner approval for specific PR HEAD |
| 6 | Merge/release | Squash merge only on explicit permission; tag/publish only on separate direction | GitHub state and hash verified |

## Merge checklist (mandatory)

- [ ] Current PR HEAD reviewed; no unexpected code changes.
- [ ] `npm run verify` and the complete GitHub Actions matrix pass.
- [ ] Official Desktop/WSL integration performed and evidence recorded; or owner expressly accepts the untested limitation.
- [ ] Root `README.md`, active `docs/*.md`, `AGENTS.md`, `CHANGELOG.md` and human-readable maintained source comments are in **English**.
- [ ] No stale upstream release/download links presented as this fork's 0.8.0 release.
- [ ] RU and ZH locale dictionaries remain complete and tested; translated READMEs are separate from canonical English docs.
- [ ] No accidental changes to the owner's working profile, projects, Windows/WSL settings.
- [ ] Explicit owner permission: `Разрешаю squash merge PR #1 @ <exact HEAD>`.

## Not planned without a new user request

Hyper-V, VMs, nested virtualization, Sandbox, creating Windows accounts or extra WSL distributions, replacing Desktop, building a Windows Command Broker, rewriting the plugin as Rust, or changing execution APIs solely to pursue unrequested architecture work.

## Maintenance rule

Update [status.md](status.md) after each **verified** implementation milestone. Keep every task tied to a roadmap stage. If a proposed task does not advance a listed stage, ask why it belongs to this project before implementing it.
