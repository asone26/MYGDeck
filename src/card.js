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
import { L } from "./i18n.js";
import { MENU, keyLabel, ROTATE_AT, contextLimit, detectLocalhostUrl, menuChoices, menuQuestion, basename, handoffPrompt, hookStatus, isAgentNotice, pasteSequence, pickErrorLines, projectColor, promptWaiting, seedPrompt } from "./logic.js";
import { elapsed, renderSummary, summaryLines } from "./summary.js";
import { renderAgentPick, openAgentMenu, closeAgentMenu, onAgentPick, openWorktree, mergeWorktree, removeWorktree } from "./agent_menu.js";

const TEMPLATE = () => `
<div class="head">
  <span class="dot"></span><span class="idx"></span><b class="name"></b><button type="button" class="agent" title="${L("새 세션으로 이어가기 · 에이전트 바꾸기", "Handoff session · Switch agent")}" aria-haspopup="menu" aria-expanded="false"></button>
  <span class="badge"></span><span class="stext"></span><span class="b-conflict" hidden></span><button class="b-branch" title="${L("현재 브랜치", "Current branch")}" hidden></button><button class="diff" title="${L("마지막 커밋 이후 바뀐 줄 · 클릭하면 바뀐 내용 보기", "Lines changed since last commit · Click to review")}" hidden></button><button class="b-preview" title="${L("감지된 로컬 서버 열기", "Open detected local server")}" hidden></button><button class="b-run" title="${L("실행 또는 검증 명령 돌리기", "Run or verify project")}">${icon(ICONS.Play)}<span class="lbl">${L("실행", "Run")}</span></button><button class="b-test" title="${L("턴 종료 후 검증 결과", "Post-turn verification")}" hidden></button><button class="ctx" title="${L("컨텍스트 사용량 · 클릭하면 새 대화로 핸드오프", "Context usage · Click to handoff")}"></button>
  <button class="b-perm" title="${L("권한 승인 모드 전환 (확인 / 자동허용)", "Toggle permission mode (Confirm / Auto)")}"></button>
  <button class="b-pin" title="${L("카드 맨 앞에 고정", "Pin card to front")}">${icon(ICONS.Pin)}</button>
  <button class="b-mute" title="${L("알림 끄기/켜기", "Mute/unmute notifications")}"></button>
  <button class="b-restart" title="${L("다시 시작", "Restart")}" hidden>${icon(ICONS.RotateCw)}<span class="lbl">${L("다시 시작", "Restart")}</span></button>
  <button class="b-cli" title="${L("CLI 화면 보기", "View raw CLI")}" hidden></button>
  <button class="b-shell" title="${L("터미널 열기/닫기", "Toggle shell")}">${icon(ICONS.PanelBottom)}<span class="lbl">${L("터미널", "Shell")}</span></button>
</div>
<div class="conn-banner" hidden><span>${L("세션 연결이 끊어졌습니다.", "Session disconnected.")}</span><button type="button" class="conn-retry">${L("다시 연결", "Reconnect")}</button></div>
<div class="mods">
  <details class="m-files"><summary>${icon(ICONS.FolderTree)}${L("파일", "Files")} <span class="cnt"></span> <span class="kbd">${keyLabel("Ctrl+P")}</span></summary><div class="explorer"></div></details>
  <details class="m-spec"><summary>${icon(ICONS.FileText)}${L("스펙", "Spec")} <span class="spec-name"></span> <span class="kbd">${keyLabel("Ctrl+;")}</span></summary><div class="spec md"></div></details>
  <details class="m-note"><summary>${L("메모", "Notes")}</summary><textarea class="note-ta" rows="4" placeholder="${L("이 프로젝트 로컬 메모 (에이전트에게 전달되지 않음)…", "Local project notes (never sent to the agent)…")}"></textarea></details>
</div>
<div class="body"><div class="term"></div><div class="summary" tabindex="0" hidden></div><div class="viewer" hidden></div></div>
<div class="shell" hidden><div class="shell-grip" title="${L("드래그로 높이 조절", "Drag to resize")}"></div><div class="shell-bar"><button class="shell-fix" title="${L("오류 출력만 추려서 에이전트에게 수정 요청", "Extract error lines and ask agent to fix")}">${L("오류 고치기", "Fix error")}</button><button class="shell-send" title="${L("최근 터미널 출력을 에이전트 입력창으로 보내기", "Send recent shell output to composer")}">${L("최근 출력 보내기", "Send output")}</button><button class="shell-clear" title="${L("터미널 화면 지우기", "Clear terminal")}">${L("지우기", "Clear")}</button><button class="shell-new" title="${L("현재 터미널을 종료하고 새 셸로 다시 열기", "Restart shell")}">${L("새로 열기", "New shell")}</button><span class="shell-scripts"></span></div></div>
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
    this.userModel = !!cfg.model;
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
    this.stats = { turns: 0, totalMs: 0 };
    this.el = document.createElement("section");
    this.el.className = "card";
    this.el.style.setProperty("--pc", this.color);
    this.el.innerHTML = TEMPLATE();
    this.$ = (sel) => this.el.querySelector(sel);
    this.$(".name").textContent = this.name;
    this.$(".name").title = this.root;
    this.pick = this.$(".agent");
    this.pick.onclick = () => this.toggleAgentMenu();
    this.$(".b-restart").onclick = () => this.restart();
    this.$(".b-shell").onclick = () => this.toggleShell();
    this.$(".b-preview").onclick = () => this.previewUrl && openUrl(this.previewUrl);
    this.$(".b-branch").onclick = () => this.prUrl && openUrl(this.prUrl);
    this.$(".b-run").onclick = () => this.quickRun();
    this.$(".b-test").onclick = () => this.onTestBadgeClick();
    this.$(".ctx").onclick = () => this.manualHandoff();
    this.muteBtn = this.$(".b-mute");
    this.muteBtn.onclick = () => {
      this.cfg.muted = !this.cfg.muted || undefined;
      this.syncMute();
      this.app.save();
    };
    this.syncMute();
    this.pinBtn = this.$(".b-pin");
    this.pinBtn.onclick = () => this.togglePin();
    this.syncPin();
    this.$(".conn-retry").onclick = () => this.restart();
    this.permBtn = this.$(".b-perm");
    this.autoApprove = !!cfg.auto_approve;
    this.permBtn.onclick = () => this.toggleAutoApprove();
    this.syncPerm();
    this.$(".shell-fix").onclick = () => this.fixShellError();
    this.$(".shell-send").onclick = () => this.sendShellOutput();
    this.$(".shell-clear").onclick = () => this.shell?.clear();
    this.$(".shell-new").onclick = () => this.restartShell();
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
    const noteTa = this.$(".note-ta");
    noteTa.value = cfg.note ?? "";
    let noteTimer = null;
    noteTa.oninput = () => {
      this.cfg.note = noteTa.value || undefined;
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => this.app.save(), 350);
    };

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
      onFileLink: (rel, line) => this.viewer.open(rel, "code", line),
    });
    // Keep the elapsed time ("1분 12초") ticking while the agent works, without rebuilding the view.
    this.clock = setInterval(() => {
      const t = this.status === "working" && this.turnStart && this.el.querySelector(".s-elapsed");
      if (t) t.textContent = elapsed(this.turnStart);
    }, 1000);
    this.setDensity("full");
    this.setStatus("starting", L("시작 중", "Starting"));
  }

  launchCommand(resume = false) {
    if (this.cfg.command) return this.cfg.command;
    if (!this.adapter) return this.app.shell;
    let launch = this.adapter.launch;
    if (this.cfg.model && /--model \S+/.test(launch)) launch = launch.replace(/--model \S+/, `--model ${this.cfg.model}`);
    if (this.cfg.effort && /--effort \S+/.test(launch)) launch = launch.replace(/--effort \S+/, `--effort ${this.cfg.effort}`);
    return [launch, this.adapter.hook_args, resume && this.adapter.resume_args].filter(Boolean).join(" ");
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
    // A hooks agent that never sent a hook has not started a turn: recent output (a repaint) is not work.
    const unhooked = this.hooks && !s.hooked;
    const status = !unhooked && ["working", "waiting", "done"].includes(s.status) ? s.status : "idle";
    // Launched to reopen the last conversation by a window that closed before the CLI answered: the CLI
    // may only now find there is none and quit, so the fresh-start fallback in onExit still applies.
    const resumeArgs = this.adapter?.resume_args;
    if (resumeArgs && !s.transcript && s.command?.trimEnd().endsWith(resumeArgs)) {
      this.resuming = true;
      this.startedAt = Date.now();
    }
    this.setStatus(status, (status === "working" || status === "waiting") && s.text ? s.text : "다시 연결됨");
    if (status === "working") this.turnStart = null;
    if (status === "working" || status === "waiting") this.peekTurn();
    if (this.transcript && (status === "done" || status === "idle")) {
      const turn = await invoke("read_turn", { path: this.transcript }).catch(() => null);
      if (turn) {
        this.turn = turn;
        this.contextTokens = turn.context_tokens ?? null;
        this.contextModel = turn.model || this.contextModel;
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

  renderAgentPick() { renderAgentPick(this); }
  toggleAgentMenu() { if (this.agentPop) closeAgentMenu(this); else openAgentMenu(this); }
  openAgentMenu() { openAgentMenu(this); }
  closeAgentMenu() { closeAgentMenu(this); }
  onAgentPick(value) { onAgentPick(this, value); }

  setIndex(i) {
    this.$(".idx").textContent = `#${i + 1}`;
  }

  syncMute() {
    const muted = !!this.cfg.muted;
    this.muteBtn.innerHTML = icon(muted ? ICONS.BellOff : ICONS.Bell);
    this.muteBtn.classList.toggle("muted", muted);
    this.muteBtn.title = muted ? "알림 꺼짐 · 클릭하면 다시 켜기" : "이 카드 알림 끄기";
  }

  syncPin() {
    const pinned = !!this.cfg.pinned;
    this.pinBtn?.classList.toggle("on", pinned);
    this.el.classList.toggle("pinned", pinned);
    if (this.pinBtn) this.pinBtn.title = pinned ? "고정 해제" : "카드 맨 앞에 고정";
  }

  togglePin() {
    this.cfg.pinned = !this.cfg.pinned || undefined;
    this.syncPin();
    this.app.onPinChange?.(this);
  }

  setStatus(status, text) {
    const prev = this.status;
    Object.assign(this, { status, statusText: text });
    if (status === "idle") this.onReady?.();
    this.el.dataset.status = status;
    const banner = this.$(".conn-banner");
    if (banner) banner.hidden = status !== "exited";
    // Idle/done need no header badge or text; the GUI view already says so.
    const shown = status === "idle" || status === "done" ? "" : text;
    const badge = this.$(".badge");
    badge.innerHTML = statusIcon(status);
    // Only a real change pops the icon in; repeats of the same status rebuild it quietly.
    badge.classList.toggle("pop", prev !== status);
    if (status === "done" && prev === "working") {
      this.lastTurnElapsed = this.turnStart ? elapsed(this.turnStart) : null;
      if (this.turnStart) {
        this.stats.turns += 1;
        this.stats.totalMs += Math.max(0, Date.now() - this.turnStart);
        const sec = Math.round(this.stats.totalMs / 1000);
        const m = Math.floor(sec / 60), s = sec % 60;
        const tot = m ? (s ? `${m}분 ${s}초` : `${m}분`) : `${s}초`;
        this.$(".name").title = `${this.root}\n이번 세션: ${this.stats.turns}턴 · 누적 ${tot}`;
      }
      this.el.classList.remove("flash");
      void this.el.offsetWidth; // restart the sweep
      this.el.classList.add("flash");
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => this.el.classList.remove("flash"), 1200);
    }
    const doneShown = status === "done" && this.lastTurnElapsed ? `완료 · ${this.lastTurnElapsed}` : shown;
    this.$(".stext").textContent = doneShown;
    this.$(".stext").title = doneShown;
    this.composer.setBusy(status === "working" || status === "waiting");
    this.updateView();
    this.app.renderStrip();
    if (prev !== status) this.app.onStatus?.(this, prev);
    if (this.autoApprove && status === "waiting") this.maybeAutoApprove(text);
  }

  syncPerm() {
    if (!this.permBtn) return;
    this.permBtn.classList.toggle("auto", this.autoApprove);
    this.permBtn.textContent = this.autoApprove ? L("자동허용", "Auto") : L("확인", "Confirm");
    this.permBtn.title = this.autoApprove
      ? L("권한 요청을 자동으로 허용합니다 · 클릭하면 수동 확인으로 전환", "Auto-approving permissions · Click for manual confirmation")
      : L("권한 요청마다 확인합니다 · 클릭하면 자동허용으로 전환", "Confirming permissions manually · Click for auto-approve");
  }

  toggleAutoApprove() {
    this.cfg.auto_approve = !this.cfg.auto_approve || undefined;
    this.autoApprove = !!this.cfg.auto_approve;
    this.syncPerm();
    this.app.save();
  }

  maybeAutoApprove(text) {
    const isPerm = /사용 허용|permission|approve|허용|승인/i.test(text || "")
      || (this.menuOpen && (this.menuChoices ?? []).some((c) => /yes|allow|허용|don't ask/i.test(c.label)));
    if (!isPerm) return;
    const now = Date.now();
    if (this.lastAutoAt && now - this.lastAutoAt < 1500) return;
    this.lastAutoAt = now;
    setTimeout(() => {
      if (this.autoApprove && this.status === "waiting") this.answerPermission(true);
    }, 250);
  }

  setConflicts(list) {
    this.conflicts = new Map((list ?? []).map((c) => [c.file, c.others]));
    const b = this.$(".b-conflict");
    if (b) {
      b.hidden = !this.conflicts.size;
      if (this.conflicts.size) {
        b.textContent = L(`충돌 주의 ${this.conflicts.size}`, `Overlap ${this.conflicts.size}`);
        b.title = [...this.conflicts.entries()]
          .slice(0, 6)
          .map(([f, others]) => `${f} (${others.join(", ")})`)
          .join("\n");
      }
    }
    this.explorer?.render?.();
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
    const limit = contextLimit(this.adapter, this.contextModel);
    const ctxBtn = this.$(".ctx");
    if (limit && this.contextTokens) {
      const pct = Math.min(100, Math.round((this.contextTokens / limit) * 100));
      const rotPct = Math.round(ROTATE_AT * 100);
      ctxBtn.textContent = `${pct}%`;
      ctxBtn.style.setProperty("--ctx-pct", `${pct}%`);
      ctxBtn.dataset.level = pct >= rotPct ? "hot" : pct >= 70 ? "warn" : "";
      const kUsed = Math.round(this.contextTokens / 1000);
      const kLimit = Math.round(limit / 1000);
      ctxBtn.title = `${this.contextModel || this.adapter?.name || "모델"} · ${kUsed}k / ${kLimit}k (${pct}%) · ${rotPct}%에서 자동 회전 · 클릭하면 지금 핸드오프`;
    } else {
      ctxBtn.textContent = "";
      ctxBtn.style.removeProperty("--ctx-pct");
      delete ctxBtn.dataset.level;
    }
    // One header button toggles both ways; only hook agents have a GUI view.
    const btn = this.$(".b-cli");
    btn.hidden = !this.hooks;
    btn.innerHTML = this.view === "cli" ? `${icon(ICONS.LayoutList)}<span class="lbl">${L("GUI 보기", "GUI")}</span>` : `${icon(ICONS.SquareTerminal)}<span class="lbl">${L("CLI 보기", "CLI")}</span>`;
    btn.title = this.view === "cli" ? L("GUI 화면으로 돌아가기", "Switch to GUI view") : L("CLI 화면 보기", "Switch to CLI view");
    if (this.adapter && !this.adapter.detected && (loading || this.status === "exited")) {
      box.innerHTML = `<div class="s-diag"><b>${L(`${this.adapter.name} CLI를 찾을 수 없습니다`, `${this.adapter.name} CLI not found`)}</b><p>${L(`실행 명령(<code>${this.adapter.launch}</code>)이 PATH에 설치되어 있는지 확인하거나, 아래 에이전트 선택에서 설치된 다른 에이전트로 바꾸세요.`, `Check that <code>${this.adapter.launch}</code> is in your PATH, or switch to another agent below.`)}</p></div>`;
    } else if (loading) {
      box.innerHTML = `<div class="s-loading">${L("로딩 중…", "Loading…")}</div>`;
    } else if (show) {
      renderSummary(this, box);
    }
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

  /** Claude's permission menu: Enter takes "Yes", "always" picks the session-allow option, Esc rejects. */
  answerPermission(allow) {
    if (allow === "always") {
      const alwaysChoice = (this.menuChoices ?? []).find((c) => /don't ask|always|항상|session/i.test(c.label));
      const keys = alwaysChoice?.keys ?? ["\x1b[B", "\r"];
      keys.forEach((k, i) => setTimeout(() => this.agent.write(k), i * 60));
      this.setStatus("working", "이번 세션 항상 허용 · 계속 진행");
      return;
    }
    this.agent.write(allow ? "\r" : "\x1b");
    this.setStatus("working", allow ? "허용함 · 계속 진행" : "거부함");
  }

  setDensity(d) {
    this.density = d;
    this.el.dataset.density = d;
    this.updatePeek();
  }

  setFileCount(n) {
    this.$(".cnt").textContent = n ? L(`· ${n}개 변경`, `· ${n} changed`) : "";
    this.refreshDiff(n);
    this.app.updateConflicts?.();
  }

  /** Header badge "+12 −3": lines changed since the last commit (B5), plus current branch / PR link. */
  async refreshDiff(changedFiles) {
    const [d, info] = await Promise.all([
      changedFiles ? invoke("git_shortstat", { root: this.root }).catch(() => null) : null,
      invoke("git_branch_info", { root: this.root }).catch(() => null),
    ]);
    const b = this.$(".diff");
    b.hidden = !d || !(d.added || d.removed);
    if (!b.hidden) b.textContent = `+${d.added} −${d.removed}`;
    const br = this.$(".b-branch");
    this.prUrl = info?.pr_url ?? null;
    const isFeature = info?.branch && !["main", "master"].includes(info.branch);
    br.hidden = !isFeature;
    if (!br.hidden) {
      br.textContent = this.prUrl ? `${info.branch} ↗` : info.branch;
      br.title = this.prUrl ? `${info.branch} · 클릭하면 PR/Compare 페이지 열기` : `현재 브랜치: ${info.branch}`;
    }
  }

  /** Open the file panel on the changed files, and the stacked or first diff in the review view. */
  showChanges() {
    if (this.density !== "full") {
      this.setDensity("full");
      this.app.layout();
    }
    this.$(".m-files").open = true;
    this.explorer.setMode("changed");
    if (this.explorer.status.size > 1) return this.viewer.openAllDiffs();
    const first = [...this.explorer.status.keys()].sort()[0];
    if (first) this.viewer.open(first, "diff");
  }

  /** Ctrl+I: code selected in the viewer as `@file Lx-y`, else text selected in a terminal (A5). */
  insertSelection() {
    if (this.viewer.isOpen && this.viewer.selectionRange()) return this.viewer.insertSelection();
    const term = [this.shell?.term, this.agent.term].find((t) => t?.hasSelection());
    if (!term) return this.viewer.insertSelection();
    const text = term.getSelection().replace(/[ \t]+$/gm, "").trim();
    if (text) this.composer.insert("\n```\n" + text + "\n```\n");
  }

  openWorktree() { return openWorktree(this); }
  mergeWorktree() { return mergeWorktree(this); }
  removeWorktree() { return removeWorktree(this); }

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
        for (let i = lines.length - 1; i >= 0; i--) {
          const found = detectLocalhostUrl(lines[i]);
          if (found) {
            this.previewUrl = found.url;
            const pb = this.$(".b-preview");
            pb.textContent = `:${found.port}`;
            pb.title = `로컬 서버 열기 (${found.url})`;
            pb.hidden = false;
            break;
          }
        }
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
    if (event === "prompt" || (event === "invocation" && this.status !== "working")) {
      // Subagent reports and task notices reach the agent as prompts: it keeps working on the same request.
      const notice = isAgentNotice(data?.prompt);
      if (!notice && (this.turnAsk || this.turn?.texts?.length)) this.history = [...this.history, { ask: this.turnAsk, texts: this.turn?.texts ?? [], checkpoint: this.turnCheckpoint }].slice(-50);
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
    if (event === "invocation" && this.status === "working") {
      this.peekTurn();
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
      this.contextModel = turn.model || this.contextModel;
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
      this.contextModel = turn?.model || this.contextModel;
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
      const limit = contextLimit(this.adapter, this.contextModel);
      if (limit && this.contextTokens >= limit * ROTATE_AT) this.rotate(this.adapter, `컨텍스트가 ${Math.round((this.contextTokens / limit) * 100)}% 찼습니다.`);
      if (!this.rotating && this.cfg.post_turn_cmd) this.runPostTurnTest();
    }
    // A forwarded note takes this turn; the queue goes on when that one ends.
    if (!note && !this.rotating) this.sendQueued();
  }

  /** Trigger a manual context handoff (progress.md + fresh session) from header or Command Palette. */
  async manualHandoff() {
    if (this.rotating) return;
    if (!["done", "idle"].includes(this.status)) {
      return message("에이전트가 응답을 마친 뒤 핸드오프할 수 있습니다.", { kind: "info" });
    }
    const ok = await ask("현재 맥락을 progress.md에 정리하고 새 대화로 이어받을까요?", { title: "세션 핸드오프", kind: "info", okLabel: "핸드오프", cancelLabel: "취소" });
    if (ok) this.rotate(this.adapter, "사용자가 수동 핸드오프를 요청했습니다.");
  }

  /** One-click run/verify: runs `post_turn_cmd`, or auto-detects `package.json` dev/start/test script. */
  async quickRun() {
    if (this.cfg.post_turn_cmd?.trim()) return this.runPostTurnTest();
    try {
      const pkg = JSON.parse(await invoke("read_file", { root: this.root, rel: "package.json" }));
      const s = pkg?.scripts ?? {};
      const dev = s.dev ? "npm run dev" : s.start ? "npm start" : null;
      if (dev) {
        if (this.$(".shell").hidden) this.toggleShell();
        setTimeout(() => this.shell?.write(`${dev}\r`), 250);
        return;
      }
      if (s.test) return this.runPostTurnTest("npm test");
    } catch {}
    if (this.$(".shell").hidden) this.toggleShell();
  }

  /** Run project-configured verification command after an agent turn ends. */
  async runPostTurnTest(cmdOverride = null) {
    const cmd = (cmdOverride ?? this.cfg.post_turn_cmd)?.trim();
    if (!cmd) return;
    this.lastTestCmd = cmd;
    const seq = (this.testSeq = (this.testSeq ?? 0) + 1);
    const btn = this.$(".b-test");
    btn.hidden = false;
    btn.className = "b-test running";
    btn.textContent = "검증 중…";
    btn.title = cmd;
    try {
      const res = await invoke("run_shell_cmd", { root: this.root, cmd });
      if (seq !== this.testSeq) return;
      this.lastTestResult = res;
      btn.className = `b-test ${res.ok ? "ok" : "fail"}`;
      btn.textContent = res.ok ? "검증 통과" : `검증 실패 (${res.code})`;
      btn.title = res.ok ? `${cmd} 통과` : `${cmd} 실패 — 클릭하면 실패 로그를 입력창에 넣습니다`;
      if (!res.ok) this.app.onTestFail?.(this, res);
    } catch (e) {
      if (seq !== this.testSeq) return;
      btn.className = "b-test fail";
      btn.textContent = "검증 오류";
      this.lastTestResult = { ok: false, code: -1, output: String(e) };
    }
  }

  onTestBadgeClick() {
    const res = this.lastTestResult;
    const cmd = this.lastTestCmd || this.cfg.post_turn_cmd;
    if (!res) return;
    if (res.ok) return message(`명령 통과: ${cmd}\n\n${res.output || "(출력 없음)"}`, { kind: "info" });
    this.composer.insert(`다음 검증 명령이 실패했습니다 (\`${cmd}\`, 종료 코드 ${res.code}). 실패 원인을 확인하고 고쳐주세요:\n\`\`\`\n${res.output}\n\`\`\`\n`);
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
  /** The answer recommends a fresh conversation (/clear): start one carrying nothing over, unlike rotate(). */
  async freshSession() {
    if (this.rotating || !["done", "idle"].includes(this.status)) return;
    if (this.turnAsk || this.turn?.texts?.length) this.history = [...this.history, { ask: this.turnAsk, texts: this.turn?.texts ?? [] }].slice(-50);
    this.turn = this.live = this.turnAsk = null;
    await this.renew(false);
    if (this.status !== "starting") this.setStatus("idle", "새 대화");
  }

  async renew(seed = true) {
    const next = this.nextAdapter ?? this.adapter;
    this.nextAdapter = null;
    this.rotating = seed ? "seed" : null;
    this.transcript = this.contextTokens = this.contextModel = null;
    const t = this.agent.term;
    // Inline CLIs: seam below everything, then scroll the whole old screen into scrollback: on Windows the CLI's clear
    // arrives as ConPTY repaints at absolute rows, which would overwrite whatever is still on screen.
    // Full-screen CLIs (alternate buffer, e.g. Claude Code 2.1): no scrollback to keep, and they repaint only the rows
    // they changed, so writing here would leave a blanked, half-drawn screen.
    if (t.buffer.active.type === "normal") t.write("\x1b[999;1H\r\n\x1b[90m── 세션 이어짐 ──\x1b[0m" + "\r\n".repeat(t.rows - 1));
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
    if (!seed || !next || !this.agent.alive) return (this.rotating = null);
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
    this.cfg.agent = a?.name;
    delete this.cfg.model;
    delete this.cfg.effort;
    this.userModel = false;
    this.hooks = a?.status === "hooks";
    this.agent.command = this.launchCommand();
    this.composer = new Composer(this, this.$(".composer"));
    this.renderAgentPick();
    this.app.save?.();
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

  async loadSpec(fileOverride = null) {
    const s = await invoke("read_spec", { root: this.root, preferred: fileOverride ?? this.cfg.spec_file ?? null }).catch(() => null);
    this.$(".spec-name").textContent = s ? s.name : "(없음)";
    // Spec files may be written by agents: sanitize before rendering.
    const box = this.$(".spec");
    box.innerHTML = s
      ? DOMPurify.sanitize(marked.parse(s.content))
      : `<p class="muted">MASTER_SPEC.md · CLAUDE.md · README.md 가 없습니다.</p>`;
    const files = await this.fileList();
    const guides = ["MASTER_SPEC.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md", "README.md"].filter((f) => files.includes(f));
    if (guides.length > 1) {
      const bar = document.createElement("div");
      bar.className = "spec-tabs";
      for (const g of guides) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = g;
        if (s?.name === g) b.className = "on";
        b.onclick = () => this.loadSpec(g);
        bar.append(b);
      }
      box.prepend(bar);
    }
    // Allow clicking unchecked spec checklist items to queue/insert them as the next prompt.
    for (const cb of box.querySelectorAll('input[type="checkbox"]')) {
      cb.disabled = true;
      if (cb.checked) continue;
      const li = cb.closest("li");
      if (!li) continue;
      const run = document.createElement("button");
      run.type = "button";
      run.className = "spec-run";
      run.textContent = "실행";
      run.title = "이 항목을 에이전트 지시로 넣기";
      run.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = li.textContent.replace(/실행$/, "").trim();
        if (text) this.composer.insert(`스펙(${s?.name ?? "spec"})의 다음 항목을 진행해줘:\n- ${text}`);
      };
      li.append(" ", run);
    }
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
  async sendToAgent(text) {
    if (!this.rotating && !text.includes("[mygdeck]")) {
      this.turnCheckpoint = await invoke("git_checkpoint_create", { root: this.root }).catch(() => null);
    }
    this.agent.write(pasteSequence(text, this.agent.term.modes.bracketedPasteMode));
    setTimeout(() => this.agent.write("\r"), 80);
  }

  /** Restore tracked files to the snapshot captured before a turn. */
  async restoreCheckpoint(rev = this.turnCheckpoint) {
    if (!rev) return message("복원할 이전 턴 체크포인트가 없습니다.", { kind: "info" });
    const ok = await ask(`${this.name}: 해당 지시 직전의 git 상태로 되돌릴까요?`, { title: "체크포인트 복원", kind: "warning", okLabel: "되돌리기", cancelLabel: "취소" });
    if (!ok) return;
    try {
      await invoke("git_checkpoint_restore", { root: this.root, rev });
      if (rev === this.turnCheckpoint) this.turnCheckpoint = null;
      this.explorer.refresh();
      this.viewer.reload();
    } catch (e) {
      message(`체크포인트 복원 실패: ${e}`, { kind: "error" });
    }
  }

  toggleShell() {
    const box = this.$(".shell");
    if (!this.shell) {
      this.openShell();
      return;
    }
    box.hidden = !box.hidden;
    if (box.hidden) this.focusDefault();
    else this.shell.term.focus();
  }

  openShell({ fresh = false } = {}) {
    const box = this.$(".shell");
    if (fresh && this.shell) {
      this.shell.dispose();
      this.shell = null;
    }
    box.hidden = false;
    if (!this.shellScriptsLoaded) {
      this.shellScriptsLoaded = true;
      invoke("read_project_scripts", { root: this.root }).then((scripts) => {
        const host = this.$(".shell-scripts");
        if (!host) return;
        host.textContent = "";
        for (const s of scripts) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = s;
          b.title = `npm run ${s} 실행`;
          b.onclick = () => { this.shell?.write(`npm run ${s}\r`); this.shell?.term.focus(); };
          host.append(b);
        }
      }).catch(() => {});
    }
    this.shell = new Pty(box, {
      key: `${this.root}#shell`,
      cwd: this.root,
      command: this.app.shell,
      scrollback: 2000,
      onFileLink: (rel, line) => this.viewer.open(rel, "code", line),
    });
    requestAnimationFrame(async () => {
      const live = fresh ? null : this.app.takeLive(this.shell.key);
      if (!(live && (await this.shell.attach(live.id)))) this.shell.start();
      this.shell.term.focus();
    });
  }

  restartShell() {
    this.openShell({ fresh: true });
  }

  sendShellOutput() {
    const out = this.shell?.lastLines(30, false).join("\n").trim();
    if (!out) return message("하단 터미널에 보낼 출력이 없습니다.", { kind: "info" });
    this.composer.insert(`터미널 실행 결과입니다. 오류가 있으면 원인을 파악해 고쳐주세요:\n\`\`\`\n${out}\n\`\`\`\n`);
  }

  fixShellError() {
    const out = pickErrorLines(this.shell?.lastLines(50, false) ?? [], 30);
    if (!out) return message("하단 터미널에 보낼 출력이 없습니다.", { kind: "info" });
    this.composer.insert(`하단 터미널에서 오류가 발생했습니다. 원인을 파악해 수정해 주세요:\n\`\`\`\n${out}\n\`\`\`\n`);
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
    this.closeAgentMenu();
    clearInterval(this.clock);
    this.agent.dispose();
    this.shell?.dispose();
    invoke("unwatch_project", { id: this.id }).catch(() => {});
    this.el.remove();
  }
}
