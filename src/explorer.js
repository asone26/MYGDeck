import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fuzzyFilter, mentionFor } from "./logic.js";
import { poolReady } from "./connections.js";

/** File explorer: files changed in this project (default) or the whole tree (spec 3.2 ①). */
export class Explorer {
  constructor(card, el) {
    Object.assign(this, { card, el, mode: "changed", status: new Map(), staged: new Set(), excluded: new Set(), turnOnly: false, turnFiles: null, filterQuery: "" });
    el.innerHTML = `<div class="xbar"><button data-m="changed" class="on">변경된 파일</button><button data-m="all">전체</button>
      <button data-m="log" title="최근 커밋 기록 보기">기록</button>
      <button class="x-turn" title="이번 턴에서 바뀐 파일만 보기" hidden>이번 턴</button>
      <button class="x-all" title="변경된 모든 파일을 한 화면에서 비교" hidden>전체 비교</button>
      <button class="x-ai" title="AI로 변경사항 3줄 요약 및 주의할 점 점검" hidden>AI 요약</button>
      <span class="sp"></span>
      <select class="x-branches" title="브랜치 전환 또는 새 브랜치 만들기" hidden></select>
      <button class="x-stash" title="변경사항 임시 보관 (git stash)">보관</button>
      <button class="x-pull" title="원격 변경사항 가져오기 (git pull)" hidden>↓</button>
      <button class="x-pr" title="현재 브랜치로 GitHub PR 초안 만들기">PR</button>
      <button class="x-save" title="바뀐 내용을 커밋합니다 · 메시지는 자동 생성">커밋</button>
      <button class="x-push" title="커밋을 원격 저장소로 올립니다 (git push)">푸시</button></div>
      <div class="xfilter-row"><input class="xfilter" placeholder="파일 이름 필터…" spellcheck="false"><button class="x-newf" title="새 파일 만들기">+파일</button><button class="x-newd" title="새 폴더 만들기">+폴더</button></div>
      <div class="xmsg" hidden></div><div class="xlist"></div>`;
    this.list = el.querySelector(".xlist");
    this.msg = el.querySelector(".xmsg");
    this.saveBtn = el.querySelector(".x-save");
    this.allBtn = el.querySelector(".x-all");
    this.aiBtn = el.querySelector(".x-ai");
    this.turnBtn = el.querySelector(".x-turn");
    this.pullBtn = el.querySelector(".x-pull");
    this.stashBtn = el.querySelector(".x-stash");
    this.filterIn = el.querySelector(".xfilter");
    this.filterIn.oninput = () => {
      this.filterQuery = this.filterIn.value.trim();
      this.render();
    };
    el.querySelector(".x-newf").onclick = () => this.createEntry("", false);
    el.querySelector(".x-newd").onclick = () => this.createEntry("", true);
    this.pullBtn.onclick = () => this.git("git_pull", {}, "원격 변경사항을 가져왔습니다");
    this.stashBtn.onclick = () => this.openStashMenu();
    this.saveBtn.onclick = () => this.commit();
    this.allBtn.onclick = () => this.card.viewer.openAllDiffs();
    this.aiBtn.onclick = () => this.summarizeChanges();
    this.turnBtn.onclick = () => {
      this.turnOnly = !this.turnOnly;
      this.turnBtn.classList.toggle("on", this.turnOnly);
      this.render();
    };
    this.branchSel = el.querySelector(".x-branches");
    this.branchSel.onchange = () => {
      const v = this.branchSel.value;
      if (v === "@new") {
        this.branchSel.value = this.curBranch ?? "";
        return this.newBranch();
      }
      if (v && v !== this.curBranch) this.git("git_switch_branch", { name: v }, `브랜치 전환: ${v}`);
    };
    el.querySelector(".x-pr").onclick = () => this.createPr();
    this.pushBtn = el.querySelector(".x-push");
    this.pushBtn.onclick = () => this.git("git_push", {}, "푸시했습니다");
    el.querySelector(".xbar").addEventListener("click", (e) => {
      const m = e.target.dataset?.m;
      if (m) this.setMode(m);
    });
    // Opening the panel with nothing changed: show the whole tree instead of an empty list.
    const panel = el.closest("details");
    panel?.addEventListener("toggle", () => panel.open && !this.status.size && this.mode !== "all" && this.setMode("all"));
    this.list.addEventListener("click", (e) => this.onClick(e));
    // Double-click a file: open it with the OS default app (HTML → browser).
    this.list.addEventListener("dblclick", (e) => {
      const n = e.target.closest("[data-path]");
      if (n && !n.dataset.dir) invoke("open_file", { root: card.root, rel: n.dataset.path }).catch((err) => this.say(`열기 실패: ${err}`, true));
    });
    this.list.addEventListener("contextmenu", (e) => {
      const n = e.target.closest("[data-path]");
      if (!n || n.querySelector("input")) return;
      e.preventDefault();
      this.showContextMenu(e, n);
    });
    this.list.addEventListener("dragstart", (e) => {
      const p = e.target.closest?.("[data-path]")?.dataset.path;
      if (p) e.dataTransfer.setData("text/plain", mentionFor(card.adapter?.mention, p));
    });
  }

  /** Inline rename (right-click): Enter or leaving the box saves, Esc cancels. */
  rename(n) {
    const rel = n.dataset.path;
    const base = rel.split("/").pop();
    const label = n.textContent;
    const input = document.createElement("input");
    input.className = "xren";
    input.value = base;
    input.spellcheck = false;
    n.draggable = false;
    n.textContent = "";
    n.append(input);
    input.focus();
    const dot = base.lastIndexOf(".");
    input.setSelectionRange(0, n.dataset.dir || dot <= 0 ? base.length : dot);
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== base) {
        try {
          await invoke("rename_file", { root: this.card.root, rel, name });
          this.say(`이름 변경: ${base} → ${name}`);
          this.render();
          this.card.onFsChange();
          return;
        } catch (err) {
          this.say(`이름 변경 실패: ${err}`, true);
        }
      }
      n.textContent = label;
      n.draggable = !n.dataset.dir;
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    for (const ev of ["click", "dblclick", "mousedown"]) input.addEventListener(ev, (e) => e.stopPropagation());
  }

  setMode(m) {
    this.mode = m;
    for (const b of this.el.querySelectorAll(".xbar button[data-m]")) b.classList.toggle("on", b.dataset.m === m);
    this.syncControls();
    this.render();
  }

  syncControls() {
    const total = this.status.size;
    const selected = [...this.status.keys()].filter((p) => !this.excluded.has(p)).length;
    this.turnBtn.hidden = this.mode !== "changed" || !this.card.turnCheckpoint || total === 0;
    if (this.turnBtn.hidden) this.turnOnly = false;
    this.turnBtn.classList.toggle("on", this.turnOnly);
    this.allBtn.hidden = this.mode !== "changed" || total < 2;
    this.aiBtn.hidden = this.mode !== "changed" || total === 0;
    this.saveBtn.classList.toggle("on", selected > 0);
    this.saveBtn.disabled = total > 0 && selected === 0;
    this.saveBtn.textContent = total > 0 && selected < total ? `커밋 (${selected}/${total})` : "커밋";
  }

  /** Commit with a message from the free AI pool; without one, a message listing the changed files. */
  async commit() {
    if (!this.status.size) return this.say("바뀐 내용이 없습니다");
    const allFiles = [...this.status.keys()];
    const files = allFiles.filter((f) => !this.excluded.has(f));
    if (!files.length) return this.say("커밋할 파일을 선택하세요");
    let message = `Update ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`;
    if (poolReady()) {
      this.say("커밋 메시지 생성 중…");
      const diff = (await invoke("git_diff", { root: this.card.root }).catch(() => "")).slice(0, 8000);
      const prompt = `Write one git commit message line (Conventional Commits, English, max 72 chars) for these changes. Reply with the line only.\n\nFiles:\n${files.map((p) => `${this.status.get(p)} ${p}`).join("\n")}\n\nDiff:\n${diff}`;
      const a = await invoke("ai_ask", { prompt, search: false }).catch(() => null);
      const line = a?.text.split("\n").map((l) => l.replace(/^[`"'\s]+|[`"'\s]+$/g, "")).find(Boolean);
      if (line) message = line.slice(0, 100);
    }
    this.git("git_save", { message, files: files.length < allFiles.length ? files : null }, `커밋했습니다: ${message}`);
  }

  async summarizeChanges() {
    if (!this.status.size) return this.say("바뀐 내용이 없습니다");
    if (!poolReady()) return this.say("AI 연결 설정 후 사용할 수 있습니다", true);
    this.say("변경사항 AI 요약 중…");
    const diff = (await invoke("git_diff", { root: this.card.root }).catch(() => "")).slice(0, 8000);
    const files = [...this.status].map(([p, c]) => `${c} ${p}`).join("\n");
    const prompt = `Summarize these uncommitted git changes in Korean (3 concise bullets for what changed, plus 1-2 potential risks or missing checks if any).\n\nFiles:\n${files}\n\nDiff:\n${diff}`;
    try {
      const a = await invoke("ai_ask", { prompt, search: false });
      this.card.showAnswer("변경사항 AI 요약", a.text, a.via, a);
      this.msg.hidden = true;
    } catch (e) {
      this.say(`요약 실패: ${String(e).split("\n")[0]}`, true);
    }
  }

  async newBranch() {
    const name = window.prompt("새 작업 브랜치 이름을 입력하세요 (예: feat/login):");
    if (!name?.trim()) return;
    await this.git("git_new_branch", { name: name.trim() }, `브랜치 전환: ${name.trim()}`);
  }

  async createPr() {
    const info = await invoke("git_branch_info", { root: this.card.root }).catch(() => null);
    if (!info?.branch || info.branch === "main" || info.branch === "master") {
      return this.say("main/master가 아닌 작업 브랜치에서 PR을 만들 수 있습니다", true);
    }
    let title = `feat: ${info.branch}`;
    let body = `Branch: ${info.branch}`;
    if (poolReady()) {
      this.say("PR 제목·본문 생성 중…");
      const diff = (await invoke("git_diff", { root: this.card.root }).catch(() => "")).slice(0, 6000);
      const askText = `Write a concise GitHub PR title on line 1 and a short bulleted summary on the following lines for branch "${info.branch}".\n\nDiff:\n${diff}`;
      const a = await invoke("ai_ask", { prompt: askText, search: false }).catch(() => null);
      const lines = a?.text?.split("\n").map((l) => l.trim()).filter(Boolean) ?? [];
      if (lines.length) {
        title = lines[0].replace(/^#+\s*/, "").slice(0, 100);
        body = lines.slice(1).join("\n") || title;
      }
    }
    try {
      this.say("PR 초안 생성 중…");
      const url = await invoke("git_create_pr", { root: this.card.root, title, body });
      this.say(`PR 초안 생성됨: ${url}`);
      if (/^https?:\/\//.test(url)) openUrl(url).catch(() => {});
    } catch (e) {
      this.say(`PR 실패: ${String(e).split("\n")[0]}`, true);
    }
  }

  /** Commit / push, with plain-language results instead of git output. */
  async git(cmd, args, done) {
    const isPush = cmd === "git_push";
    if (isPush && this.pushBtn) {
      this.pushBtn.disabled = true;
      this.say("푸시 중…");
    }
    try {
      await invoke(cmd, { root: this.card.root, ...args });
      this.say(done);
    } catch (e) {
      const lines = String(e).split("\n").map((l) => l.trim()).filter(Boolean);
      const errLine = lines.find((l) => /^(error:|fatal:|!|remote:|rejected)/i.test(l)) || lines.slice(0, 2).join(" · ");
      this.say(`실패: ${errLine || e}`, true);
    } finally {
      if (isPush && this.pushBtn) this.pushBtn.disabled = false;
    }
    this.refresh();
    this.card.onFsChange();
  }

  say(text, bad = false) {
    this.msg.hidden = false;
    this.msg.textContent = text;
    this.msg.classList.toggle("bad", bad);
    clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => (this.msg.hidden = true), 5000);
  }

  async refresh() {
    const [st, ahead, behind, staged, since, branches, info] = await Promise.all([
      invoke("git_status", { root: this.card.root }).catch(() => []),
      invoke("git_ahead", { root: this.card.root }).catch(() => 0),
      invoke("git_behind", { root: this.card.root }).catch(() => 0),
      invoke("git_staged_files", { root: this.card.root }).catch(() => []),
      this.card.turnCheckpoint
        ? invoke("git_changed_since", { root: this.card.root, rev: this.card.turnCheckpoint }).catch(() => null)
        : null,
      invoke("git_branches", { root: this.card.root }).catch(() => []),
      invoke("git_branch_info", { root: this.card.root }).catch(() => null),
    ]);
    this.curBranch = info?.branch ?? null;
    this.branchSel.hidden = !branches.length && !this.curBranch;
    if (!this.branchSel.hidden) {
      this.branchSel.textContent = "";
      for (const b of branches) this.branchSel.append(new Option(b, b));
      if (this.curBranch && !branches.includes(this.curBranch)) this.branchSel.append(new Option(this.curBranch, this.curBranch));
      this.branchSel.append(new Option("+ 새 브랜치…", "@new"));
      if (this.curBranch) this.branchSel.value = this.curBranch;
    }
    this.turnFiles = since ? new Set(since) : null;
    this.status = new Map(st.map((s) => [s.path, s.code]));
    this.staged = new Set(staged);
    for (const p of this.excluded) if (!this.status.has(p)) this.excluded.delete(p);
    this.syncControls();
    this.el.querySelector(".x-push").classList.toggle("on", ahead > 0);
    this.el.querySelector(".x-push").title = `커밋을 원격 저장소로 올립니다 (git push)${ahead ? ` · 올릴 커밋 ${ahead}개` : ""}`;
    this.pullBtn.hidden = behind === 0;
    this.pullBtn.textContent = `↓${behind}`;
    this.pullBtn.title = `원격에서 가져올 커밋 ${behind}개 (git pull)`;
    this.card.setFileCount(st.length);
    this.card.viewer.syncReview();
    if (this.mode === "changed" || this.mode === "log") this.render();
    else this.recolor();
  }

  async render() {
    this.list.textContent = "";
    if (this.mode === "log") return this.renderLog();
    if (this.mode === "all") {
      if (this.filterQuery) {
        const files = await invoke("list_files", { root: this.card.root }).catch(() => []);
        const hits = fuzzyFilter(files, this.filterQuery, (f) => f).slice(0, 100);
        if (!hits.length) { this.list.innerHTML = `<div class="muted">일치하는 파일이 없습니다</div>`; return; }
        for (const p of hits) this.list.append(node(p, p, false, this.status.get(p), 0));
        return;
      }
      return this.expand(this.list, "", 0);
    }
    const q = this.filterQuery.toLowerCase();
    const entries = [...this.status]
      .filter(([p]) => (!this.turnOnly || !this.turnFiles || this.turnFiles.has(p)) && (!q || p.toLowerCase().includes(q)))
      .sort();
    if (!entries.length) {
      this.list.innerHTML = `<div class="muted">${this.turnOnly ? "이번 턴에 바뀐 파일이 없습니다" : "변경된 파일이 없습니다"}</div>`;
      return;
    }
    for (const [p, code] of entries) {
      const row = node(p, p, false, code, 0);
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "xchk";
      chk.checked = !this.excluded.has(p);
      chk.title = "커밋에 포함";
      chk.onclick = (e) => {
        e.stopPropagation();
        if (chk.checked) this.excluded.delete(p);
        else this.excluded.add(p);
        this.syncControls();
      };
      row.prepend(chk);
      if (this.staged.has(p)) {
        const stg = document.createElement("span");
        stg.className = "x-stg";
        stg.textContent = "S";
        stg.title = "Staged (git add 됨)";
        row.append(stg);
      }
      const others = this.card.conflicts?.get(p);
      if (others?.length) {
        row.classList.add("conflict");
        const tag = document.createElement("span");
        tag.className = "x-cfl";
        tag.textContent = "중복";
        tag.title = `${others.join(", ")} 카드에서도 수정 중`;
        row.append(tag);
      }
      this.list.append(row);
    }
  }

  async renderLog() {
    const commits = await invoke("git_log", { root: this.card.root, limit: 20 }).catch(() => []);
    if (!commits.length) {
      this.list.innerHTML = `<div class="muted">커밋 기록이 없습니다</div>`;
      return;
    }
    for (const c of commits) {
      const row = document.createElement("div");
      row.className = "xlog";
      row.innerHTML = `<span class="xl-h">${c.hash}</span><span class="xl-s"></span><span class="xl-w">${c.when}</span>`;
      row.querySelector(".xl-s").textContent = c.subject;
      row.title = `${c.hash} · ${c.author} (${c.when})\n${c.subject}`;
      row.onclick = () => this.card.viewer.openCommitDiff(c.hash, c.subject);
      this.list.append(row);
    }
  }

  async createEntry(dir, isDir) {
    const label = isDir ? "새 폴더" : "새 파일";
    const name = window.prompt(`${label} 경로를 입력하세요${dir ? ` (${dir}/ 아래)` : ""}:`);
    if (!name?.trim()) return;
    const rel = dir ? `${dir}/${name.trim()}` : name.trim();
    try {
      await invoke("create_file", { root: this.card.root, rel, isDir });
      this.say(`${label} 생성: ${rel}`);
      await this.refresh();
      if (!isDir) this.card.viewer.open(rel, "code");
      this.card.onFsChange();
    } catch (e) {
      this.say(`${label} 생성 실패: ${e}`, true);
    }
  }

  async openStashMenu() {
    const list = await invoke("git_stash_list", { root: this.card.root }).catch(() => []);
    const op = this.status.size
      ? (window.confirm("현재 변경사항을 임시 보관(git stash)할까요?\n(취소하면 보관 목록에서 꺼내기를 선택합니다)") ? "save" : "pop")
      : (list.length ? "pop" : null);
    if (!op) return this.say("보관할 변경이나 꺼낼 stash가 없습니다");
    if (op === "save") return this.git("git_stash_op", { op: "save", index: 0 }, "변경사항을 임시 보관했습니다");
    if (!list.length) return this.say("꺼낼 stash가 없습니다");
    await this.git("git_stash_op", { op: "pop", index: 0 }, `보관 복원: ${list[0].label}`);
  }

  showContextMenu(e, n) {
    document.querySelector(".xmenu")?.remove();
    const rel = n.dataset.path;
    const isDir = !!n.dataset.dir;
    const abs = `${this.card.root.replace(/[\\/]+$/, "")}/${rel}`;
    const menu = document.createElement("div");
    menu.className = "xmenu";
    menu.style.left = `${Math.min(e.clientX, innerWidth - 190)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - 240)}px`;
    const add = (label, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => { menu.remove(); fn(); };
      menu.append(b);
    };
    add("상대 경로 복사", () => navigator.clipboard.writeText(rel).then(() => this.say(`복사됨: ${rel}`)).catch(() => {}));
    add("절대 경로 복사", () => navigator.clipboard.writeText(abs).then(() => this.say("절대 경로 복사됨")).catch(() => {}));
    add("OS 탐색기에서 열기", () => invoke("reveal_in_os", { root: this.card.root, rel }).catch((err) => this.say(`열기 실패: ${err}`, true)));
    if (isDir) {
      add("이 폴더에 새 파일", () => this.createEntry(rel, false));
      add("이 폴더에 새 폴더", () => this.createEntry(rel, true));
    } else if (this.status.has(rel)) {
      const staged = this.staged.has(rel);
      add(staged ? "Stage 해제 (Unstage)" : "Stage 올리기 (git add)", () =>
        invoke("git_stage_toggle", { root: this.card.root, rel, stage: !staged }).then(() => this.refresh()).catch((err) => this.say(`실패: ${err}`, true))
      );
    }
    add("이름 바꾸기", () => this.rename(n));
    add("삭제", async () => {
      if (!window.confirm(`정말 삭제할까요?\n${rel}`)) return;
      try {
        await invoke("delete_file", { root: this.card.root, rel });
        this.say(`삭제됨: ${rel}`);
        this.refresh();
        this.card.onFsChange();
      } catch (err) {
        this.say(`삭제 실패: ${err}`, true);
      }
    });
    document.body.append(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); removeEventListener("mousedown", close, true); } };
    addEventListener("mousedown", close, true);
  }

  async expand(container, rel, depth) {
    const items = await invoke("list_dir", { root: this.card.root, rel }).catch(() => []);
    for (const it of items) {
      const p = rel ? `${rel}/${it.name}` : it.name;
      container.append(node(p, it.name, it.dir, this.codeFor(p, it.dir), depth));
    }
  }

  codeFor(p, dir) {
    if (!dir) return this.status.get(p);
    for (const k of this.status.keys()) if (k.startsWith(p + "/")) return "M";
  }

  async onClick(e) {
    const n = e.target.closest("[data-path]");
    if (!n) return;
    if (!n.dataset.dir) return this.card.viewer.open(n.dataset.path, n.dataset.code ? "diff" : "code");
    const kids = n.nextElementSibling?.classList.contains("kids") ? n.nextElementSibling : null;
    n.classList.toggle("open", !kids);
    if (kids) return kids.remove();
    const box = document.createElement("div");
    box.className = "kids";
    n.after(box);
    await this.expand(box, n.dataset.path, +n.dataset.depth + 1);
  }

  recolor() {
    for (const n of this.list.querySelectorAll("[data-path]")) n.dataset.code = this.codeFor(n.dataset.path, !!n.dataset.dir) ?? "";
  }
}

function node(path, label, dir, code, depth) {
  const d = document.createElement("div");
  d.className = "xn" + (dir ? " dir" : "");
  d.dataset.path = path;
  d.dataset.depth = depth;
  d.dataset.code = code ?? "";
  if (dir) d.dataset.dir = "1";
  d.draggable = !dir;
  d.style.paddingLeft = `${8 + depth * 12}px`;
  d.textContent = label;
  d.title = dir ? `${path}\n오른쪽 클릭: 이름 바꾸기` : `${path}\n클릭: 코드 보기 · 더블클릭: 실행 · 오른쪽 클릭: 이름 바꾸기 · 입력창으로 끌어다 놓기: @파일`;
  return d;
}
