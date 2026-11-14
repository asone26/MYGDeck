import { invoke } from "@tauri-apps/api/core";
import { keyLabel, lineRange, mentionFor, parseDiff, addedRows } from "./logic.js";

// Syntax highlighting is the largest dependency; load it only when a file is first opened.
let hljsLoad = null;
const loadHljs = () => (hljsLoad ??= import("highlight.js/lib/common").then((m) => m.default));

const HIGHLIGHT_LIMIT = 300_000;
const DIFF_ROWS = 5000;
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Read-only code viewer: syntax colors and changed-line marks, no editing (spec 3.2 ⑥).
 *  A changed file also has a review view: its diff against the last commit, with 되돌리기. */
export class Viewer {
  constructor(card, el) {
    Object.assign(this, { card, el });
    el.tabIndex = -1;
    el.innerHTML = `
      <div class="vbar"><span class="vpath"></span>
        <span class="vreview" hidden>
          <span class="vseg"><button data-v="diff" title="마지막 커밋과 비교">변경</button><button data-v="code" title="파일 전체">코드</button></span>
          <span class="vstat"></span>
          <span class="vnav"><button class="v-prev" title="이전 변경 파일 ([)">‹</button><span class="vpos"></span><button class="v-next" title="다음 변경 파일 (])">›</button></span>
          <span class="vnav"><button class="v-hprev" title="이전 변경 블록">▲</button><button class="v-hnext" title="다음 변경 블록">▼</button></span>
          <button class="v-split" title="나란히(2열) 비교 보기">나란히</button>
          <button class="v-revert"></button>
        </span>
        <button class="v-ins" title="${keyLabel("선택한 코드를 입력창에 넣기 (Ctrl+I)")}">@<span class="vl"> 입력창에 넣기</span></button>
        <button class="v-close" title="닫기 (Esc)">×</button></div>
      <div class="vbody"><pre class="gutter"></pre><pre class="code"><code class="hljs"></code></pre><div class="vdiff" hidden></div></div>`;
    this.code = el.querySelector("code");
    this.gutter = el.querySelector(".gutter");
    this.body = el.querySelector(".vbody");
    this.diff = el.querySelector(".vdiff");
    this.revertBtn = el.querySelector(".v-revert");
    this.mode = "code";
    this.splitMode = false;
    el.querySelector(".vseg").onclick = (e) => e.target.dataset.v && this.setMode(e.target.dataset.v);
    el.querySelector(".v-prev").onclick = () => this.step(-1);
    el.querySelector(".v-next").onclick = () => this.step(1);
    el.querySelector(".v-hprev").onclick = () => this.jumpHunk(-1);
    el.querySelector(".v-hnext").onclick = () => this.jumpHunk(1);
    el.querySelector(".v-split").onclick = (e) => {
      this.splitMode = !this.splitMode;
      e.currentTarget.classList.toggle("on", this.splitMode);
      this.diff.classList.toggle("split", this.splitMode);
    };
    this.revertBtn.onclick = () => this.revert();
    el.querySelector(".v-close").onclick = () => this.close();
    // mousedown keeps the code selection alive until the click handler reads it.
    el.querySelector(".v-ins").onmousedown = (e) => e.preventDefault();
    el.querySelector(".v-ins").onclick = () => this.insertSelection();
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      } else if ((e.key === "[" || e.key === "]") && !e.ctrlKey && !e.metaKey && !e.altKey && this.changed().length) {
        e.preventDefault();
        this.step(e.key === "]" ? 1 : -1);
      }
    });
  }

  jumpHunk(dir) {
    const hunks = [...this.diff.querySelectorAll(".dl.hunk")];
    if (!hunks.length) return;
    const top = this.diff.scrollTop + 8;
    const target = dir > 0
      ? hunks.find((h) => h.offsetTop > top) ?? hunks[0]
      : [...hunks].reverse().find((h) => h.offsetTop < top - 16) ?? hunks.at(-1);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  /** Changed files in explorer order, for ‹ › and the review controls. */
  changed() {
    return [...this.card.explorer.status.keys()].sort();
  }

  setMode(m) {
    this.mode = m;
    this.load(false);
  }

  step(d) {
    const list = this.changed();
    if (!list.length) return;
    const i = list.indexOf(this.rel);
    this.open(list[i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length], "diff");
  }

  /** Two clicks: the first arms the button, the second puts the file back (or deletes a new file). */
  async revert() {
    const code = this.card.explorer.status.get(this.rel);
    if (!this.revertBtn.classList.contains("armed")) {
      this.revertBtn.classList.add("armed");
      this.revertBtn.textContent = code === "A" ? "정말 삭제할까요?" : "정말 되돌릴까요?";
      clearTimeout(this.armTimer);
      this.armTimer = setTimeout(() => this.syncReview(), 3000);
      return;
    }
    clearTimeout(this.armTimer);
    const rel = this.rel;
    const rest = this.changed().filter((p) => p !== rel);
    const after = rest.find((p) => p > rel) ?? rest[0];
    try {
      await invoke("git_discard", { root: this.card.root, rel });
      this.card.explorer.say(code === "A" ? `삭제했습니다: ${rel}` : `되돌렸습니다: ${rel}`);
    } catch (e) {
      this.card.explorer.say(`되돌리기 실패: ${String(e).split("\n")[0]}`, true);
      return this.syncReview();
    }
    await this.card.explorer.refresh();
    if (after) this.open(after, "diff");
    else this.close();
  }

  /** Review controls show only for a changed file; called again whenever git status refreshes. */
  syncReview() {
    if (!this.isOpen) return;
    const list = this.changed();
    const i = list.indexOf(this.rel);
    const code = this.card.explorer.status.get(this.rel);
    this.el.querySelector(".vreview").hidden = i < 0 && this.mode !== "diff";
    for (const b of this.el.querySelectorAll(".vseg button")) b.classList.toggle("on", b.dataset.v === this.mode);
    this.el.querySelector(".vpos").textContent = i < 0 ? `${list.length}개` : `${i + 1}/${list.length}`;
    this.el.querySelector(".vnav").hidden = !list.length;
    this.revertBtn.hidden = i < 0;
    this.revertBtn.classList.remove("armed");
    this.revertBtn.textContent = code === "A" ? "새 파일 삭제" : "되돌리기";
    this.revertBtn.title = code === "A" ? "이 파일을 지웁니다 (마지막 커밋에 없는 새 파일)" : "이 파일을 마지막 커밋 상태로 되돌립니다";
  }

  get isOpen() {
    return !this.el.hidden;
  }

  /** mode "diff" opens the review view when the file has changes; a deleted file only has that view. */
  async open(rel, mode = "code") {
    this.rel = rel;
    const code = this.card.explorer.status.get(rel);
    this.mode = code && (mode === "diff" || code === "D") ? "diff" : "code";
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
    const left = this.body.scrollLeft;
    const { root } = this.card;
    this.syncReview();
    const diff = this.mode === "diff";
    this.diff.hidden = !diff;
    this.gutter.hidden = this.code.parentElement.hidden = diff;
    if (diff) {
      await this.loadDiff();
      this.body.scrollTop = keepScroll ? top : 0;
      this.body.scrollLeft = keepScroll ? left : 0;
      return;
    }
    this.el.querySelector(".vstat").textContent = "";
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

  async loadDiff() {
    const { root } = this.card;
    const rel = this.rel;
    let rows;
    let hljs;
    let untracked = false;
    try {
      const d = await invoke("file_diff", { root, rel });
      hljs = await loadHljs();
      untracked = !!d.untracked;
      rows = untracked ? addedRows(await invoke("read_file", { root, rel })) : parseDiff(d.diff);
    } catch (e) {
      rows = [{ kind: "meta", text: `열 수 없습니다: ${e}` }];
    }
    if (rel === this.rel && this.mode === "diff") {
      this.untrackedDiff = untracked;
      this.renderDiff(rows, hljs); // else switched while loading
    }
  }

  renderDiff(rows, hljs) {
    const add = rows.filter((r) => r.kind === "add").length;
    const del = rows.filter((r) => r.kind === "del").length;
    this.el.querySelector(".vstat").innerHTML = add || del ? `<b class="a">+${add}</b> <b class="d">−${del}</b>` : "";
    if (!rows.length) {
      this.diff.innerHTML = `<div class="dempty">마지막 커밋과 같습니다</div>`;
      return;
    }
    const ext = this.rel.split(".").pop().toLowerCase();
    const lang = hljs?.getLanguage(ext) && rows.length < DIFF_ROWS ? ext : null;
    const color = (t) => (lang ? hljs.highlight(t, { language: lang, ignoreIllegals: true }).value : esc(t));
    const width = String(Math.max(0, ...rows.map((r) => Math.max(r.old ?? 0, r.new ?? 0)))).length;
    this.diff.style.setProperty("--lnw", `${Math.max(width, 2)}ch`);
    let hunkIdx = 0;
    const html = rows.slice(0, DIFF_ROWS).map((r) => {
      if (r.kind === "hunk") {
        const idx = hunkIdx++;
        const btn = this.untrackedDiff ? "" : `<button class="hunk-discard" data-hunk="${idx}" title="이 블록만 마지막 커밋으로 되돌리기">되돌리기</button>`;
        return `<div class="dl hunk"><span class="ln"></span><span class="ln n"></span><span class="dm"></span><span class="dt">⋯ ${esc(r.text)}${btn}</span></div>`;
      }
      if (r.kind === "meta") return `<div class="dl meta"><span class="dt">${esc(r.text)}</span></div>`;
      const mark = r.kind === "add" ? "+" : r.kind === "del" ? "−" : "";
      return `<div class="dl ${r.kind}"><span class="ln">${r.old ?? ""}</span><span class="ln n">${r.new ?? ""}</span><span class="dm">${mark}</span><span class="dt">${color(r.text)}</span></div>`;
    });
    if (rows.length > DIFF_ROWS) html.push(`<div class="dl meta"><span class="dt">변경이 많아 앞쪽 ${DIFF_ROWS}줄만 보여 줍니다 · 코드 화면에서 전체를 보세요</span></div>`);
    this.diff.innerHTML = html.join("");
    for (const btn of this.diff.querySelectorAll(".hunk-discard")) {
      btn.onclick = async () => {
        if (!btn.dataset.armed) {
          btn.dataset.armed = "1";
          btn.textContent = "확인";
          setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "되돌리기"; } }, 2500);
          return;
        }
        btn.disabled = true;
        try {
          await invoke("git_discard_hunk", { root: this.card.root, rel: this.rel, hunkIndex: Number(btn.dataset.hunk) });
          await this.loadDiff();
          this.card.explorer?.refreshGit?.();
          this.card.refreshDiffStat?.();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "실패";
          btn.title = String(e);
        }
      };
    }
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
