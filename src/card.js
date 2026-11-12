import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Pty } from "./pty.js";
import { Explorer } from "./explorer.js";
import { Viewer } from "./viewer.js";
import { Composer } from "./composer.js";
import { ICONS, icon, statusIcon } from "./icons.js";
import { MENU, keyLabel, ROTATE_AT, menuChoices, menuQuestion, basename, handoffPrompt, hookStatus, isAgentNotice, pasteSequence, projectColor, promptWaiting, seedPrompt } from "./logic.js";
import { elapsed, renderSummary, summaryLines } from "./summary.js";

const TEMPLATE = `
<div class="head">
  <span class="dot"></span><span class="idx"></span><b class="name"></b><select class="agent" title="새 세션으로 이어가기 · 에이전트 바꾸기"></select>
  <span class="badge"></span><span class="stext"></span><button class="diff" title="마지막 커밋 이후 바뀐 줄 · 클릭하면 변경 파일 보기" hidden></button><span class="ctx" title="컨텍스트 사용량"></span>
  <button class="b-restart" title="다시 시작" hidden>${icon(ICONS.RotateCw)}<span class="lbl">다시 시작</span></button>
  <button class="b-cli" title="CLI 화면 보기" hidden></button>
  <button class="b-shell" title="터미널 열기/닫기">${icon(ICONS.PanelBottom)}<span class="lbl">터미널</span></button>
</div>
<div class="mods">
  <details class="m-files"><summary>${icon(ICONS.FolderTree)}파일 <span class="cnt"></span> <span class="kbd">${keyLabel("Ctrl+P")}</span></summary><div class="explorer"></div></details>
  <details class="m-spec"><summary>${icon(ICONS.FileText)}스펙 <span class="spec-name"></span> <span class="kbd">${keyLabel("Ctrl+;")}</span></summary><div class="spec md"></div></details>
</div>
<div class="body"><div class="term"></div><div class="summary" tabindex="0" hidden></div><div class="viewer" hidden></div></div>
<div class="shell" hidden><div class="shell-grip" title="드래그로 높이 조절"></div></div>
<div class="qa" hidden></div>
<pre class="peek"></pre>
<div class="composer"></div>
<div class="ring" aria-hidden="true"></div>`;

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
    this.view = "gui"; // preferred view; agents without hooks always show the raw CLI
    this.turnTools = [];
    this.live = null; // the running turn read from the transcript: what the CLI shows, in order
    this.openTools = new Set(); // tool runs the user unfolded in the GUI view (it is rebuilt often)
    this.history = []; // finished turns { ask, texts }, shown above the current one in the GUI view
    this.menuOpen = false;
    this.menuChoices = [];
    this.queue = []; // inputs typed while the agent works, sent one per finished turn
    this.el = document.createElement("section");
    this.el.className = "card";
    this.el.style.setProperty("--pc", this.color);
    this.el.innerHTML = TEMPLATE;
    this.$ = (sel) => this.el.querySelector(sel);
    this.$(".name").textContent = this.name;
    this.$(".name").title = this.root;
    this.pick = this.$(".agent");
    this.pick.onchange = (e) => this.onAgentPick(e.target.value);
    this.$(".b-restart").onclick = () => this.restart();
    this.$(".b-shell").onclick = () => this.toggleShell();
    const grip = this.$(".shell-grip");
    grip.onpointerdown = (e) => {
      grip.setPointerCapture(e.pointerId);
      const box = this.$(".shell"), bottom = box.getBoundingClientRect().bottom;
      grip.onpointermove = (m) => { box.style.height = `${Math.max(60, bottom - m.clientY)}px`; };
      grip.onpointerup = () => { grip.onpointermove = grip.onpointerup = null; };
    };
    this.$(".b-cli").onclick = () => this.toggleView();
    this.$(".diff").onclick = () => this.showChanges();
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
      key: `${this.root}#agent`,
      cwd: this.root,
      command: this.launchCommand(),
      onOutput: () => this.onOutput(),
      onExit: (code, err) => this.onExit(code, err),
    });
    // Keep the elapsed time ("1분 12초") ticking while the agent works, without rebuilding the view.
    this.clock = setInterval(() => {
      const t = this.status === "working" && this.turnStart && this.el.querySelector(".s-elapsed");
      if (t) t.textContent = elapsed(this.turnStart);
    }, 1000);
    this.setDensity("full");
    this.setStatus("starting", "시작 중");
  }

  launchCommand(resume = false) {
    if (this.cfg.command) return this.cfg.command;
    if (!this.adapter) return this.app.shell;
    return [this.adapter.launch, this.adapter.hook_args, resume && this.adapter.resume_args].filter(Boolean).join(" ");
  }

  /**
   * Take over the agent still running in the session daemon; otherwise launch it. `resume` (deck
   * restored after the daemon was gone, e.g. a reboot) reopens the project's last conversation.
   */
  async start({ resume = false } = {}) {
    invoke("watch_project", { id: this.id, root: this.root }).catch(() => {});
    this.explorer.refresh();
    const live = this.app.takeLive(this.agent.key);
    if (live && (await this.agent.attach(live.id))) return this.reattached(live);
    this.resuming = resume && !!this.adapter?.resume_args && this.cfg.resume !== false;
    this.agent.command = this.launchCommand(this.resuming);
    this.startedAt = Date.now();
    await this.agent.start();
    this.agent.command = this.launchCommand(); // later restarts (rotation, crash) start fresh
  }

  /** The daemon kept the agent running while the window was away: pick up its last known state. */
  async reattached(s) {
    if (s.transcript) this.transcript = s.transcript;
    if (s.tool?.tool) this.lastTool = s.tool;
    const status = ["working", "waiting", "done"].includes(s.status) ? s.status : "idle";
    this.setStatus(status, (status === "working" || status === "waiting") && s.text ? s.text : "다시 연결됨");
    if (status === "working") this.turnStart = null;
    if (status === "working" || status === "waiting") this.peekTurn();
    if (this.transcript && (status === "done" || status === "idle")) {
      const turn = await invoke("read_turn", { path: this.transcript }).catch(() => null);
      if (turn) {
        this.turn = turn;
        this.contextTokens = turn.context_tokens ?? null;
        if (turn.prompt && !turn.prompt.includes("[mygdeck]")) this.lastAsk = this.turnAsk = turn.prompt.replace(/\s+/g, " ").trim();
        this.updateView();
      }
    }
  }

  /** Crash recovery reuses the rotation path, so the new CLI is seeded with the project's context (spec 5.2). */
  restart() {
    this.$(".b-restart").hidden = true;
    this.renew();
  }

  renderAgentPick() {
    const pick = this.pick;
    // Composer rebuilds its row on agent switch, so re-attach the picker to its bottom-left each time.
    this.$(".composer").prepend(pick);
    const others = this.app.adapters.filter((a) => a.detected && a.name !== this.adapter?.name);
    pick.textContent = "";
    pick.append(new Option(this.adapter?.name ?? (this.cfg.command ? "custom" : "shell"), ""));
    if (this.adapter) pick.append(new Option("↻ 새 세션으로 이어가기", "@renew"), ...others.map((a) => new Option(`→ ${a.name}(으)로 바꾸기`, a.name)));
    if (this.adapter) pick.append(new Option("⑂ worktree로 하나 더 열기", "@worktree"));
    // Cards opened by "⑂": bring the work home or throw the copy away (git checks it really is one).
    if (/-wt\d+$/.test(this.root)) pick.append(new Option("⇢ 원래 폴더에 합치기", "@wt-merge"), new Option("✕ 이 worktree 버리기", "@wt-remove"));
    pick.disabled = !this.adapter;
  }

  onAgentPick(value) {
    this.pick.value = "";
    if (!value) return;
    if (value === "@worktree") return this.openWorktree();
    if (value === "@wt-merge") return this.mergeWorktree();
    if (value === "@wt-remove") return this.removeWorktree();
    const next = value === "@renew" ? this.adapter : this.app.adapters.find((a) => a.name === value);
    this.rotate(next, next === this.adapter ? "사용자가 새 세션을 요청했습니다." : `에이전트를 ${next.name}(으)로 바꿉니다.`);
  }

  setIndex(i) {
    this.$(".idx").textContent = `#${i + 1}`;
  }

  setStatus(status, text) {
    const prev = this.status;
    Object.assign(this, { status, statusText: text });
    if (status === "idle") this.onReady?.();
    this.el.dataset.status = status;
    // Idle/done need no header badge or text; the GUI view already says so.
    const shown = status === "idle" || status === "done" ? "" : text;
    const badge = this.$(".badge");
    badge.innerHTML = statusIcon(status);
    // Only a real change pops the icon in; repeats of the same status rebuild it quietly.
    badge.classList.toggle("pop", prev !== status);
    if (status === "done" && prev === "working") {
      this.el.classList.remove("flash");
      void this.el.offsetWidth; // restart the sweep
      this.el.classList.add("flash");
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => this.el.classList.remove("flash"), 1200);
    }
    this.$(".stext").textContent = shown;
    this.$(".stext").title = shown;
    this.composer.setBusy(status === "working" || status === "waiting");
    this.updateView();
    this.app.renderStrip();
    if (prev !== status) this.app.onStatus?.(this, prev);
  }

  /** In GUI mode the GUI view covers the CLI; only agents without hooks show the raw CLI. */
  updateView() {
    const box = this.$(".summary");
    // While the CLI boots, cover its raw startup output with a loading screen.
    const loading = this.view === "gui" && this.status === "starting";
    const show = this.view === "gui" && this.hooks;
    const wasFocused = box.contains(document.activeElement);
    box.hidden = !show;
    this.agent?.setCovered(show);
    const limit = this.adapter?.context_limit;
    this.$(".ctx").textContent = limit && this.contextTokens ? `${Math.round((this.contextTokens / limit) * 100)}%` : "";
    // One header button toggles both ways; only hook agents have a GUI view.
    const btn = this.$(".b-cli");
    btn.hidden = !this.hooks;
    btn.innerHTML = this.view === "cli" ? `${icon(ICONS.LayoutList)}<span class="lbl">GUI 보기</span>` : `${icon(ICONS.SquareTerminal)}<span class="lbl">CLI 보기</span>`;
    btn.title = this.view === "cli" ? "GUI 화면으로 돌아가기" : "CLI 화면 보기";
    if (loading) box.innerHTML = `<div class="s-loading">로딩 중…</div>`;
    else if (show) renderSummary(this, box);
    if (wasFocused && show) box.focus();
    this.updatePeek();
  }

  get guiShown() {
    return !this.$(".summary").hidden;
  }

  toggleView() {
    this.view = this.view === "gui" ? "cli" : "gui";
    this.updateView();
    if (this.guiShown) this.$(".summary").focus();
    else this.agent.term.focus();
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
    this.refreshDiff(n);
  }

  /** Header badge "+12 −3": lines changed since the last commit (B5). */
  async refreshDiff(changedFiles) {
    const d = changedFiles ? await invoke("git_shortstat", { root: this.root }).catch(() => null) : null;
    const b = this.$(".diff");
    b.hidden = !d || !(d.added || d.removed);
    if (!b.hidden) b.textContent = `+${d.added} −${d.removed}`;
  }

  /** Open the file panel on the changed files. */
  showChanges() {
    if (this.density !== "full") {
      this.setDensity("full");
      this.app.layout();
    }
    this.$(".m-files").open = true;
    this.explorer.setMode("changed");
  }

  /** Ctrl+I: code selected in the viewer as `@file Lx-y`, else text selected in a terminal (A5). */
  insertSelection() {
    if (this.viewer.isOpen && this.viewer.selectionRange()) return this.viewer.insertSelection();
    const term = [this.shell?.term, this.agent.term].find((t) => t?.hasSelection());
    if (!term) return this.viewer.insertSelection();
    const text = term.getSelection().replace(/[ \t]+$/gm, "").trim();
    if (text) this.composer.insert("\n```\n" + text + "\n```\n");
  }

  /** A second copy of this project in a git worktree, as its own card with its own agent (B4). */
  async openWorktree() {
    try {
      const path = await invoke("git_worktree_add", { root: this.root });
      this.app.addCard({ path, agent: this.adapter?.name });
    } catch (e) {
      message(`worktree를 만들지 못했습니다: ${e}`, { kind: "error" });
    }
  }

  /** Merge this worktree's commits into the main folder's branch. Conflicts are refused, not left half-done. */
  async mergeWorktree() {
    try {
      await invoke("git_worktree_merge", { root: this.root });
      message("원래 폴더에 합쳤습니다. 이 worktree는 이제 버려도 됩니다.", { kind: "info" });
    } catch (e) {
      message(`합치지 못했습니다: ${e}`, { kind: "error" });
    }
  }

  /** Close the card (its agent holds the folder open), then remove the worktree. */
  async removeWorktree() {
    const ok = await ask(`${this.name}: 카드를 닫고 이 worktree 폴더를 지웁니다. 커밋하지 않은 변경이 있으면 지우지 않습니다.`, { title: "worktree 버리기", kind: "warning", okLabel: "버리기", cancelLabel: "취소" });
    if (!ok) return;
    await this.app.closeCard(this);
    if (this.app.cards.includes(this)) return; // the user kept a busy card open
    let err;
    // Windows keeps the folder locked until the agent process has fully exited.
    for (let i = 0; i < 6; i++) {
      try {
        const branchGone = await invoke("git_worktree_remove", { root: this.root });
        if (!branchGone) message("폴더는 지웠습니다. 합치지 않은 저장점이 있어 브랜치는 남겨 두었습니다.", { kind: "info" });
        return;
      } catch (e) {
        err = e;
        await sleep(500);
      }
    }
    message(`${err}`, { kind: "error" });
  }

  onOutput() {
    // The CLI redraws right after reporting a turn end; that is not new work.
    const settling = this.status === "done" && Date.now() - (this.doneAt ?? 0) < 2000;
    // A redrawn approval prompt is still waiting; the peek check below decides when it is gone.
    if (!this.hooks && this.status !== "working" && this.status !== "waiting" && !settling) this.setStatus("working", "출력 중");
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onSilence(), this.hooks ? 1500 : 3000);
    if (!this.peekTimer) {
      this.peekTimer = setTimeout(() => {
        this.peekTimer = null;
        const lines = this.agent.lastLines(20, true);
        const menu = MENU.test(lines.filter(Boolean).slice(-8).join("\n"));
        const choices = menu ? menuChoices(lines) : [];
        const question = menuQuestion(lines, choices);
        this.prompting = !this.hooks && promptWaiting(lines, this.adapter?.waiting);
        // The CLI's own next-prompt suggestion, mirrored as ghost text in the composer (→ accepts it).
        this.composer.setGhost(this.hooks && !menu && (this.status === "done" || this.status === "idle") ? this.agent.inputGhost() : null);
        if (!this.hooks && this.status === "waiting" && !this.prompting) this.setStatus("working", "출력 중");
        if (menu !== this.menuOpen || question !== this.menuQuestion || JSON.stringify(choices) !== JSON.stringify(this.menuChoices)) {
          this.menuOpen = menu;
          this.menuChoices = choices;
          this.menuQuestion = question;
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
      // Output stopped on an approval prompt: the agent waits for the user, the turn is not over.
      if (this.prompting) return this.setStatus("waiting", this.menuQuestion?.split("\n")[0] || "승인 대기");
      // With exact turn ends, silence only means "maybe waiting" (e.g. an approval prompt).
      const turnEnded = this.status === "working" && !this.exactStop;
      this.setStatus("idle", "입력 대기 추정");
      if (turnEnded) this.afterTurn();
    }
  }

  onHook(event, data) {
    // Agents without full hooks may still report turn ends (Codex `notify`): "done" is then exact.
    if (!this.hooks) {
      if (event !== "stop") return;
      this.exactStop = true;
      this.doneAt = Date.now();
      clearTimeout(this.idleTimer);
      this.setStatus("done", "완료");
      this.onFsChange();
      return this.afterTurn();
    }
    if (data?.transcript) this.transcript = data.transcript;
    if (event === "prompt") {
      // Subagent reports and task notices reach the agent as prompts: it keeps working on the same request.
      const notice = isAgentNotice(data?.prompt);
      if (!notice && (this.turnAsk || this.turn?.texts?.length)) this.history = [...this.history, { ask: this.turnAsk, texts: this.turn?.texts ?? [] }].slice(-50);
      this.turnSeq = (this.turnSeq ?? 0) + 1;
      this.turnTools = [];
      this.turnStart = Date.now();
      if (!notice) {
        this.live = null;
        this.openTools.clear();
        // The deck's own handoff/seed prompts are not the user's request.
        this.turnAsk = data?.prompt && !data.prompt.includes("[mygdeck]") ? data.prompt.replace(/\s+/g, " ").trim() : null;
        this.turn = null;
      }
    }
    if (event === "tool") {
      this.lastTool = data;
      this.turnTools.push(hookStatus("tool", data).text);
      this.peekTurn();
    }
    if (event === "stop") {
      this.onFsChange();
      return this.finishTurn();
    }
    const s = hookStatus(event, data, this.status);
    if (s) this.setStatus(s.status, s.text);
  }

  /**
   * Turn finished: read the agent's answer, the last request and context size from the transcript.
   * The stop hook can fire before the transcript is flushed, so read twice.
   */
  /** Read the running turn so the GUI shows what the CLI shows (texts, tools, failures, to-dos). One read per burst of hooks. */
  peekTurn() {
    if (!this.transcript || this.peekTimer) return;
    this.peekTimer = setTimeout(async () => {
      this.peekTimer = null;
      const seq = this.turnSeq;
      const turn = await invoke("read_turn", { path: this.transcript }).catch(() => null);
      if (!turn || seq !== this.turnSeq || !["working", "waiting"].includes(this.status)) return;
      this.live = turn;
      this.contextTokens = turn.context_tokens ?? this.contextTokens;
      this.updateView();
    }, 400);
  }

  async finishTurn() {
    const turnAtStop = this.turnSeq;
    this.setStatus("done", "완료");
    for (const wait of [300, 1500]) {
      await new Promise((r) => setTimeout(r, wait));
      if (turnAtStop !== this.turnSeq) return; // the user already started the next turn
      const turn = this.transcript ? await invoke("read_turn", { path: this.transcript }).catch(() => null) : null;
      this.turn = turn;
      // The deck's own handoff/seed prompts are not the user's request.
      if (turn?.prompt && !turn.prompt.includes("[mygdeck]")) this.lastAsk = turn.prompt;
      this.contextTokens = turn?.context_tokens ?? null;
      this.updateView();
    }
    this.afterTurn();
  }

  /**
   * Session rotation (spec 4.4), only ever between turns:
   * handoff (agent writes progress.md) → its turn ends → renew (clear or relaunch, then seed) → seed turn ends.
   */
  afterTurn() {
    const note = this.pendingNote;
    if (note) {
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
      this.updateView();
    } else {
      const limit = this.adapter?.context_limit;
      if (limit && this.contextTokens >= limit * ROTATE_AT) this.rotate(this.adapter, `컨텍스트가 ${Math.round((this.contextTokens / limit) * 100)}% 찼습니다.`);
    }
    // A forwarded note takes this turn; the queue goes on when that one ends.
    if (!note && !this.rotating) this.sendQueued();
  }

  /** Queueing needs an exact turn end; a silence guess could fire mid-work. */
  get canQueue() {
    return this.hooks || !!this.exactStop;
  }

  sendQueued() {
    const next = this.queue.shift();
    if (!next) return;
    this.composer.renderQueue();
    // Let the CLI take a model switch-back typed just before.
    setTimeout(() => this.composer.dispatchQueued(next), 600);
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

  clearQueue() {
    this.queue.length = 0;
    this.composer.renderQueue();
  }

  /** Stop the agent's current work: the adapter's interrupt key (Esc for Claude Code).
   *  restore: put the stopped prompt back in the input box so it can be edited and sent again. */
  interrupt(restore = true) {
    if (!this.agent.alive) return;
    this.agent.write(this.adapter?.interrupt || "\x03");
    this.rotating = null;
    this.clearQueue(); // stopping means "not this plan any more"
    if (this.status === "working" || this.status === "waiting") {
      this.setStatus("idle", "중지함");
      if (restore) this.composer.restore();
    }
  }

  onExit(code, err) {
    // Nothing to resume in this folder yet: the CLI quits at once, so start a new conversation.
    if (this.resuming && !err && Date.now() - this.startedAt < 15000) {
      this.resuming = false;
      this.agent.term.write("\x1b[90m이어갈 대화가 없어 새로 시작합니다.\x1b[0m\r\n");
      this.setStatus("starting", "시작 중");
      this.startedAt = Date.now();
      return this.agent.start();
    }
    this.resuming = false;
    this.rotating = null;
    this.clearQueue();
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

  toggleSpec() {
    const spec = this.$(".m-spec");
    spec.open = !spec.open;
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
  showAnswer(question, text, via, found = {}) {
    const qa = this.$(".qa");
    qa.hidden = false;
    qa.innerHTML = `<div class="qa-h"><b></b><span class="muted"></span><span class="sp"></span><button class="fw">에이전트에게 전달</button><button class="x" aria-label="닫기">${icon(ICONS.X)}</button></div><div class="qa-b md"></div>`;
    qa.querySelector("b").textContent = question.length > 60 ? question.slice(0, 60) + "…" : question;
    const n = found.sources?.length ?? 0;
    qa.querySelector(".muted").textContent = via ? `${via} · ${found.searched ? `웹 검색 ${n}건 기반` : "실시간 검색 없이 답함"}` : "";
    const body = qa.querySelector(".qa-b");
    body.innerHTML = DOMPurify.sanitize(marked.parse(text));
    // Sources open in the system browser; a link inside the webview would replace the whole app.
    if (n) {
      const ol = document.createElement("ol");
      ol.className = "qa-src";
      for (const s of found.sources) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.textContent = s.title;
        a.title = s.url;
        a.href = "#";
        a.onclick = (e) => {
          e.preventDefault();
          openUrl(s.url);
        };
        li.append(a);
        ol.append(li);
      }
      body.append(ol);
    }
    body.addEventListener("click", (e) => e.target.closest("a") && e.preventDefault());
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
      this.shell = new Pty(box, { key: `${this.root}#shell`, cwd: this.root, command: this.app.shell, scrollback: 2000 });
      requestAnimationFrame(async () => {
        const live = this.app.takeLive(this.shell.key);
        if (!(live && (await this.shell.attach(live.id)))) this.shell.start();
        this.shell.term.focus();
      });
      return;
    }
    box.hidden = !box.hidden;
    if (box.hidden) this.focusDefault();
    else this.shell.term.focus();
  }

  focusDefault() {
    // With the GUI view on top, keystrokes must not go to a hidden CLI.
    if (this.density === "full" && !this.viewer.isOpen && !this.guiShown) this.agent.term.focus();
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
