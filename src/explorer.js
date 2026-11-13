import { invoke } from "@tauri-apps/api/core";
import { mentionFor } from "./logic.js";
import { poolReady } from "./connections.js";

/** File explorer: files changed in this project (default) or the whole tree (spec 3.2 ①). */
export class Explorer {
  constructor(card, el) {
    Object.assign(this, { card, el, mode: "changed", status: new Map() });
    el.innerHTML = `<div class="xbar"><button data-m="changed" class="on">변경된 파일</button><button data-m="all">전체</button>
      <span class="sp"></span>
      <button class="x-save" title="바뀐 내용을 커밋합니다 · 메시지는 자동 생성">커밋</button>
      <button class="x-push" title="커밋을 원격 저장소로 올립니다 (git push)">푸시</button></div>
      <div class="xmsg" hidden></div><div class="xlist"></div>`;
    this.list = el.querySelector(".xlist");
    this.msg = el.querySelector(".xmsg");
    el.querySelector(".x-save").onclick = () => this.commit();
    el.querySelector(".x-push").onclick = () => this.git("git_push", {}, "푸시했습니다");
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
      this.rename(n);
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
    this.render();
  }

  /** Commit with a message from the free AI pool; without one, a message listing the changed files. */
  async commit() {
    if (!this.status.size) return this.say("바뀐 내용이 없습니다");
    const files = [...this.status.keys()];
    let message = `Update ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`;
    if (poolReady()) {
      this.say("커밋 메시지 생성 중…");
      const diff = (await invoke("git_diff", { root: this.card.root }).catch(() => "")).slice(0, 8000);
      const prompt = `Write one git commit message line (Conventional Commits, English, max 72 chars) for these changes. Reply with the line only.\n\nFiles:\n${[...this.status].map(([p, c]) => `${c} ${p}`).join("\n")}\n\nDiff:\n${diff}`;
      const a = await invoke("ai_ask", { prompt, search: false }).catch(() => null);
      const line = a?.text.split("\n").map((l) => l.replace(/^[`"'\s]+|[`"'\s]+$/g, "")).find(Boolean);
      if (line) message = line.slice(0, 100);
    }
    this.git("git_save", { message }, `커밋했습니다: ${message}`);
  }

  /** Commit / push, with plain-language results instead of git output. */
  async git(cmd, args, done) {
    try {
      await invoke(cmd, { root: this.card.root, ...args });
      this.say(done);
    } catch (e) {
      this.say(`실패: ${String(e).split("\n")[0]}`, true);
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
    const [st, ahead] = await Promise.all([
      invoke("git_status", { root: this.card.root }).catch(() => []),
      invoke("git_ahead", { root: this.card.root }).catch(() => 0),
    ]);
    this.status = new Map(st.map((s) => [s.path, s.code]));
    this.el.querySelector(".x-save").classList.toggle("on", st.length > 0);
    this.el.querySelector(".x-push").classList.toggle("on", ahead > 0);
    this.el.querySelector(".x-push").title = `커밋을 원격 저장소로 올립니다 (git push)${ahead ? ` · 올릴 커밋 ${ahead}개` : ""}`;
    this.card.setFileCount(st.length);
    this.card.viewer.syncReview();
    if (this.mode === "changed") this.render();
    else this.recolor();
  }

  render() {
    this.list.textContent = "";
    if (this.mode === "all") return this.expand(this.list, "", 0);
    if (!this.status.size) {
      this.list.innerHTML = `<div class="muted">변경된 파일이 없습니다</div>`;
      return;
    }
    for (const [p, code] of [...this.status].sort()) this.list.append(node(p, p, false, code, 0));
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
