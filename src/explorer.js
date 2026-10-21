import { invoke } from "@tauri-apps/api/core";
import { mentionFor } from "./logic.js";

/** File explorer: files changed in this project (default) or the whole tree (spec 3.2 ①). */
export class Explorer {
  constructor(card, el) {
    Object.assign(this, { card, el, mode: "changed", status: new Map() });
    el.innerHTML = `<div class="xbar"><button data-m="changed" class="on">변경된 파일</button><button data-m="all">전체</button></div><div class="xlist"></div>`;
    this.list = el.querySelector(".xlist");
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
