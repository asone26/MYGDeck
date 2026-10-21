import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Pty } from "./pty.js";
import { Explorer } from "./explorer.js";
import { Viewer } from "./viewer.js";
import { Composer } from "./composer.js";
import { BADGE, basename, hookStatus, pasteSequence, projectColor } from "./logic.js";

const TEMPLATE = `
<div class="head">
  <span class="dot"></span><span class="idx"></span><b class="name"></b><span class="agent"></span>
  <span class="badge"></span><span class="stext"></span>
  <button class="b-restart" title="다시 시작" hidden>↻ 다시 시작</button>
  <button class="b-close" title="닫기 (Alt+W)">×</button>
</div>
<div class="mods">
  <details class="m-files"><summary>파일 <span class="cnt"></span> <span class="kbd">Ctrl+P</span></summary><div class="explorer"></div></details>
  <details class="m-spec"><summary>스펙 <span class="spec-name"></span></summary><div class="spec md"></div></details>
</div>
<div class="body"><div class="term"></div><div class="viewer" hidden></div></div>
<div class="shell" hidden></div>
<pre class="peek"></pre>
<div class="composer"></div>`;

let cardSeq = 0;

/** One isolated project: its own agent CLI, files, spec and input (spec 3.0, 3.2). */
export class Card {
  constructor(app, cfg, adapter) {
    Object.assign(this, { app, cfg, adapter, root: cfg.path, name: basename(cfg.path) });
    this.id = `c${++cardSeq}`;
    this.color = projectColor(this.name);
    this.hooks = adapter?.status === "hooks";
    this.files = null;
    this.peek = [];
    this.el = document.createElement("section");
    this.el.className = "card";
    this.el.style.setProperty("--pc", this.color);
    this.el.innerHTML = TEMPLATE;
    this.$ = (sel) => this.el.querySelector(sel);
    this.$(".name").textContent = this.name;
    this.$(".name").title = this.root;
    this.$(".agent").textContent = adapter?.name ?? (cfg.command ? "custom" : "shell");
    this.$(".b-close").onclick = () => app.closeCard(this);
    this.$(".b-restart").onclick = () => this.restart();
    this.el.addEventListener("mousedown", () => app.setActive(app.cards.indexOf(this), false));
    const spec = this.$(".m-spec");
    spec.addEventListener("toggle", () => spec.open && this.loadSpec());
    // Links in a spec would navigate the whole app away.
    this.$(".spec").addEventListener("click", (e) => e.target.closest("a") && e.preventDefault());

    this.explorer = new Explorer(this, this.$(".explorer"));
    this.viewer = new Viewer(this, this.$(".viewer"));
    this.composer = new Composer(this, this.$(".composer"));
    this.agent = new Pty(this.$(".term"), {
      cwd: this.root,
      command: this.launchCommand(),
      onOutput: () => this.onOutput(),
      onExit: (code, err) => this.onExit(code, err),
    });
    this.setDensity("full");
    this.setStatus("starting", "시작 중");
  }

  launchCommand() {
    if (this.cfg.command) return this.cfg.command;
    if (!this.adapter) return this.app.shell;
    return [this.adapter.launch, this.adapter.hook_args].filter(Boolean).join(" ");
  }

  start() {
    this.agent.start();
    invoke("watch_project", { id: this.id, root: this.root }).catch(() => {});
    this.explorer.refresh();
  }

  restart() {
    this.$(".b-restart").hidden = true;
    this.setStatus("starting", "다시 시작");
    this.agent.start();
  }

  setIndex(i) {
    this.$(".idx").textContent = `#${i + 1}`;
  }

  setStatus(status, text) {
    Object.assign(this, { status, statusText: text });
    this.el.dataset.status = status;
    this.$(".badge").textContent = BADGE[status];
    this.$(".stext").textContent = text;
    this.$(".stext").title = text;
    this.app.renderStrip();
  }

  setDensity(d) {
    this.density = d;
    this.el.dataset.density = d;
    this.updatePeek();
  }

  setFileCount(n) {
    this.$(".cnt").textContent = n ? `· ${n}개 변경` : "";
  }

  onOutput() {
    if (!this.hooks && this.status !== "working") this.setStatus("working", "출력 중");
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onSilence(), this.hooks ? 1500 : 3000);
    if (!this.peekTimer) {
      this.peekTimer = setTimeout(() => {
        this.peekTimer = null;
        this.updatePeek();
        this.app.onPeek(this);
      }, 500);
    }
  }

  /** Agents without hooks: silence is our only signal that they wait for input. */
  onSilence() {
    if (this.hooks) {
      if (this.status === "starting") this.setStatus("idle", "준비됨");
    } else if (this.status === "working" || this.status === "starting") {
      this.setStatus("idle", "입력 대기 추정");
    }
  }

  onHook(event, data) {
    const s = hookStatus(event, data, this.status);
    if (s) this.setStatus(s.status, s.text);
    if (event === "stop") this.onFsChange();
  }

  onExit(code, err) {
    this.setStatus("exited", err ? "실행 실패" : "종료됨");
    this.$(".b-restart").hidden = false;
  }

  updatePeek() {
    this.peek = this.agent?.lastLines(3) ?? [];
    this.$(".peek").textContent = this.peek.join("\n") || this.statusText || "";
  }

  onFsChange() {
    clearTimeout(this.fsTimer);
    this.fsTimer = setTimeout(() => {
      this.files = null;
      this.explorer.refresh();
      if (this.$(".m-spec").open) this.loadSpec();
      this.viewer.reload();
    }, 400);
  }

  async loadSpec() {
    const s = await invoke("read_spec", { root: this.root, preferred: this.cfg.spec_file ?? null }).catch(() => null);
    this.$(".spec-name").textContent = s ? s.name : "(없음)";
    // Spec files may be written by agents: sanitize before rendering.
    this.$(".spec").innerHTML = s
      ? DOMPurify.sanitize(marked.parse(s.content))
      : `<p class="muted">MASTER_SPEC.md · CLAUDE.md · README.md 가 없습니다.</p>`;
  }

  async fileList() {
    if (!this.files) this.files = await invoke("list_files", { root: this.root }).catch(() => []);
    return this.files;
  }

  /** Type text into the CLI exactly as if the user typed it, then press Enter. */
  sendToAgent(text) {
    this.agent.write(pasteSequence(text, this.agent.term.modes.bracketedPasteMode));
    setTimeout(() => this.agent.write("\r"), 80);
  }

  toggleShell() {
    const box = this.$(".shell");
    if (!this.shell) {
      box.hidden = false;
      this.shell = new Pty(box, { cwd: this.root, command: this.app.shell });
      requestAnimationFrame(() => {
        this.shell.start();
        this.shell.term.focus();
      });
      return;
    }
    box.hidden = !box.hidden;
    if (box.hidden) this.focusDefault();
    else this.shell.term.focus();
  }

  focusDefault() {
    if (this.density === "full" && !this.viewer.isOpen) this.agent.term.focus();
    else this.composer.focus();
  }

  cycleFocus(dir) {
    const parts = [this.$(".m-files > summary"), this.agent.term.textarea, this.composer.ta].filter((el) => el && el.offsetParent);
    if (!parts.length) return;
    const i = parts.indexOf(document.activeElement);
    parts[(i + dir + parts.length) % parts.length].focus();
  }

  dispose() {
    this.agent.dispose();
    this.shell?.dispose();
    invoke("unwatch_project", { id: this.id }).catch(() => {});
    this.el.remove();
  }
}
