import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { mentionFor } from "./logic.js";

/** File explorer: files changed in this project (default) or the whole tree (spec 3.2 ①). */
export class Explorer {
  constructor(card, el) {
    Object.assign(this, { card, el, mode: "changed", status: new Map() });
    el.innerHTML = `<div class="xbar"><button data-m="changed" class="on">변경된 파일</button><button data-m="all">전체</button>
      <span class="sp"></span>
      <button class="x-save" title="지금 바뀐 내용을 저장점으로 남깁니다 (git commit)">지금 상태 저장</button>
      <button class="x-park" title="바뀐 내용을 보관하고 마지막 저장점으로 되돌립니다 (git stash, 되살리기 가능)">되돌리기</button>
      <button class="x-unpark" title="마지막으로 되돌린 내용을 다시 가져옵니다">되살리기</button></div>
      <div class="xmsg" hidden></div><div class="xlist"></div>`;
    this.list = el.querySelector(".xlist");
    this.msg = el.querySelector(".xmsg");
    el.querySelector(".x-save").onclick = () => this.git("git_save", null);
    el.querySelector(".x-park").onclick = () =>
      this.git("git_park", `바뀐 파일 ${this.status.size}개를 마지막 저장점 상태로 되돌립니다.\n바뀐 내용은 지워지지 않고 보관되며 [되살리기]로 다시 가져올 수 있습니다.`);
    el.querySelector(".x-unpark").onclick = () => this.git("git_unpark", null);
    el.querySelector(".xbar").addEventListener("click", (e) => {
      const m = e.target.dataset?.m;
      if (!m) return;
      this.mode = m;
      for (const b of el.querySelectorAll(".xbar button")) b.classList.toggle("on", b.dataset.m === m);
      this.render();
    });
    this.list.addEventListener("click", (e) => this.onClick(e));
    this.list.addEventListener("dragstart", (e) => {
      const p = e.target.closest?.("[data-path]")?.dataset.path;
      if (p) e.dataTransfer.setData("text/plain", mentionFor(card.adapter?.mention, p));
    });
  }

  /** Save point / park / unpark (spec 3.2 ③), with plain-language results instead of git output. */
  async git(cmd, confirmText) {
    if (cmd !== "git_unpark" && !this.status.size) return this.say("바뀐 내용이 없습니다");
    // window.confirm() does not block in the webview: use the native dialog.
    if (confirmText && !(await ask(confirmText, { title: this.card.name, kind: "warning", okLabel: "되돌리기", cancelLabel: "취소" }))) return;
    const label = new Date().toLocaleString("ko-KR");
    try {
      await invoke(cmd, cmd === "git_unpark" ? { root: this.card.root } : { root: this.card.root, label });
      this.say({ git_save: "저장했습니다", git_park: "되돌렸습니다 · 되살리기로 다시 가져올 수 있습니다", git_unpark: "되살렸습니다" }[cmd]);
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
    const st = await invoke("git_status", { root: this.card.root }).catch(() => []);
    this.status = new Map(st.map((s) => [s.path, s.code]));
    this.card.setFileCount(st.length);
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
    if (!n.dataset.dir) return this.card.viewer.open(n.dataset.path);
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
  d.title = dir ? path : `${path}\n클릭: 코드 보기 · 입력창으로 끌어다 놓기: @파일`;
  return d;
}
