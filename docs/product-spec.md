# Product specification — dsh-wsl-native 0.8.x

**Status:** implemented in source where noted; live Windows Desktop integration has not yet been accepted.

## 1. Problem and outcome

The user has an official DeepSeek Harness Desktop on Windows and existing Ubuntu WSL2. The **Windows Desktop is the interface**; normal new chats, agent/tool execution and Linux projects should use **native Linux Harness in WSL by default**, without repeatedly choosing WSL. See [WSL-first execution contract](wsl-first.md).

The deliverable is an **extension to the official Desktop**, not a separately authored desktop shell.

## 2. Functional requirements

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| F00 | **Default normal New Chat → WSL native agent** | In official Desktop, normal new chat and prompt execute through native Linux Harness without manual WSL selection; no silent Windows fallback; verify actual supported host integration API |
| F01 | Load as an official DSH Desktop plugin | Installed in a designated test Desktop profile; visible management panel |
| F02 | List/select existing WSL2 distributions and Linux users | Correct environment identity; no new distro created |
| F03 | Select and validate a Linux workspace | Browse/open absolute Linux project paths; errors preserve prior selection |
| F04 | Prepare, launch and reuse native Linux Harness | Linux-side runtime and home, not a Windows CLI shim; no duplicate launch on repeated clicks |
| F05 | Show native Linux sessions/workspaces inside the Windows Desktop | Open WSL conversation in the existing Desktop window; Windows conversations remain usable |
| F06 | Preserve both environments' state | Switching retains per-host sessions, drafts and tools; no cross-host session DB copying |
| F07 | Reconnect safely | Reconnect after transient interruption without blindly replaying previously submitted writes/messages |
| F08 | Support cross-OS operations already available upstream | `wsl_native_*` interfaces preserve intended behavior and compatibility |
| F09 | Present Protected, Trusted and Full Access modes | Mode, explicit confirmation and expiry; grants can be viewed/added/revoked |
| F10 | Localize the plugin UI into English, Russian and Simplified Chinese | Translation parity + live language switching with English fallback |
| F11 | Distribute a reproducible `.tgz` | Rebuild/pack tests, package contents scan, SHA-256, install and rollback documentation |
| F12 | Maintain the official Desktop's appearance and normal workflow | No independent Electron UI; use supplied UI primitives and guest/browser interfaces |

## 3. Engineering requirements

- TypeScript / TSX throughout maintained code; `strict: true`. Avoid broad `any` and type suppression.
- React is permitted for the plugin panel; official Harness supplies the host, layout and UI primitives.
- Respect the DSH client bundle limit of **262,144 bytes**. Generate only the needed localization slice.
- Retain the official DSH/Cordis plugin, RPC and approval interfaces; don't replace them without evidence of an actual incompatibility.
- Preserve upstream attribution and license notices.
- Run `npm run verify`, GitHub Actions on Windows and Ubuntu with Node 22 and Node 24, and check packaged artifacts.
- Treat Desktop 0.2.1-rc.5 as the **target**, not as proof of end-to-end compatibility.

## 4. Permissions: exact scope of this release

- **Protected:** default conservative mode; unknown or sensitive operations may require DSH approval or be denied.
- **Trusted:** time-limited grants for supported capability/target/root pairs; avoid repeat prompts only where the implementation actually enforces a rule.
- **Full Access:** explicit phrase, time-limited, visible expiry, reversible; a user knowingly accepts additional risk.

These are application permissions, not an OS access boundary. In particular an agent with Windows-equivalent rights, WSL interop or mounted Windows volumes can bypass plugin protections. Do not promise containment in the same OS user context.

Windows command execution remains a supported feature. A new Broker or automatic restrictions incompatible with existing workflows are **not** part of 0.8.x.

## 5. Localization and repository language

- **Repository canonical text:** English for root `README.md`, `docs/*.md`, CHANGELOG, source comments, contributor instructions and user-directed project documentation.
- **Application UI:** keep all three locale dictionaries `en`, `ru`, `zh-CN` and their existing behavior.
- **Optional translated documentation:** `README.ru.md`, `README.zh-CN.md` or `docs/i18n/{ru,zh-CN}/`; they are expressly permitted exceptions to the English-canonical rule.
- Do not translate code identifiers, CLI flags, API paths, legal license text, recorded logs, test fixtures or generated machine data just to make them English.
- **Pi's reports to the owner remain Russian**, even when the repo documents themselves are English.

## 6. Acceptance gates

| Gate | Meaning | Current evidence |
| --- | --- | --- |
| G0 — scope and docs | Project scope/spec/architecture/roadmap and merge-language requirements recorded | To be maintained in this repo |
| G1 — code and unit checks | Strict TypeScript, i18n, tests, packaging and CI | Reported green in R03.1 and subsequent documentation runs |
| G2 — test-profile Desktop loading | Actual package loads in official Desktop under non-working profile | **Not yet executed** |
| G3 — native WSL integration | Existing Ubuntu connects; opens native Linux runtime and conversation/workspace | **Not yet executed** |
| G4 — user acceptance | Owner verifies normal **Desktop New Chat → WSL native agent and Linux tools** plus UI and failures | **Not yet approved** |
| G5 — merge readiness | English-canonical documentation, optional RU/ZH translations, CI, no unresolved release blockers | **Not yet satisfied** |

Do not change a gate's status based only on a written test plan, simulator output or code inspection. **F00 is not yet implemented or demonstrated**; the current dual-host UI alone cannot satisfy it.

## 7. Explicit non-goals

No new Desktop app, Rust migration, Hyper-V/VMs, Windows Sandbox, additional Windows accounts, new WSL distro, custom Windows Broker, bulk Windows system changes, unrelated security projects or mandatory per-command approvals. These only become work after a **new explicit owner decision**.
