# R04-W1 — one primary New Chat, WSL-backed

Implements options **D + C** from
[the R04-W0 audit](r04-w0-integration-audit.md) and records the shortcut limit
that the Desktop API imposes.

## What the user sees

- The sidebar's own **New Session** button is still hidden
  (`[data-dsh-wsl-replaced]`); in its place there is **one** primary control,
  *New chat in WSL*, which uses the selected distribution.
- A smaller icon control next to it is the **explicit Windows mode**. It is
  never the default, it is hidden in a narrow sidebar, and the primary action
  cannot reach it.
- With no distribution configured, the primary control shows a localized error
  and opens the plugin panel. It does not create a Windows session.

## Routing decision

`src/new-chat.ts` holds the whole decision and has no dependency on React or the
DOM:

```text
active environment with a distribution  -> wsl (that environment)
persisted distribution, nothing open    -> wsl (that distribution)
otherwise                               -> error: wsl-not-configured
```

The `NewChatPlan` type has no `windows` member, so the default path cannot
produce a Windows session even by accident. `ConversationModel.createLinux()`
uses the plan, and `createWindows()` is the only caller of the Windows path; it
is reached exclusively from the explicit control.

## Shortcut command

`client.tsx` registers one command through `ctx.shortcuts`:

| Field | Value |
| --- | --- |
| id | `dsh-wsl-native.session.new` |
| label | `client.newWslChat` (localized) |
| aliases | `new wsl chat`, `new chat in wsl`, `wsl chat` |
| defaults | none — the command exists unbound |
| action | `createLinux()` (same routing as the button) |

The command is registered only when the `shortcuts` service is present
(`ctx.inject(['shortcuts'])`), so a host without it still loads the plugin.

## Why Ctrl+N cannot be assigned directly (verified limit)

`ui-workspace` registers `session.new` with `Ctrl+N`
(`desktop:windows`, modifiers `['primary']`). The catalog's `register()` rejects
a second claim on the same chord, and the editor refuses a `set` edit that
conflicts with a shipped default: `effectiveShortcuts()` marks the shipped
command as conflicting and `editShortcutDocument()` returns `{ status:
'conflict' }` instead of saving. Attempting to bind `Ctrl+N` to this plugin's
command in one step therefore fails — the limit is a property of the Desktop
API, not of this plugin.

What does work, using only the supported editor:

1. Clear the shipped binding: set `session.new` to *unbound* (an explicit
   `null` override, which the schema allows).
2. Assign `Ctrl+N` to *New chat in WSL*.

After step 1 the two commands no longer overlap, so step 2 is accepted. The
native Windows session then has no shortcut until the user restores it. This is
a two-step, per-device manual action stored in the Desktop's
`userData/keybindings.json`; the plugin cannot perform it and must not claim
otherwise.

## Tests

`test/new-chat.test.ts` (8 cases) covers:

- the active environment's distribution wins, so the chosen Ubuntu is kept;
- the persisted distribution is used when nothing is open;
- a whitespace-only or missing distribution is an error, not a fallback;
- no input produces a Windows plan;
- planning does not mutate the persisted selection;
- the command id and aliases stay stable.

Run with `node scripts/test.mjs` or `npm test`.

## Not done

- The Desktop was not launched and the plugin was not installed; the working
  profile was not touched.
- No interception of the shipped button or chord: both remain the host's, as
  the R04-W0 audit concluded.
