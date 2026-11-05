# Public WSL Web Shell — fresh-repository handoff

**Owner decision: 2026-11-05.** Retire the old `dsh-wsl-native` plugin and its intermediate Electron draft. Do not rewrite/delete the historical repository. Create a **new public repository with a fresh history**, suggested name: `triagmas/wsl-web-shell`. This is a product specification for migration, **not evidence that the new repository exists**.

## Product

A small standalone **Windows Electron application** that launches an existing WSL distribution as needed, starts and supervises a native **Linux Web GUI backend**, and displays the backend's **original WebUI** in one application window. The first supported backend preset is **DeepSeek Harness** (`dsh web`). This must never alter the installed Windows DeepSeek Harness Desktop, patch Electron asar, create a competing chat UI, or require a browser address bar.

**Browser window:** no URL input, tab strip, browser chrome or local reimplementation of backend pages. Fixed verified localhost origin chosen by a vetted profile; default DeepSeek profile: `http://127.0.0.1:3080`. User may configure which *WSL distribution, command, port and backend preset* to start in the application's Settings/tray, but should not be able to navigate the application to arbitrary websites.

**WSL:** `wsl.exe -d <selected-distro> --exec <safe launcher>` starts the existing distro even if WSL was not running. The app launches `dsh web --host 127.0.0.1 --port 3080 --no-open` inside it; authentication startup URL includes an ephemeral token. Parse this URL from owned process stdout, validate the exact expected local origin, privately bootstrap browser auth cookie and never store/log the raw token. If the port is occupied by an unknown server, show a conflict instead of loading it. No silent installation or background update of DSH.

## Runtime state machine

| State | UI | Action |
| --- | --- | --- |
| CHECKING | Branded loading screen | Check WSL distro, runtime and port/ownership |
| STARTING_WSL | Animated splash: “Starting Ubuntu…” | Start selected existing WSL distro with `wsl.exe` |
| STARTING_WEB | “Starting DeepSeek Harness…” | Start managed Linux Web server, validate output/token |
| CONNECTING | “Connecting to WebUI…” | Authenticate and load original Web UI inside Chromium |
| READY | Original WebUI only | Normal native Harness work |
| HIDDEN_IN_TRAY | No visible window; tray icon active | Keep supervised backend process alive |
| RECOVERING | Full-window subtle dim/blur and status | On liveness failure, try controlled restart of **owned** server, refresh auth, restore WebUI |
| ERROR | Clear message + Retry + Diagnostics | No misleading READY, no silent Windows fallback |
| QUITTING | Tray Quit exits app | Gracefully terminate only an owned backend (by explicit policy); never kill distro or unrelated processes |

**Tray behavior:** clicking window Close hides it, it does **not** terminate the Electron main process or Linux server. Windows taskbar/notification area icon remains. Tray menu: Open, Status, Restart WebUI, Settings, Quit. Restore from tray triggers an immediate readiness check. Background health check must continue at a low rate even when window hidden (main-process scheduler, not a renderer timer): proposed visible 5–10 seconds, hidden 20–30 seconds. On detected failure, restart with bounded exponential backoff (e.g., 1/2/4/8/16 seconds, capped retries and cooldown), preventing loops and duplicate launches. Keep the user's Linux session data in WSL; reauth via fresh startup token after restart. Never `wsl --shutdown` or kill unrelated processes.

**Process ownership and collisions:** use Electron single-instance lock and a single per-profile launch mutex. Mark the backend child this app started; verify the listener is the expected authenticated process, not any random service on port 3080. Do not “adopt” unknown servers based on HTML/title. Use graceful shutdown/restart of only owned children; report failure if process is externally controlled.

## Visual direction: 21st.dev inspired, not embedded into Harness

Three legitimate references:
- [Orbital Loader](https://21st.dev/@molecule-lab-rushil/components/orbital-loader) — **preferred**: elegant orbiting ring/dots + short stage label on a dark neutral background. Source listing reports React/Motion dependencies; do **not** import the entire UI dependency stack merely for a splash. Implement the same *interaction concept* with small **original** local HTML/CSS/animations or properly licensed reusable code.
- [Load Ripple](https://docs.21st.dev/@ruixen.ui/components/load-ripple) — understated concentric ripples, possible variant.
- [Loader Skeleton](https://docs.21st.dev/@animbits/components/loaders-skeleton) — use only if meaningful startup content skeleton exists, not to create a fake WebUI.

Recommended UX: one centered glowing orbit, small app mark, status (“Launching Ubuntu”, “Starting Harness”, “Connecting to WebUI”), subtle animated line, and **no fake progress percentages**. Fade away when authenticated GUI is ready. If WebUI dies while visible, dim behind a separate local splash, display “Reconnecting”; if hidden in tray, keep supervising and present appropriate status on restore. Respect reduced-motion system preference and color scheme. **Never inject custom CSS/components into the DSH Web GUI.**

## Security and public release

Use current supported Electron, `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`, no privileged APIs available to hosted Web content. Validate all navigation/new-window destinations (fixed origin) and keep URL bar absent. Store user session in an isolated Electron profile, not the Windows official Desktop profile. Bind only to local loopback, never `0.0.0.0`, and do not expose the Web token in logs, diagnostic bundles, screenshots or public issues.

Package Windows x64 EXE; allow settings for distro, WebUI backend preset, port, app theme/loader style and tray behavior. Generic backend profiles are an **extension point**, not permission to execute untrusted arbitrary internet links. No hidden package installation or elevation. MIT-compatible attribution and documentation in English; reports to owner in Russian.

## Work stages

1. **R00:** user creates a fresh **public** GitHub repo (GitHub connector currently lacks create-repository or change-visibility operations). Pi reads this brief, checks official DSH web auth and Electron APIs, scaffolds TypeScript/Electron, replaces all old plugin assumptions with fresh code and tests.
2. **R01:** implement app lifecycle, WSL start, supervised Web GUI, token bootstrap, tray, recovery states, local CSS splash and verified navigation. Unit tests and Windows x64 packaging.
3. **R02:** only with separate owner authorization run the actual EXE and WSL Web server, test idle-tray preservation, kill **only the app-owned test process** to verify recovery, restore window, check sessions and dummy Linux project, demonstrate no modifications to Windows DSH Desktop/profile. Release and merge require explicit approval.

**Do not start Linux GUI, install packages, delete the old repository, change the owner's working Windows Desktop or merge without authorization.** Default `main` in the new repository will be scaffolded only after the owner has created it and given access. 
