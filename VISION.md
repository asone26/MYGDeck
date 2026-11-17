# MYG Deck Vision & Architecture

> *"Don't write code. Command your agents."*

MYG Deck is a lightweight, single-window cockpit for running multiple coding agent CLIs (Claude Code, Codex, Gemini CLI, Antigravity CLI, or any custom CLI) side by side. It is built for developers who orchestrate multiple projects in parallel and want full terminal fidelity without Electron bloat or vendor lock-in.

---

## 1. North Star & Core Principles

New features are evaluated against one question: **does this remove friction from running multiple coding agents in parallel?**

### The Anti-Electron Guarantee
- Built on **Tauri v2 (Rust)** + the **OS-native WebView** (Edge WebView2 on Windows, WebKit on macOS) and **Vanilla JS + Vite** — no bundled Chromium or Node.js runtime.
- The persistent session daemon uses ~9–15 MB RAM and keeps `portable-pty` sessions alive even when the GUI window is closed or rebuilt.

### No-Code-Editor / Zero-Bloat
- Legacy typist IDE subsystems — LSPs, inline autocomplete, visual debuggers, and extension marketplaces — are intentionally excluded.
- Instead, MYG Deck focuses strictly on agent supervision and review: a fast read-only code viewer, live changed-file explorer, side-by-side/unified diff viewer with hunk/file revert, inline review comments, and one-click git worktree isolation (`mygdeck/wtN`) with cross-card conflict detection.

### CLI First, Zero Lock-in
- Agents run as **real CLIs** inside `portable-pty` + GPU-accelerated `xterm.js` (WebGL). Every native slash command, shortcut, and interactive prompt works out of the box.
- For hook-enabled agents, `Ctrl+.` flips between a clean, hook-driven GUI timeline (turns, tool runs, clickable permission choices) and the raw terminal at any time.
- Everything MYG Deck creates (e.g. `.mygdeck/progress.md`, `mygdeck.json`) is plain text. You can leave MYG Deck at any time and continue using your CLIs directly.

### Infinite Session (Context Handoff)
- Long-lived memory belongs in **files**, not ephemeral chat history.
- MYG Deck tracks per-turn context usage and can automatically or manually summarize state into `.mygdeck/progress.md`, clear/restart the session, and seed a fresh session seamlessly in the same card.

### Agent & Model Neutrality
- **Data-only TOML adapters**: Adding a new CLI agent requires a single `.toml` file (`~/.mygdeck/adapters/*.toml`), not plugin code or recompilation.
- **Any connection**: Mix local/free models, subscription CLIs, and paid APIs. API keys are stored in the OS keychain (Windows Credential Manager / macOS Keychain), never in plain-text config files.

---

## 2. System Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│  mygdeck (Tauri v2 GUI Window)                                  │
│  WebView2 / WebKit · Vanilla JS · xterm.js (WebGL) · File/Git   │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Loopback socket + token (~/.mygdeck/daemon.json)
┌──────────────────────────────┴──────────────────────────────────┐
│  mygdeck --daemon (Persistent Session Daemon, ~9–15 MB RAM)     │
│  Owns all agent & shell PTYs · 256 KB ring buffer per session   │
└───┬──────────────────────────┬──────────────────────────────┬───┘
    │                          │                              │
    ▼                          ▼                              ▼
[Agent CLIs]            [mygdeck --hook]               [mygdeck-cli]
claude / codex /        Forwards hook events           status · send ·
gemini / agy / ssh      from agent CLIs                daemon stop · mobile
```

- **Decoupled Lifetime**: The daemon runs from a copied binary in `~/.mygdeck/bin/` so rebuilding or closing the GUI window never locks the binary or kills active agents.
- **Fault Isolation**: An agent crash or non-zero exit affects only its own card and never impacts sibling projects or the main window.
- **Optional Mobile Dashboard**: `mygdeck-cli mobile on` exposes a Cloudflare-tunneled web dashboard with Web Push notifications without opening public ports on your machine (see [docs/mobile.md](docs/mobile.md)).

---

## 3. Scope Matrix (In-Scope vs. Non-Goals)

| Area | In-Scope | Non-Goals |
|---|---|---|
| **Editor & Review** | Read-only syntax-highlighted viewer, `Ctrl+P` quick open, diff viewer, inline review comments, hunk/file revert, git worktree cards | Manual text-typing editor, inline autocomplete, refactoring engine, LSP |
| **Agents** | Real CLI execution via `portable-pty`, composer assist, hook-driven GUI timeline (`Ctrl+.`), TOML adapters, SSH remote commands | Custom chat UI replacing the CLI, agent-specific plugin code, auto-injecting open files |
| **Ecosystem** | Companion CLI (`mygdeck-cli`), bottom user shell, spec panel, optional Cloudflare mobile dashboard | Third-party extension marketplace or plugin store |
| **Settings & Data** | Minimal `mygdeck.json` config, OS keychain for secrets, local file watching | Central user accounts, cloud project sync, remote database dependencies |
