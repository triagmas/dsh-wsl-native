# WSL-first execution contract

**Owner decision: 2026-11-05.** This is the primary product goal and supersedes the earlier assumption that the user routinely chooses between two equal Windows/WSL runtimes.

## Desired experience

**The official DeepSeek Harness Desktop runs on Windows as the user interface. The actual agent/harness execution must default to the full native Harness runtime inside the user's existing Ubuntu WSL2.**

Expected default flow:

~~~text
Official DeepSeek Harness Desktop (Windows UI)
  -> dsh-wsl-native plugin (typed integration and routing)
     -> existing WSL2 Ubuntu / native DeepSeek Harness
        -> model requests, agent orchestration, tool calls,
           Bash, project files and task state inside Linux
~~~

The user opens the existing Desktop, writes a normal request, and gets a WSL-backed session **without needing to choose WSL for every new chat**. Default new-session creation, reopening a session, navigating workspaces, and the first launch must use the WSL-backed runtime when the plugin is active and configured.

## Critical distinction

This is **not** merely a plugin that allows the user to choose between two independent, equal-weight Harness environments. The existing upstream plugin already supports an optional Windows/WSL switch; the fork's desired product behavior is **WSL-first routing**.

- Windows Desktop remains the UI process; do not replace or fork it.
- Windows-side DSH/runtime functionality may still be present because the official Desktop itself requires it, but it is **not** where routine agent sessions execute.
- A separate **explicit** Windows mode may be preserved for compatibility, but it must not be the default path.
- Do not claim that installing the plugin transparently redirects every native Windows host hook unless source/runtime checks prove it. Inspect which Desktop actions and DSH extension APIs can actually be intercepted.
- No silent fallback to running an agent in Windows when the WSL host is unavailable: show an actionable connection error/retry option. Never mislabel a Windows session as Linux-backed.
- Never silently migrate or reroute an *existing Windows conversation* to Linux; that is not a context migration. Existing Windows sessions may remain visibly separate as legacy/explicit mode.

## One-time setup

The first use may ask to choose the installed WSL distribution/user and Linux project root once. Save the choice. Thereafter, new sessions use the configured WSL runtime automatically; the Linux runtime should start/reconnect on demand as needed.

## Verify before implementing

Do not presume the current plugin already intercepts the official Desktop's top-level "New chat", session restoration, project creation, CLI and model routing. Inspect the real DSH 0.2.1-rc.5 client slots and the source of `src/native-workspaces.ts`, `src/native-sidebar.tsx`, `src/conversations.tsx` and associated session handlers; identify supported integration points and gaps.

Produce a compact behavior matrix:

| User action | Required target |
| --- | --- |
| Open Windows Desktop | Existing official app starts; plugin selects configured WSL for future work |
| Click main New Chat / press new-chat shortcut | New **WSL-backed native Harness** conversation |
| Send a prompt in that chat | Native Linux Harness agent handles it (not Windows agent) |
| Invoke Bash/tool or open project | Native Linux environment and files, unless an explicit cross-OS tool is requested |
| Reopen a WSL session or switch WSL workspaces | Remain bound to the same native Linux runtime/environment |
| WSL missing or cannot connect | Visible error; **never silently execute in Windows** |
| User explicitly chooses Windows mode | Windows-native agent only after deliberate selection (optional legacy compatibility) |

If the official Desktop prevents reliable interception of its main New Chat action, document the exact limitation and propose the smallest supported plugin/host API solution for owner's decision. Do not solve it by inventing a new Desktop or changing global Windows settings.

## Scope and gates

Keep the existing strict TypeScript migration, EN/RU/ZH-CN UI, runtime integration and necessary compatibility checks. The recently built 0.8.0 and its unit tests remain useful but **do not prove WSL-first routing**.

Priority:

1. Verify where standard Desktop new-chat and send-prompt actions go today.
2. Implement **WSL-first default routing** at supported extension points with no behavior spoofing.
3. Test default creation/send/reopen/error handling in unit/integration tests.
4. Complete owner-approved real-Desktop acceptance, translations and merge gates.

The R04-S1 test-profile isolation work can be reused as a prerequisite to running a live test; it is **not the product objective**. No VM/Hyper-V/Broker/new distro/new Windows UI.

Acceptance: In the unchanged official Desktop window, after configuring WSL once, user creates a normal new chat and types a request; the request and its tool execution are demonstrably handled by **Linux native Harness** in WSL without selecting a separate WSL button.
