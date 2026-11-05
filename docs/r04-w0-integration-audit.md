# R04-W0 — WSL-first routing: integration audit of Desktop 0.2.1-rc.5

Status: **audit complete, no code written.** The official extension surface does
not expose a supported way to reroute the Desktop's own New Chat action, so
R04-W0 stops at the decision gate described at the end.

Method: the installed build `F:\-ToolBox-\DSH\resources\app.asar` (182,766,714
bytes, 16,651 entries, 6,318 under `@deepseek-ai/`) was read directly; package
READMEs and client bundles were inspected. Nothing was launched, installed or
modified.

## 1. Behaviour matrix — what happens today

| User action | Current path | Required target |
| --- | --- | --- |
| Open the Desktop | Windows Host process starts; the plugin panel is a sidebar entry | unchanged (UI stays Windows) |
| Click the sidebar **New Session** button | `ProjectRowItem` → `onCreate` → `startSession(group.workspaceId)` → `browserInjected.startSession` → `uiWorkspace.startSession()` → **Windows Host session** | Linux Harness session |
| Press **Ctrl+N** (`session.new`) | `ctx.shortcuts` → `navigation.startSession()` → **Windows Host session** | Linux Harness session |
| Send a prompt | Windows Host agent, Windows tools | Linux agent, Linux tools |
| Open an existing Windows session | Windows Host session | unchanged legacy behaviour |
| Plugin's own **WSL** button | `chat.enter(settings, {create: true})` → signed handoff → Linux Host guest in the same window | this is the only Linux path today |
| WSL unavailable | `newLinux` without a distro opens the plugin panel instead of creating anything | error, never Windows |

The plugin's `src/native-workspaces.ts` already augments the sidebar DOM: it
inserts `Windows`/`WSL` buttons after the native one and hides the native button
through `[data-dsh-wsl-replaced] { display:none }`. That is the dual-host chooser
the owner has rejected; it is not routing.

## 2. What the official surface does offer

Verified extension points in 0.2.1-rc.5:

- **85 client slot names** (`main`, `main.conversation`, `sidebar.workspaces`,
  `sidebar.panellist`, `sidebar.footer.action`, `sidebar.session.row.*`,
  `sidebar.workspaces.session.menu.item`, `conversation.*`, `settings.*`,
  `shell.overlay`, `workspace.toast*`, …). None is a new-session action.
- **Client services** usable by a plugin: `slots`, `locale`, `layout`,
  `workspaces`, `sessions`, `uiWorkspace`, `connection`, `shortcuts`,
  `remoteAccess`, `sidebarRight`.
- **Host services**: `ctx.tools`, `webServer`, `profileContext`, plus the plugin's
  own RPC routes (`dsh-wsl-native/*`).

The plugin already calls `uiWorkspace.startSession(...)`, `workspaceController`
mutations and `ctx.layout.selectPanel(...)`, so it can *create* sessions through
the official client API — always in the Windows Host that owns them.

## 3. Why routing the native New Chat is not supported

1. **The button belongs to another package.** In
   `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` the control is a plain
   React `button` inside `ProjectRowItem`:
   `onClick: (e) => { e.stopPropagation(); onCreate(); }`, and the row passes
   `onCreate: () => startSession(group.workspaceId)`. Neither the button nor the
   callback is a slot, a service method or a documented hook.
2. **The shortcut cannot be replaced.** `ui-workspace` registers it through
   `ctx.shortcuts.register({ id: 'session.new', …, defaults: { 'desktop:windows':
   { code: 'KeyN', modifiers: ['primary'] } }, resolve: () => ({ status:
   'handled', run: () => navigation.startSession() }) })`. The shortcuts README
   states the service *"rejects duplicate ids and overlapping default
   combinations across supported profiles"*, so a plugin cannot claim the same
   id or the same chord.
3. **Desktop shortcuts never reach the DOM.** The same README: *"Windows and
   macOS Desktop intercept complete accepted combinations before local handlers
   and forward them through the trusted preload … only native input dispatches
   configurable commands; DOM input continues to feed fixed actions."* A DOM
   `keydown` capture handler therefore cannot intercept Ctrl+N at all.
4. **The service is not substitutable.** `UiWorkspaceService` is constructed
   inside that package (`super(ctx, 'uiWorkspace')`) with private fields
   (`workspaces`, `sessions`, `view`, `notify`). Cordis service registration is
   first-come; a plugin cannot replace or wrap the instance.
5. **No host/machine parameter exists.** `sessionController` and
   `workspaceController` Remote namespaces address the local Windows Host only
   (`session/create`, `session/created`, workspace mutations). There is no
   `host`, `machine` or `remote` argument anywhere in the creation path, so
   "create this session in the Linux Host" is not expressible through the API.
6. **Slot collisions do not help.** Reusing a shipped id at another priority is
   documented only for session-row menu entries, where the plugin owns the
   entry; there is no such seat for the sidebar New Session control.

Consequence: with only supported APIs, a plugin cannot make the Desktop's own New
Chat button or Ctrl+N create a Linux session. Anything that appears to do so is
either a DOM intervention or a second, plugin-owned button.

## 4. Options for the owner's decision

| # | Option | Supported? | Cost / risk | Covers button | Covers Ctrl+N |
| --- | --- | --- | --- | --- | --- |
| A | DOM capture-phase interception of the native button: stop the React click and call the plugin's `newLinux()`; keep the native button visible | No — undocumented DOM contract | Breaks if the class name, element nesting or handler changes; no guarantee against future releases. It would only work because React delegates clicks at the root container, which is read from the bundle, not proven by a live test | yes | no (native bridge) |
| B | Upstream API request: a `sidebar.workspaces.newSession` action seat, or a routing hook on `uiWorkspace.startSession` | Would be official | Needs a DSH change and a release; nothing to implement in this repo until then | yes | yes |
| C | Register a plugin command without defaults and let the user rebind Ctrl+N manually | Yes, official | Manual one-time step per device; an explicit override displaces the shipped default; the button stays Windows | no | yes |
| D | Single primary button on the native seat: the plugin's own "New chat (WSL)" replaces the hidden native button, with "Windows session" moved into the row menu | Yes for the button (already in the plugin's DOM-augmentation style), still not the native control | The visible affordance is the plugin's, not DSH's; no interception claim; the shortcut remains Windows | effectively yes (visually) | no |
| E | Watch `session/created` and open the Linux guest afterwards | Yes, but wrong | Creates a Windows session first, exactly the silent-Windows behaviour the contract forbids | no | no |

Option D is the smallest step that removes the dual-host chooser and gives
WSL-first behaviour for the visible New Chat affordance without claiming
interception. Option B is the only path that makes the real DSH control and
shortcut WSL-first. Option A is the only immediate way to route the real button
and it is undocumented; the shortcut stays Windows in every case, which means a
keyboard-first user would still land in Windows.

## 5. What this audit did not do

- The Desktop was not launched; no plugin was installed; the working profile was
  not touched.
- No source or test change accompanies this document, because the only supported
  implementations (C, D) are product decisions, not code corrections, and the
  unsupported one (A) contradicts the instruction to rely on official APIs.

## 6. Decision requested

Choose one of: A (accept an undocumented DOM interception for the button only),
B (wait for / request the upstream seat), C (manual rebind), D (plugin button on
the native seat, WSL as default, Windows in the row menu). Until one is chosen,
R04-W0 remains blocked and no routing claim is made.
