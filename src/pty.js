import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { isDeckKey } from "./logic.js";

// keep in sync with --panel / --fg in style.css
const THEME = { background: "#111419", foreground: "#e3e6eb", cursor: "#6aa8ff", cursorAccent: "#111419", selectionBackground: "#2b3a55" };
let seq = 0;

/** Live sessions by PTY id, so backend events can find their terminal. */
export const ptys = new Map();

/** One real CLI process shown in an xterm. The CLI itself is never altered (spec 1.4 ⑧). */
export class Pty {
  constructor(host, { cwd, command, onOutput, onExit }) {
    Object.assign(this, { host, cwd, command, onOutput, onExit, alive: false });
    this.term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, 'D2Coding', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(host);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      this.term.loadAddon(gl);
    } catch {
      // WebGL unavailable: xterm falls back to its DOM renderer.
    }
    this.term.attachCustomKeyEventHandler((e) => !isDeckKey(e));
    this.term.onData((d) => this.write(d));
    let queued = false;
    new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this.refit();
      });
    }).observe(host);
  }

  async start() {
    this.id = `pty${++seq}`;
    ptys.set(this.id, this);
    this.refit();
    this.alive = true;
    try {
      await invoke("pty_spawn", { id: this.id, cwd: this.cwd, command: this.command, cols: this.term.cols, rows: this.term.rows });
    } catch (e) {
      this.alive = false;
      ptys.delete(this.id);
      this.term.write(`\r\n\x1b[31m[실행 실패] ${e}\x1b[0m\r\n`);
      this.onExit?.(null, String(e));
    }
  }

  write(data) {
    if (this.alive) invoke("pty_write", { id: this.id, data }).catch(() => {});
  }

  refit() {
    if (!this.host.offsetWidth || !this.host.offsetHeight) return;
    const { cols, rows } = this.term;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    if (this.alive && (cols !== this.term.cols || rows !== this.term.rows)) {
      invoke("pty_resize", { id: this.id, cols: this.term.cols, rows: this.term.rows }).catch(() => {});
    }
  }

  received(data) {
    // During a session rotation the new session's "erase scrollback" must not wipe the old one (spec 4.4).
    if (this.keepScrollback) data = data.replaceAll("\x1b[3J", "");
    this.term.write(data);
    this.onOutput?.();
  }

  exited(code) {
    this.alive = false;
    ptys.delete(this.id);
    this.term.write(`\r\n\x1b[90m[종료됨${code == null ? "" : ` · 코드 ${code}`}]\x1b[0m\r\n`);
    this.onExit?.(code);
  }

  /** Last non-empty screen lines, for compact cards and the overview. */
  lastLines(n, keepIndent = false) {
    const b = this.term.buffer.active;
    const out = [];
    for (let y = b.baseY + b.cursorY; y >= 0 && out.length < n; y--) {
      const raw = b.getLine(y)?.translateToString(true) ?? "";
      if (raw.trim()) out.unshift(keepIndent ? raw.trimEnd() : raw.trim());
    }
    return out;
  }

  kill() {
    if (this.alive) invoke("pty_kill", { id: this.id }).catch(() => {});
    this.alive = false;
    ptys.delete(this.id);
  }

  dispose() {
    this.kill();
    this.term.dispose();
  }
}
