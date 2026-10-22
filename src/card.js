import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Pty } from "./pty.js";
import { Explorer } from "./explorer.js";
import { Viewer } from "./viewer.js";
import { Composer } from "./composer.js";
import { BADGE, MENU, ROTATE_AT, basename, handoffPrompt, hookStatus, parseProgress, pasteSequence, projectColor, seedPrompt, summarizeTurn } from "./logic.js";
import { renderSummary, summaryLines } from "./summary.js";

const TEMPLATE = `
<div class="head">
  <span class="dot"></span><span class="idx"></span><b class="name"></b><select class="agent" title="새 세션으로 이어가기 · 에이전트 바꾸기"></select>
  <span class="badge"></span><span class="stext"></span>
  <button class="b-restart" title="다시 시작" hidden>↻ 다시 시작</button>
  <button class="b-close" title="닫기 (Alt+W)">×</button>
</div>
<div class="mods">
  <details class="m-files"><summary>파일 <span class="cnt"></span> <span class="kbd">Ctrl+P</span></summary><div class="explorer"></div></details>
  <details class="m-spec"><summary>스펙 <span class="spec-name"></span></summary><div class="spec md"></div></details>
</div>
<div class="body"><div class="term"></div><div class="summary" tabindex="0" hidden></div><div class="viewer" hidden></div></div>
<div class="shell" hidden></div>
<div class="qa" hidden></div>
<pre class="peek"></pre>
<div class="composer"></div>`;

let cardSeq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One isolated project: its own agent CLI, files, spec and input (spec 3.0, 3.2). */
export class Card {
  constructor(app, cfg, adapter) {
    Object.assign(this, { app, cfg, adapter, root: cfg.path, name: basename(cfg.path) });
    this.id = `c${++cardSeq}`;
    this.color = projectColor(this.name, app.cards.map((c) => c.color));
    this.hooks = adapter?.status === "hooks";
    this.files = null;
    this.peek = [];
    this.view = "summary"; // preferred view; the raw CLI still shows when there is nothing to summarize
    this.turnTools = [];
    this.history = []; // finished turns, newest first; shortcut: memory only, lost on restart
    this.answerOpen = false;
    this.menuOpen = false;
    this.el = document.createElement("section");
    this.el.className = "card";
    this.el.style.setProperty("--pc", this.color);
    this.el.innerHTML = TEMPLATE;
    this.$ = (sel) => this.el.querySelector(sel);
    this.$(".name").textContent = this.name;
    this.$(".name").title = this.root;
    this.$(".agent").onchange = (e) => this.onAgentPick(e.target.value);
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
    this.renderAgentPick();
    this.agent = new Pty(this.$(".term"), {
      cwd: this.root,
      command: this.launchCommand(),
      onOutput: () => this.onOutput(),
      onExit: (code, err) => this.onExit(code, err),
    });
    const summary = this.$(".summary");
    summary.addEventListener("keydown", (e) => e.key === "Enter" && e.target === summary && this.toggleAnswer());
    // Keep "N분째" fresh while the agent works.
    this.clock = setInterval(() => this.status === "working" && this.updateView(), 20000);
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

  /** Crash recovery reuses the rotation path, so the new CLI is seeded with the project's context (spec 5.2). */
  restart() {
    this.$(".b-restart").hidden = true;
    this.renew();
  }

  renderAgentPick() {
    const pick = this.$(".agent");
    const others = this.app.adapters.filter((a) => a.detected && a.name !== this.adapter?.name);
    pick.textContent = "";
    pick.append(new Option(this.adapter?.name ?? (this.cfg.command ? "custom" : "shell"), ""));
    if (this.adapter) pick.append(new Option("↻ 새 세션으로 이어가기", "@renew"), ...others.map((a) => new Option(`→ ${a.name}(으)로 바꾸기`, a.name)));
    pick.disabled = !this.adapter;
  }

  onAgentPick(value) {
    this.$(".agent").value = "";
    if (!value) return;
    const next = value === "@renew" ? this.adapter : this.app.adapters.find((a) => a.name === value);
    this.rotate(next, next === this.adapter ? "사용자가 새 세션을 요청했습니다." : `에이전트를 ${next.name}(으)로 바꿉니다.`);
  }

  setIndex(i) {
    this.$(".idx").textContent = `#${i + 1}`;
  }

  setStatus(status, text) {
    Object.assign(this, { status, statusText: text });
    if (status === "idle") this.onReady?.();
    this.el.dataset.status = status;
    this.$(".badge").textContent = BADGE[status];
    this.$(".stext").textContent = text;
    this.$(".stext").title = text;
    this.composer.setBusy(status === "working" || status === "waiting");
    this.updateView();
    this.app.renderStrip();
  }

  /** In summary mode the summary always covers the CLI; only agents without hooks show the raw CLI. */
  updateView() {
    const box = this.$(".summary");
    const hasTurn = this.hooks && this.status !== "starting";
    // While the CLI boots, cover its raw startup output with a loading screen.
    const loading = this.view === "summary" && this.status === "starting";
    const show = (this.view === "summary" && hasTurn) || loading;
    const wasFocused = box.contains(document.activeElement);
    box.hidden = !show;
    if (loading) box.innerHTML = `<div class="s-loading">로딩 중…</div>`;
    else if (show) renderSummary(this, box);
    if (wasFocused && show) box.focus();
    this.updatePeek();
  }

  get summaryShown() {
    return !this.$(".summary").hidden;
  }

  toggleView() {
    this.view = this.view === "summary" ? "cli" : "summary";
    this.updateView();
    if (this.summaryShown) this.$(".summary").focus();
    else this.agent.term.focus();
  }

  toggleAnswer() {
    this.answerOpen = !this.answerOpen;
    this.updateView();
  }

  /** Claude's permission menu: Enter takes the highlighted "Yes", Esc rejects. */
  answerPermission(allow) {
    this.agent.write(allow ? "\r" : "\x1b");
    this.setStatus("working", allow ? "허용함 · 계속 진행" : "거부함");
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
        const menu = MENU.test(this.agent.lastLines(8).join("\n"));
        if (menu !== this.menuOpen) {
          this.menuOpen = menu;
          this.updateView();
        } else this.updatePeek();
        this.app.onPeek(this);
      }, 500);
    }
  }

  /** Agents without hooks: silence is our only signal that they wait for input. */
  onSilence() {
    if (this.hooks) {
      if (this.status === "starting") this.setStatus("idle", "준비됨");
    } else if (this.status === "working" || this.status === "starting") {
      const turnEnded = this.status === "working";
      this.setStatus("idle", "입력 대기 추정");
      if (turnEnded) this.afterTurn();
    }
  }

  onHook(event, data) {
    if (data?.transcript) this.transcript = data.transcript;
    if (event === "prompt") {
      this.turnSeq = (this.turnSeq ?? 0) + 1;
      this.turnTools = [];
      this.turnStart = Date.now();
      this.answerOpen = false;
      if (this.summary) this.history.unshift({ summary: this.summary, turn: this.turn });
      this.summary = this.turn = null;
    }
    if (event === "tool") {
      this.lastTool = data;
      this.turnTools.push(hookStatus("tool", data).text);
    }
    if (event === "stop") {
      this.onFsChange();
      return this.finishTurn();
    }
    const s = hookStatus(event, data, this.status);
    if (s) this.setStatus(s.status, s.text);
  }

  /**
   * Turn finished: read what the agent did from its transcript and summarize it.
   * The stop hook can fire before the final answer is flushed to the transcript, so read twice.
   */
  async finishTurn() {
    const turnAtStop = this.turnSeq;
    const progress = await this.loadProgress();
    for (const wait of [300, 1500]) {
      await new Promise((r) => setTimeout(r, wait));
      if (turnAtStop !== this.turnSeq) return; // the user already started the next turn
      const turn = this.transcript ? await invoke("read_turn", { path: this.transcript }).catch(() => null) : null;
      this.turn = turn;
      // The deck's own handoff/seed prompts are not the user's request.
      if (turn?.prompt && !turn.prompt.includes("[mygdeck]")) this.lastAsk = turn.prompt;
      this.contextTokens = turn?.context_tokens ?? null;
      this.summary = summarizeTurn(turn ?? { texts: [], tools: [] }, progress);
      this.setStatus(this.summary.state, this.summary.line);
    }
    this.afterTurn();
  }

  /**
   * Session rotation (spec 4.4), only ever between turns:
   * handoff (agent writes progress.md) → its turn ends → renew (clear or relaunch, then seed) → seed turn ends.
   */
  afterTurn() {
    if (this.pendingNote) {
      const note = this.pendingNote;
      this.pendingNote = null;
      this.sendToAgent(note);
    }
    if (this.revertModel) {
      this.revertModel = false;
      const a = this.adapter;
      if (a?.base_model) this.sendToAgent(a.model_cmd.replace("{model}", a.base_model));
    }
    if (this.rotating === "handoff") return this.renew();
    if (this.rotating === "seed") {
      this.rotating = null;
      return this.updateView();
    }
    const limit = this.adapter?.context_limit;
    if (limit && this.contextTokens >= limit * ROTATE_AT) this.rotate(this.adapter, `컨텍스트가 ${Math.round((this.contextTokens / limit) * 100)}% 찼습니다.`);
  }

  rotate(next, why) {
    if (this.rotating) return;
    this.nextAdapter = next;
    if (!this.agent.alive) return this.renew();
    this.rotating = "handoff";
    this.sendToAgent(handoffPrompt(why));
  }

  /** A new session in the same card: old scrollback stays above a seam line, then the agent is seeded from project files. */
  async renew() {
    const next = this.nextAdapter ?? this.adapter;
    this.nextAdapter = null;
    this.rotating = "seed";
    this.transcript = this.contextTokens = null;
    const t = this.agent.term;
    // Seam below everything, then scroll the whole old screen into scrollback: on Windows the CLI's clear arrives
    // as ConPTY repaints at absolute rows, which would overwrite whatever is still on screen.
    t.write("\x1b[999;1H\r\n\x1b[90m── 세션 이어짐 ──\x1b[0m" + "\r\n".repeat(t.rows - 1));
    this.agent.keepScrollback = true;
    if (next === this.adapter && next?.clear_cmd && this.agent.alive) {
      this.sendToAgent(next.clear_cmd);
      await sleep(1500);
    } else {
      this.agent.kill();
      this.setAdapter(next);
      const ready = new Promise((r) => (this.onReady = r));
      this.setStatus("starting", "새 세션 시작");
      await this.agent.start();
      await Promise.race([ready, sleep(20000)]);
      this.onReady = null;
    }
    setTimeout(() => (this.agent.keepScrollback = false), 5000);
    if (!next || !this.agent.alive) return (this.rotating = null);
    this.sendToAgent(await this.seed(this.lastAsk));
  }

  async seed(lastAsk) {
    const [spec, log, changed] = await Promise.all([
      invoke("read_spec", { root: this.root, preferred: this.cfg.spec_file ?? null }).catch(() => null),
      invoke("read_file", { root: this.root, rel: ".mygdeck/progress.md" }).catch(() => null),
      invoke("git_status", { root: this.root }).catch(() => []),
    ]);
    return seedPrompt({ mention: this.adapter.mention, spec: spec?.name, hasProgress: log != null, changed: changed.map((f) => f.path), lastAsk });
  }

  /** Switch this card's agent CLI; the next start uses it. */
  setAdapter(a) {
    if (a === this.adapter) return;
    this.adapter = a;
    this.hooks = a?.status === "hooks";
    this.agent.command = this.launchCommand();
    this.composer = new Composer(this, this.$(".composer"));
    this.renderAgentPick();
  }

  /** Big picture: the work log if there is one, else the spec's own checklist. */
  async loadProgress() {
    const log = await invoke("read_file", { root: this.root, rel: ".mygdeck/progress.md" }).catch(() => null);
    const fromLog = parseProgress(log, "progress");
    if (fromLog) return fromLog;
    const spec = await invoke("read_spec", { root: this.root, preferred: this.cfg.spec_file ?? null }).catch(() => null);
    return parseProgress(spec?.content, "spec");
  }

  /** Stop the agent's current work: the adapter's interrupt key (Esc for Claude Code). */
  interrupt() {
    if (!this.agent.alive) return;
    this.agent.write(this.adapter?.interrupt || "\x03");
    this.rotating = null;
    if (this.status === "working" || this.status === "waiting") this.setStatus("idle", "중지함");
  }

  onExit(code, err) {
    this.rotating = null;
    this.setStatus("exited", err ? "실행 실패" : "종료됨");
    this.$(".b-restart").hidden = false;
  }

  updatePeek() {
    if (!this.agent) return;
    this.peek = summaryLines(this) ?? this.agent.lastLines(3);
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

  /** Answer slot above the input: a pool answer stays out of the agent's context until the user forwards it (spec 4.2). */
  showAnswer(question, text, via) {
    const qa = this.$(".qa");
    qa.hidden = false;
    qa.innerHTML = `<div class="qa-h"><b></b><span class="muted"></span><span class="sp"></span><button class="fw">에이전트에게 전달</button><button class="x">×</button></div><div class="qa-b md"></div>`;
    qa.querySelector("b").textContent = question.length > 60 ? question.slice(0, 60) + "…" : question;
    qa.querySelector(".muted").textContent = via ? `${via} · 실시간 검색 없이 답함` : "";
    qa.querySelector(".qa-b").innerHTML = DOMPurify.sanitize(marked.parse(text));
    qa.querySelector(".x").onclick = () => (qa.hidden = true);
    qa.querySelector(".fw").onclick = (e) => {
      const note = `참고 (질문 답변): ${text.slice(0, 1500)}`;
      const busy = this.status === "working" || this.status === "waiting";
      // Mid-turn the text would land in the wrong prompt: hold it until the turn ends.
      if (busy) this.pendingNote = note;
      else this.sendToAgent(note);
      e.target.textContent = busy ? "턴 종료 후 전달됨 ✓" : "전달함 ✓";
    };
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
    // With the summary on top, keystrokes must not go to a hidden CLI.
    if (this.density === "full" && !this.viewer.isOpen && !this.summaryShown) this.agent.term.focus();
    else this.composer.focus();
  }

  cycleFocus(dir) {
    const parts = [this.$(".m-files > summary"), this.agent.term.textarea, this.composer.ta].filter((el) => el && el.offsetParent);
    if (!parts.length) return;
    const i = parts.indexOf(document.activeElement);
    parts[(i + dir + parts.length) % parts.length].focus();
  }

  dispose() {
    clearInterval(this.clock);
    this.agent.dispose();
    this.shell?.dispose();
    invoke("unwatch_project", { id: this.id }).catch(() => {});
    this.el.remove();
  }
}
