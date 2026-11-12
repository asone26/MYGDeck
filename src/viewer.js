import { invoke } from "@tauri-apps/api/core";
import { keyLabel, lineRange, mentionFor } from "./logic.js";

// Syntax highlighting is the largest dependency; load it only when a file is first opened.
let hljsLoad = null;
const loadHljs = () => (hljsLoad ??= import("highlight.js/lib/common").then((m) => m.default));

const HIGHLIGHT_LIMIT = 300_000;

/** Read-only code viewer: syntax colors and changed-line marks, no editing (spec 3.2 ⑥). */
export class Viewer {
  constructor(card, el) {
    Object.assign(this, { card, el });
    el.tabIndex = -1;
    el.innerHTML = `
      <div class="vbar"><span class="vpath"></span>
        <button class="v-ins" title="${keyLabel("선택한 코드를 입력창에 넣기 (Ctrl+I)")}">@ 입력창에 넣기</button>
        <button class="v-close" title="닫기 (Esc)">×</button></div>
      <div class="vbody"><pre class="gutter"></pre><pre class="code"><code class="hljs"></code></pre></div>`;
    this.code = el.querySelector("code");
    this.gutter = el.querySelector(".gutter");
    this.body = el.querySelector(".vbody");
    el.querySelector(".v-close").onclick = () => this.close();
    // mousedown keeps the code selection alive until the click handler reads it.
    el.querySelector(".v-ins").onmousedown = (e) => e.preventDefault();
    el.querySelector(".v-ins").onclick = () => this.insertSelection();
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  async open(rel) {
    this.rel = rel;
    this.el.hidden = false;
    this.el.querySelector(".vpath").textContent = rel;
    await this.load(false);
    this.el.focus();
  }

  reload() {
    if (this.isOpen) this.load(true);
  }

  async load(keepScroll) {
    const top = this.body.scrollTop;
    const { root } = this.card;
    try {
      const [text, changed, hljs] = await Promise.all([
        invoke("read_file", { root, rel: this.rel }),
        invoke("changed_lines", { root, rel: this.rel }).catch(() => ({ all: false, lines: [] })),
        loadHljs(),
      ]);
      this.render(text, changed, hljs);
    } catch (e) {
      this.code.textContent = `열 수 없습니다: ${e}`;
      this.gutter.textContent = "";
    }
    this.body.scrollTop = keepScroll ? top : 0;
  }

  render(text, changed, hljs) {
    const ext = this.rel.split(".").pop().toLowerCase();
    if (hljs.getLanguage(ext) && text.length < HIGHLIGHT_LIMIT) {
      this.code.innerHTML = hljs.highlight(text, { language: ext, ignoreIllegals: true }).value;
    } else {
      this.code.textContent = text;
    }
    const marked = new Set(changed.lines);
    const n = text.split("\n").length;
    const nums = [];
    for (let i = 1; i <= n; i++) nums.push(changed.all || marked.has(i) ? `<span class="chg">${i}</span>` : i);
    this.gutter.innerHTML = nums.join("\n");
  }

  selectionRange() {
    const sel = getSelection();
    if (!sel?.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (r.collapsed || !this.code.contains(r.startContainer)) return null;
    const before = document.createRange();
    before.setStart(this.code, 0);
    before.setEnd(r.startContainer, r.startOffset);
    return lineRange(before.toString(), r.toString());
  }

  /** Selected code goes to the composer as `@path Lx-y`; open files are never sent on their own. */
  insertSelection() {
    if (!this.isOpen) return;
    this.card.composer.insert(mentionFor(this.card.adapter?.mention, this.rel, this.selectionRange()));
  }

  close() {
    this.el.hidden = true;
    this.card.focusDefault();
  }
}
