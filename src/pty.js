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

/**
 * One real CLI process shown in an xterm. The CLI itself is never altered (spec 1.4 ⑧).
 * The process lives in the session daemon: `key` (project + role) lets a reopened window find it again.
 */
export class Pty {
  constructor(host, { key, cwd, command, onOutput, onExit, scrollback = 5000 }) {
    Object.assign(this, { host, key, cwd, command, onOutput, onExit, alive: false });
    this.term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, 'D2Coding', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback,
      theme: THEME,
      allowProposedApi: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(host);
    this.covered = false;
    this.useGl();
    this.term.attachCustomKeyEventHandler((e) => !isDeckKey(e));
    this.term.onData((d) => this.write(d));
    let queued = false;
    new ResizeObserver(() => {
      this.useGl();
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this.refit();
      });
    }).observe(host);
  }

  /**
   * WebGL only while the terminal is on screen (A6): each one holds a GPU context and glyph atlas,
   * and the browser drops the oldest past ~16. Hidden or covered terminals keep their buffer and
   * fall back to the DOM renderer, which costs nothing while nothing is painted.
   */
  useGl() {
    const want = !this.covered && this.host.offsetWidth > 0 && this.host.offsetHeight > 0;
    if (want && !this.gl && !this.glFailed) {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => {
          gl.dispose();
          if (this.gl === gl) this.gl = null;
          // Contexts keep running out: stop asking for one.
          if ((this.glLost = (this.glLost ?? 0) + 1) >= 3) this.glFailed = true;
        });
        this.term.loadAddon(gl);
        this.gl = gl;
      } catch {
        this.glFailed = true; // WebGL unavailable: stay on the DOM renderer.
      }
    } else if (!want && this.gl) {
      this.gl.dispose();
      this.gl = null;
    }
  }

  /** The GUI view lies over the terminal: nothing of it is visible. */
  setCovered(covered) {
    if (this.covered === covered) return;
    this.covered = covered;
    this.useGl();
  }

  async start() {
    this.id = `${this.key}|${Date.now().toString(36)}${++seq}`;
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

  /** Take over a session that kept running in the daemon: replay its recent output, then go live. */
  async attach(id) {
    Object.assign(this, { id, alive: true, replaying: true });
    ptys.set(id, this);
    this.refit();
    try {
      await invoke("pty_attach", { id });
    } catch {
      Object.assign(this, { alive: false, replaying: false });
      ptys.delete(id);
      return false;
    }
    // A size change makes full-screen CLIs repaint for this terminal's size.
    const { cols, rows } = this.term;
    invoke("pty_resize", { id, cols, rows: Math.max(2, rows - 1) })
      .then(() => invoke("pty_resize", { id, cols, rows }))
      .catch(() => {});
    return true;
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

  received(data, replay = false) {
    // Live output that arrived before the replay is already inside it.
    if (replay !== !!this.replaying) return;
    this.replaying = false;
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
      // keepIndent also keeps blank lines between content (paragraph breaks), not the ones below it.
      if (raw.trim()) out.unshift(keepIndent ? raw.trimEnd() : raw.trim());
      else if (keepIndent && out.length && out[0] !== "") out.unshift("");
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
