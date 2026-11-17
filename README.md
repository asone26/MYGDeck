**English** · [한국어](README.ko.md)

# MYG Deck

A lightweight multi-project cockpit for running coding agent CLIs (Claude Code, Codex, Gemini CLI, Antigravity CLI, or any custom CLI) side by side in a single window.
Sessions live in a background daemon, so closing or rebuilding the window never kills your running agents — reopening reattaches right where you left off.

## Current Support & Status

- **Primary verified target**: Windows + Claude Code (daemon persistence, hook-driven GUI timeline, automatic context handoff, git worktree workflow, and unit test suite).
- **Experimental / Community feedback welcome**: macOS (`mygdeck.command`, `⌘` shortcuts) and additional adapters (`codex`, `gemini`, `antigravity`) are implemented and ready for testing, though long-running real-world verification on those platforms/CLIs is ongoing.

## Key Features

- **Real CLIs, Zero Lock-in**: Runs actual agent CLIs inside `portable-pty` + GPU-accelerated `xterm.js`. Every native slash command and shortcut still works.
- **Persistent Session Daemon**: A single `mygdeck` binary acts as GUI, session daemon (`--daemon`, ~9–15 MB RAM), and hook forwarder (`--hook`).
- **GUI View ↔ Raw CLI (`Ctrl+.`)**: For hook-enabled agents (Claude Code, Antigravity), inspect turns, tool runs, to-dos, and clickable permission/choice buttons in a clean timeline — or flip back to the raw terminal anytime.
- **Infinite Session / Context Handoff**: Tracks context usage per turn and can automatically (or manually) summarize state into `.mygdeck/progress.md`, clear/restart, and seed a fresh session seamlessly.
- **Built-in Vibe-Coding Review Tools**:
  - Live changed-file explorer, side-by-side/unified diff viewer, inline line-level review comments, single-hunk or file-level revert, and selective commit.
  - One-click **git worktree cards** (`mygdeck/wtN`) with overlap/conflict detection across open cards, safe merge-back, and clean removal.
  - Post-turn verification commands (`post_turn_cmd`), turn checkpoints, and bottom shell error extraction.
- **Multi-Project Attention & Queuing**: `Ctrl+Space` jumps to the next waiting/done card, `Ctrl+0` opens the searchable overview grid, and `Ctrl+K` opens the command palette.
- **English & Korean UI**: Automatically follows OS locale (`en` / `ko`) and can be switched anytime in **Settings** (`Ctrl+K` → Settings).

## Quick Start

### Prerequisites

- **Rust** (stable toolchain) & **Node.js** (18+)
- At least one coding agent CLI in `PATH` (e.g. `claude`, `codex`, `gemini`, or `agy`)
- On macOS: Xcode Command Line Tools (`xcode-select --install`)

### Run from Source

```bash
npm install
npm run tauri dev
```

Or pass specific project directories directly:

```bash
npm run tauri dev -- -- C:/work/app-a C:/work/app-b
```

### Build Release Binaries

```bash
npx tauri build --no-bundle       # Windows: src-tauri/target/release/mygdeck.exe & mygdeck-cli.exe
npx tauri build --bundles app     # macOS: src-tauri/target/release/bundle/macos/mygdeck.app
```

- **Windows launchers**: Double-click `mygdeck.vbs` (no console window) or `mygdeck.bat` (rebuilds incremental changes). Run `bin\install.cmd` once to add `mygdeck` / `mygdeck-cli` to `PATH`.
- **macOS launcher**: Double-click `mygdeck.command` or run `bin/install.sh`.

## Configuration (`mygdeck.json`)

Projects are saved in `mygdeck.json` (current working directory, or home directory):

```json
{
  "projects": [
    { "path": "C:/work/mygstat", "agent": "claude-code", "model": "opus", "effort": "medium", "spec_file": "MASTER_SPEC.md" },
    { "path": "C:/work/api", "command": "ssh -t myserver claude" },
    { "path": "C:/work/web", "resume": false }
  ]
}
```

## Keyboard Shortcuts

All deck shortcuts use `Ctrl` on Windows/Linux (`⌘` on macOS, except `⌃Space`, `⌃Tab`, `` ⌃` ``, `⌃Q`). Everything else passes straight through to the CLI.

| Shortcut | Action |
|---|---|
| `Ctrl+1~9` / `Ctrl+PgUp·PgDn` | Switch project |
| `Ctrl+Space` | Jump to next project needing attention (waiting → error → done) |
| `Ctrl+0` | Overview grid |
| `Ctrl+K` | Command palette |
| `Ctrl+=` / `Ctrl+-` | Card density (`Full` · `Compact` · `Mini`) |
| `Ctrl+Tab` | Cycle focus (Files · CLI · Composer) |
| `Ctrl+P` | Quick open file |
| `Ctrl+I` | Insert selected code (`@file Lx-y`) or terminal selection into composer |
| `Ctrl+;` | Toggle spec panel |
| `` Ctrl+` `` | Toggle bottom user shell |
| `Ctrl+Q` | Stop running agent (restores stopped prompt to composer) |
| `Ctrl+.` | Toggle GUI view ↔ Raw CLI |
| `Ctrl+'` / `Ctrl+F4` | Add / Close project |

## Agent Adapters & CLI

- **Adapters**: Built-in TOML adapters live in `src-tauri/adapters/*.toml` (`claude-code`, `codex`, `gemini`, `antigravity`). Add custom CLIs via `~/.mygdeck/adapters/*.toml` without touching source code. See [docs/adapters.md](docs/adapters.md).
- **CLI Companion (`mygdeck-cli`)**: Query status (`mygdeck-cli status`), send prompts (`mygdeck-cli send <project> "<prompt>"`), stop the daemon (`mygdeck-cli daemon stop`), or toggle the optional Cloudflare-tunneled mobile dashboard (`mygdeck-cli mobile on`, see [docs/mobile.md](docs/mobile.md)).

## Tests

```bash
npm test                          # Frontend unit tests
cd src-tauri && cargo test        # Backend tests (daemon, PTY, hooks, git, worktree)
```

## License

[MIT](LICENSE)
