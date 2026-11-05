# Architecture and product decision log

This file records decisions made for the current `dsh-wsl-native` fork so agents do not reconstruct or change them in every conversation.

| ID | Decision | Rationale / consequence |
| --- | --- | --- |
| D001 | **Reuse official Windows DeepSeek Harness Desktop.** | We are building a plugin, not replacing or reimplementing the Desktop app. |
| D002 | **Native Linux Harness inside existing WSL2.** | Linux project tools, sessions, Bash and files must execute in the Linux environment, not in a Windows emulation layer. |
| D003 | **Migrate plugin JavaScript to strict TypeScript / TSX.** | Maintainability and typed boundaries without rewriting the runtime architecture. No Rust. |
| D004 | **Retain upstream plugin capabilities and cross-OS execution.** | Preserve Windows ↔ WSL bridge, embedded conversations, workspace management, compatibility and practical autonomous workflows. |
| D005 | **Three permission modes: Protected, Trusted, Full Access.** | Allow configurable user trust and limited prompts rather than an unconditional confirmation for every agent command. |
| D006 | **Do not describe plugin approvals as a sandbox.** | WSL interop, mounts and same-user rights remain outside a plugin's control. Report limits accurately. |
| D007 | **No bespoke Windows Command Broker in 0.8.x.** | Proposed broker/restricted-token/mandatory-per-command redesign is not the agreed project and risks breaking ordinary Windows build/install tasks. |
| D008 | **No VM/Hyper-V/Sandbox/account/distro project.** | Those were unrequested side tracks. Use existing Windows Desktop and existing Ubuntu for the planned integration; discuss alternatives only when explicitly asked. |
| D009 | **English-canonical repository before main merge.** | `README.md`, maintained docs and source comments in English; retain `ru`, `en`, `zh-CN` UI and optionally translated RU/ZH READMEs. |
| D010 | **Russian owner communication.** | Pi reports and explanations must be Russian regardless of the language of code or documentation. |
| D011 | **Explicit approval for install/system changes/merge.** | Unit development and documentation are distinct from installing into the working Desktop or merging the Draft PR. |
| D012 | **GitHub is the source of truth.** | Verify HEAD, branch, tests and actual code before tasks. Use one existing Draft PR unless the owner says otherwise. |

## Explicitly undecided

- Exact acceptance-test method and date for the first real Desktop profile run.
- Whether to publish the 0.8.0 release immediately after acceptance or perform a separate release review.
- Subsequent feature work after the existing Desktop + WSL integration succeeds.

These are **not** invitations for autonomous scope expansion.

## Change control

To change any decision, record the owner's explicit new direction, describe the impact, update [project-context.md](project-context.md), [product-spec.md](product-spec.md) and [roadmap.md](roadmap.md) as needed, and keep the existing behavior until the change is approved.
