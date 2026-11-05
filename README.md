# DSH for WSL (`dsh-wsl-native`)

[Русский](README.ru.md) · [简体中文](README.zh-CN.md) · **English**

**Goal: use the official DeepSeek Harness Desktop on Windows as the UI while normal new chats and agent/tool execution run by default in native DeepSeek Harness inside WSL2.** This WSL-first default is a **new acceptance requirement, not yet implemented or validated** in the current 0.8.0 candidate; existing dual-host switching alone is insufficient. See [WSL-first contract](docs/wsl-first.md).

This is an independent community plugin built from [Han-1413141/dsh-wsl-native](https://github.com/Han-1413141/dsh-wsl-native) (MIT). The `triagmas` fork is migrating the existing plugin to **strict TypeScript/TSX**, improving its UI localization and configurable permission modes **without replacing the official Desktop or rewriting its integration architecture**.

- **Package:** `dsh-wsl-native` **0.8.0 release candidate**.
- **Target Desktop:** DeepSeek Harness Desktop **0.2.1-rc.5**.
- **Status:** code, unit/regression tests and cross-platform CI pass; **live acceptance in the official Desktop has not yet been completed for this candidate**.
- **Development:** [Draft PR #1](https://github.com/triagmas/dsh-wsl-native/pull/1). **Not merged or published as a release.**
- **Language:** plugin UI in English, Russian and Simplified Chinese; English documentation is canonical.

## What it does

| Mode | Where Harness runs | Experience |
| --- | --- | --- |
| Windows Harness + WSL tools | Windows | Keep Windows conversations; invoke Linux tools and files through the bridge |
| Native Linux Harness launched from Windows Desktop | WSL2 Ubuntu/Linux | Native Linux Bash, files, tools, workspaces and sessions appear within the existing Windows Desktop |

Both environments retain their own runtime and sessions. The plugin adds navigation and a unified view; it **does not** migrate a running model conversation between operating systems.

Features inherited from upstream and retained in this fork:

- Connect to an existing WSL2 distribution, select a user and Linux project directory.
- Prepare, start, reuse and stop the native Linux Harness runtime.
- Show WSL workspaces and conversations alongside Windows workspaces, with a visible WSL indicator.
- Switch between conversations, resume sessions, manage workspaces, restore connections and hand off work.
- Execute supported cross-OS operations using `wsl_native_*` tools, including commands and file transfers.
- Choose **Protected**, **Trusted** or **Full Access** plugin permission modes and manage time-limited grants.
- Use localizable plugin controls and DSH-provided React UI components.

## Architecture in one picture

~~~text
Official DeepSeek Harness Desktop (Windows)
  ├─ Windows Harness sessions / projects / tools
  └─ dsh-wsl-native plugin (TypeScript host + React panel)
       ├─ DSH RPC and persistent stdio bridge
       └─ Existing WSL2 distribution (e.g. Ubuntu)
            ├─ Native Linux Harness runtime
            ├─ Linux sessions / workspaces / Bash
            └─ Linux project files and tool execution
~~~

The plugin retains the official Desktop window. It does not create another Windows GUI application or require Hyper-V, a VM, a new OS account or a second WSL distro.

See [architecture](docs/architecture.md) and [product specification](docs/product-spec.md).

## Requirements

- Installed official DeepSeek Harness Desktop; this fork targets `0.2.1-rc.5`.
- An existing WSL2 Linux distribution.
- Supported Node.js runtime: Linux Node 22.19+ (22.x) or 24+, with npm for preparing the Linux runtime. Follow the original plugin's installation requirements.
- A verified `dsh-wsl-native-0.8.0.tgz` built from the intended commit.

## Installing for evaluation — approval required

**Do not install this Draft PR build into your working Desktop profile without explicit approval.** The developer test-profile procedure is tracked in [R04 integration planning](docs/r04-isolated-test.md), which is a plan, not proof of a completed test.

For a separately approved installation, the official Desktop ships a CLI at:

~~~text
<Desktop install directory>\resources\runtime\cli\bin\dsh.cmd
~~~

The Desktop uses the `desktop` profile under the active `DSH_HOME`. It must be initialized and the Desktop must be fully closed before the plugin is added. The general CLI invocation is:

~~~powershell
& $dshDesktop plugin --profile desktop add $packagePath
~~~

Verify both `DSH_HOME` and the CLI binary before running this. Installing into some other profile (for example `r04-test`) does **not** make the Desktop load that profile. Never silently fall back to the owner's default home.

The working installation identified in the owner's machine is under `F:\-ToolBox-\DSH`; this **does not grant permission** to modify that installation or its working profile.

## Configuring and using the plugin

After the plugin is loaded by the official Desktop:

1. Open its **Windows & WSL** panel.
2. Choose an existing WSL distribution, user and Linux workspace.
3. Start or reconnect to the native Linux Harness environment.
4. Open a WSL conversation from the same Desktop and switch back to Windows conversations when needed.
5. Configure plugin permissions according to your intended workflow.

Permission modes provide application-level approvals, **not OS-level containment**. A process running under the same Windows user, WSL interop and mounted Windows drives can reach files outside plugin policies. Do not test destructive agent commands against real projects.

## Development

~~~bash
npm ci
npm run verify
npm pack
~~~

`npm run verify` runs TypeScript typechecking, ESLint, i18n checks, regression tests, bundling and package verification. GitHub Actions cover Ubuntu/Windows with Node 22/24. The plugin browser bundle has a **262,144-byte** size limit.

The reported source test baseline before this documentation batch was **175 tests: 173 pass, 2 skip, 0 fail**. This is **not** a substitute for Desktop integration acceptance. See [current status](docs/status.md).

## Project documentation

Start with the canonical project context:

- [Project context and intent](docs/project-context.md) — owner's goal and out-of-scope work.
- [Product specification](docs/product-spec.md) — requirements and acceptance gates.
- [Architecture](docs/architecture.md) — Windows/WSL runtime design.
- [Roadmap](docs/roadmap.md) — implementation stages and merge checklist.
- [Current status](docs/status.md) — verified accomplishments and missing acceptance evidence.
- [Decision log](docs/decisions.md) — choices that agents must not forget.
- [Documentation and language policy](docs/documentation-policy.md) and [translation inventory](docs/translation-inventory.md) — English main docs, RU/ZH localizations, and remaining pre-merge translation work.
- [Desktop guide](docs/desktop.md), [usage](docs/usage.md), [troubleshooting](docs/troubleshooting.md) and [R04 test plan](docs/r04-isolated-test.md).

Some legacy guides are still awaiting English translation; **English-canonical documentation is a merge gate**, not a claim that translation has already finished.

## Attribution and license

MIT. Original author and source: [Han-1413141/dsh-wsl-native](https://github.com/Han-1413141/dsh-wsl-native). This fork is community-maintained, not an official DeepSeek or Microsoft product. See [LICENSE](LICENSE) and [third-party notices](docs/third-party-notices.md).
