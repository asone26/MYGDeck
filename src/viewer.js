import { invoke } from "@tauri-apps/api/core";
import { keyLabel, lineRange, mentionFor, parseDiff, addedRows, formatReviewComments } from "./logic.js";

// Syntax highlighting is the largest dependency; load it only when a file is first opened.
let hljsLoad = null;
const loadHljs = () => (hljsLoad ??= import("highlight.js/lib/common").then((m) => m.default));
let mdLoad = null;
const loadMd = () => (mdLoad ??= Promise.all([import("marked"), import("dompurify")]).then(([m, d]) => ({ marked: m.marked, purify: d.default })));

const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"]);
const HIGHLIGHT_LIMIT = 300_000;
const DIFF_ROWS = 5000;
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Read-only code viewer: syntax colors and changed-line marks, no editing (spec 3.2 ⑥).
 *  A changed file also has a review view: its diff against the last commit, with 되돌리기. */
export class Viewer {
  constructor(card, el) {
    Object.assign(this, { card, el, comments: [] });
    el.tabIndex = -1;
    el.innerHTML = `
      <div class="vbar"><span class="vpath"></span>
        <span class="vreview" hidden>
          <span class="vseg"><button data-v="diff" title="마지막 커밋과 비교">변경</button><button data-v="code" title="파일 전체">코드</button></span>
          <span class="vstat"></span>
          <span class="vnav"><button class="v-prev" title="이전 변경 파일 ([)">‹</button><span class="vpos"></span><button class="v-next" title="다음 변경 파일 (])">›</button></span>
          <span class="vnav"><button class="v-hprev" title="이전 변경 블록">▲</button><button class="v-hnext" title="다음 변경 블록">▼</button></span>
          <button class="v-split" title="나란히(2열) 비교 보기">나란히</button>
          <button class="v-ws" title="공백 변경 무시">공백무시</button>
          <button class="v-revert"></button>
        </span>
        <button class="v-md" title="마크다운 미리보기/원문 전환" hidden>미리보기</button>
        <button class="v-find-btn" title="파일 내 검색 / 줄 이동 (Ctrl+F)">검색</button>
        <button class="v-rev-send" title="작성한 리뷰 코멘트를 입력창에 넣기" hidden></button>
        <button class="v-ins" title="${keyLabel("선택한 코드를 입력창에 넣기 (Ctrl+I)")}">@<span class="vl"> 입력창에 넣기</span></button>
        <button class="v-close" title="닫기 (Esc)">×</button></div>
      <div class="vfind" hidden><input class="vf-in" placeholder="검색어 또는 :줄번호…" spellcheck="false"><span class="vf-cnt"></span><button class="vf-prev" title="이전">▲</button><button class="vf-next" title="다음">▼</button><button class="vf-x" title="닫기">×</button></div>
      <div class="vnotice" hidden></div>
      <div class="vbody"><pre class="gutter"></pre><pre class="code"><code class="hljs"></code></pre><div class="vdiff" hidden></div><div class="vmd md" hidden></div><div class="vimg" hidden><img></div></div>`;
    this.code = el.querySelector("code");
    this.gutter = el.querySelector(".gutter");
    this.body = el.querySelector(".vbody");
    this.diff = el.querySelector(".vdiff");
    this.mdBox = el.querySelector(".vmd");
    this.imgBox = el.querySelector(".vimg");
    this.notice = el.querySelector(".vnotice");
    this.mdBtn = el.querySelector(".v-md");
    this.revertBtn = el.querySelector(".v-revert");
    this.mode = "code";
    this.splitMode = false;
    this.ignoreWs = false;
    this.mdPreview = false;
    this.forceHighlight = false;
    this.findBar = el.querySelector(".vfind");
    this.findIn = el.querySelector(".vf-in");
    this.findCnt = el.querySelector(".vf-cnt");
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
    el.querySelector(".v-ws").onclick = (e) => {
      this.ignoreWs = !this.ignoreWs;
      e.currentTarget.classList.toggle("on", this.ignoreWs);
      if (this.mode === "diff") this.load(true);
    };
    this.mdBtn.onclick = () => {
      this.mdPreview = !this.mdPreview;
      this.mdBtn.classList.toggle("on", this.mdPreview);
      this.load(false);
    };
    el.querySelector(".v-find-btn").onclick = () => this.toggleFind(true);
    el.querySelector(".vf-prev").onclick = () => this.stepFind(-1);
    el.querySelector(".vf-next").onclick = () => this.stepFind(1);
    el.querySelector(".vf-x").onclick = () => this.toggleFind(false);
    this.findIn.oninput = () => this.runFind();
    this.findIn.onkeydown = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); this.stepFind(ev.shiftKey ? -1 : 1); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); this.toggleFind(false); }
    };
    this.revertBtn.onclick = () => this.revert();
    this.revSendBtn = el.querySelector(".v-rev-send");
    this.revSendBtn.onclick = () => this.sendReviewComments();
    el.querySelector(".v-close").onclick = () => this.close();
    // mousedown keeps the code selection alive until the click handler reads it.
    el.querySelector(".v-ins").onmousedown = (e) => e.preventDefault();
    el.querySelector(".v-ins").onclick = () => this.insertSelection();
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        this.toggleFind(true);
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
    const i = this.allDiffs ? -1 : list.indexOf(this.rel);
    const code = this.allDiffs ? null : this.card.explorer.status.get(this.rel);
    this.el.querySelector(".vreview").hidden = !this.allDiffs && i < 0 && this.mode !== "diff";
    this.el.querySelector(".vseg").hidden = !!this.allDiffs;
    for (const b of this.el.querySelectorAll(".vseg button")) b.classList.toggle("on", b.dataset.v === this.mode);
    this.el.querySelector(".vpos").textContent = this.allDiffs ? `${list.length}개 전체` : i < 0 ? `${list.length}개` : `${i + 1}/${list.length}`;
    this.el.querySelector(".vnav").hidden = this.allDiffs || !list.length;
    this.revertBtn.hidden = this.allDiffs || i < 0;
    this.revertBtn.classList.remove("armed");
    this.revertBtn.textContent = code === "A" ? "새 파일 삭제" : "되돌리기";
    this.revertBtn.title = code === "A" ? "이 파일을 지웁니다 (마지막 커밋에 없는 새 파일)" : "이 파일을 마지막 커밋 상태로 되돌립니다";
  }

  get isOpen() {
    return !this.el.hidden;
  }

  /** mode "diff" opens the review view when the file has changes; a deleted file only has that view. */
  async open(rel, mode = "code", line = null) {
    this.allDiffs = false;
    this.commitRev = null;
    this.forceHighlight = false;
    this.rel = rel;
    this.targetLine = line ? Number(line) : null;
    const code = this.card.explorer.status.get(rel);
    this.mode = code && (mode === "diff" || code === "D") ? "diff" : "code";
    this.el.hidden = false;
    this.el.querySelector(".vpath").textContent = rel;
    await this.load(false);
    this.el.focus();
  }

  /** View a historical commit's diff from the Explorer commit log. */
  async openCommitDiff(hash, subject) {
    this.allDiffs = false;
    this.commitRev = hash;
    this.rel = hash;
    this.mode = "diff";
    this.el.hidden = false;
    this.el.querySelector(".vpath").textContent = `${hash} · ${subject}`;
    await this.load(false);
    this.el.focus();
  }

  /** Stacked diff view for all changed files in one scrollable panel. */
  async openAllDiffs() {
    const list = this.changed();
    if (!list.length) return;
    if (list.length === 1) return this.open(list[0], "diff");
    this.allDiffs = true;
    this.commitRev = null;
    this.rel = null;
    this.mode = "diff";
    this.el.hidden = false;
    this.el.querySelector(".vpath").textContent = `전체 변경 (${list.length}개 파일)`;
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
    this.notice.hidden = true;
    const ext = (this.rel ?? "").split(".").pop().toLowerCase();
    const isMd = this.mode === "code" && ext === "md";
    const isImg = this.mode === "code" && IMG_EXTS.has(ext);
    this.mdBtn.hidden = !isMd;
    const diff = this.mode === "diff";
    const showMd = isMd && this.mdPreview;
    this.diff.hidden = !diff;
    this.mdBox.hidden = !showMd;
    this.imgBox.hidden = !isImg;
    this.gutter.hidden = this.code.parentElement.hidden = diff || showMd || isImg;
    if (diff) {
      if (this.commitRev) await this.loadCommitDiff();
      else if (this.allDiffs) await this.loadAllDiffs();
      else await this.loadDiff();
      this.body.scrollTop = keepScroll ? top : 0;
      this.body.scrollLeft = keepScroll ? left : 0;
      return;
    }
    this.el.querySelector(".vstat").textContent = "";
    if (isImg) {
      try {
        const src = await invoke("read_file_base64", { root, rel: this.rel });
        this.imgBox.querySelector("img").src = src;
      } catch (e) {
        this.imgBox.hidden = true;
        this.code.parentElement.hidden = false;
        this.code.textContent = `이미지를 열 수 없습니다: ${e}`;
      }
      return;
    }
    try {
      const [text, changed, hljs] = await Promise.all([
        invoke("read_file", { root, rel: this.rel }),
        invoke("changed_lines", { root, rel: this.rel }).catch(() => ({ all: false, lines: [] })),
        loadHljs(),
      ]);
      this.lastText = text;
      if (showMd) {
        const { marked, purify } = await loadMd();
        this.mdBox.innerHTML = purify.sanitize(marked.parse(text));
      } else {
        this.render(text, changed, hljs);
      }
    } catch (e) {
      this.code.textContent = `열 수 없습니다: ${e}`;
      this.gutter.textContent = "";
    }
    this.body.scrollTop = keepScroll ? top : 0;
    if (!keepScroll && this.targetLine) {
      this.scrollToLine(this.targetLine);
      this.targetLine = null;
    }
  }

  scrollToLine(line) {
    const lh = parseFloat(getComputedStyle(this.code).lineHeight) || 19;
    this.body.scrollTop = Math.max(0, (line - 4) * lh);
  }

  async loadCommitDiff() {
    const { root } = this.card;
    try {
      const [raw, hljs] = await Promise.all([invoke("git_commit_diff", { root, rev: this.commitRev }), loadHljs()]);
      this.renderDiff(parseDiff(raw), hljs);
    } catch (e) {
      this.diff.innerHTML = `<div class="dl meta"><span class="dt">커밋을 불러올 수 없습니다: ${esc(String(e))}</span></div>`;
    }
  }

  async loadDiff() {
    const { root } = this.card;
    const rel = this.rel;
    let rows;
    let hljs;
    let untracked = false;
    try {
      const d = await invoke("file_diff", { root, rel, ignoreWs: this.ignoreWs });
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

  async loadAllDiffs() {
    const { root } = this.card;
    const list = this.changed();
    if (!list.length) {
      this.el.querySelector(".vstat").textContent = "";
      this.diff.innerHTML = `<div class="dempty">변경된 파일이 없습니다</div>`;
      return;
    }
    const hljs = await loadHljs();
    const entries = await Promise.all(list.map(async (rel) => {
      try {
        const d = await invoke("file_diff", { root, rel, ignoreWs: this.ignoreWs });
        const untracked = !!d.untracked;
        const rows = untracked ? addedRows(await invoke("read_file", { root, rel })) : parseDiff(d.diff);
        return { rel, rows, untracked };
      } catch (e) {
        return { rel, rows: [{ kind: "meta", text: `열 수 없습니다: ${e}` }], untracked: false };
      }
    }));
    if (!this.allDiffs || this.mode !== "diff") return;
    let totalAdd = 0, totalDel = 0, maxNum = 0;
    for (const e of entries) {
      for (const r of e.rows) {
        if (r.kind === "add") totalAdd++;
        else if (r.kind === "del") totalDel++;
        if (r.old > maxNum) maxNum = r.old;
        if (r.new > maxNum) maxNum = r.new;
      }
    }
    this.el.querySelector(".vstat").innerHTML = totalAdd || totalDel ? `<b class="a">+${totalAdd}</b> <b class="d">−${totalDel}</b>` : "";
    this.diff.style.setProperty("--lnw", `${Math.max(String(maxNum).length, 2)}ch`);
    const perFileLimit = Math.max(200, Math.floor(DIFF_ROWS / Math.max(1, entries.length)));
    this.diff.innerHTML = entries.map((e) => {
      const a = e.rows.filter((r) => r.kind === "add").length;
      const d = e.rows.filter((r) => r.kind === "del").length;
      const stat = a || d ? `<span class="df-stat"><b class="a">+${a}</b> <b class="d">−${d}</b></span>` : "";
      const body = e.rows.length
        ? this.diffRowsHtml(e.rows, hljs, e.rel, e.untracked, perFileLimit)
        : `<div class="dl meta"><span class="dt">변경 없음</span></div>`;
      return `<div class="df-sec" data-rel="${esc(e.rel)}"><div class="dl file-head"><span class="df-name">${esc(e.rel)}</span>${stat}<button class="df-open" data-rel="${esc(e.rel)}">파일 열기</button></div>${body}</div>`;
    }).join("");
    for (const b of this.diff.querySelectorAll(".df-open")) {
      b.onclick = () => this.open(b.dataset.rel, "diff");
    }
    this.wireHunkDiscard();
    this.wireReviewComments();
  }

  diffRowsHtml(rows, hljs, rel, untracked, limit = DIFF_ROWS) {
    const ext = rel.split(".").pop().toLowerCase();
    const lang = hljs?.getLanguage(ext) && rows.length < limit ? ext : null;
    const color = (t) => (lang ? hljs.highlight(t, { language: lang, ignoreIllegals: true }).value : esc(t));
    let hunkIdx = 0;
    const html = rows.slice(0, limit).map((r) => {
      if (r.kind === "hunk") {
        const idx = hunkIdx++;
        const btn = untracked ? "" : `<button class="hunk-discard" data-rel="${esc(rel)}" data-hunk="${idx}" title="이 블록만 마지막 커밋으로 되돌리기">되돌리기</button>`;
        return `<div class="dl hunk"><span class="ln"></span><span class="ln n"></span><span class="dm"></span><span class="dt">⋯ ${esc(r.text)}${btn}</span></div>`;
      }
      if (r.kind === "meta") return `<div class="dl meta"><span class="dt">${esc(r.text)}</span></div>`;
      const mark = r.kind === "add" ? "+" : r.kind === "del" ? "−" : "";
      const lineNum = r.new ?? r.old ?? "";
      const saved = this.comments
        .map((c, idx) => ({ c, idx }))
        .filter(({ c }) => c.rel === rel && String(c.line ?? "") === String(lineNum))
        .map(({ c, idx }) => `<div class="dl-comment"><span>${esc(c.comment)}</span><button class="dl-cdel" data-idx="${idx}" title="코멘트 삭제">×</button></div>`)
        .join("");
      const addBtn = `<button class="dl-add-c" data-rel="${esc(rel)}" data-line="${esc(String(lineNum))}" title="이 줄에 리뷰 코멘트 달기">+</button>`;
      return `<div class="dl ${r.kind}"><span class="ln">${r.old ?? ""}</span><span class="ln n">${r.new ?? ""}${addBtn}</span><span class="dm">${mark}</span><span class="dt">${color(r.text)}</span></div>${saved}`;
    });
    if (rows.length > limit) html.push(`<div class="dl meta"><span class="dt">변경이 많아 앞쪽 ${limit}줄만 보여 줍니다 · 파일을 열어 전체를 보세요</span></div>`);
    return html.join("");
  }

  syncReviewSend() {
    if (!this.revSendBtn) return;
    const n = this.comments.length;
    this.revSendBtn.hidden = !n;
    if (n) this.revSendBtn.textContent = `리뷰 ${n}건 보내기`;
  }

  sendReviewComments() {
    if (!this.comments.length) return;
    const prompt = formatReviewComments(this.comments);
    this.comments = [];
    this.syncReviewSend();
    this.card.composer.insert(prompt);
    if (this.mode === "diff") {
      if (this.allDiffs) this.loadAllDiffs();
      else this.loadDiff();
    }
  }

  wireReviewComments() {
    this.syncReviewSend();
    for (const del of this.diff.querySelectorAll(".dl-cdel")) {
      del.onclick = () => {
        this.comments.splice(Number(del.dataset.idx), 1);
        this.syncReviewSend();
        if (this.allDiffs) this.loadAllDiffs();
        else this.loadDiff();
      };
    }
    for (const btn of this.diff.querySelectorAll(".dl-add-c")) {
      btn.onclick = (e) => {
        e.stopPropagation();
        const row = btn.closest(".dl");
        if (!row) return;
        const next = row.nextElementSibling;
        if (next?.classList.contains("dl-cbox")) {
          next.querySelector("input")?.focus();
          return;
        }
        const box = document.createElement("div");
        box.className = "dl-cbox";
        box.innerHTML = `<input type="text" placeholder="${esc(btn.dataset.rel)}${btn.dataset.line ? ` L${esc(btn.dataset.line)}` : ""} 리뷰 코멘트… (Enter 저장 · Esc 취소)" spellcheck="false"><button type="button" class="dl-csave">추가</button>`;
        const input = box.querySelector("input");
        const save = () => {
          const text = input.value.trim();
          if (!text) return box.remove();
          this.comments.push({ rel: btn.dataset.rel, line: btn.dataset.line ? Number(btn.dataset.line) : null, comment: text });
          this.syncReviewSend();
          if (this.allDiffs) this.loadAllDiffs();
          else this.loadDiff();
        };
        box.querySelector(".dl-csave").onclick = save;
        input.onkeydown = (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); save(); }
          else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); box.remove(); }
        };
        row.after(box);
        input.focus();
      };
    }
  }

  wireHunkDiscard() {
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
          await invoke("git_discard_hunk", { root: this.card.root, rel: btn.dataset.rel || this.rel, hunkIndex: Number(btn.dataset.hunk) });
          await (this.allDiffs ? this.loadAllDiffs() : this.loadDiff());
          this.card.explorer?.refresh?.();
          this.card.refreshDiff?.();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "실패";
          btn.title = String(e);
        }
      };
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
    const width = String(Math.max(0, ...rows.map((r) => Math.max(r.old ?? 0, r.new ?? 0)))).length;
    this.diff.style.setProperty("--lnw", `${Math.max(width, 2)}ch`);
    this.diff.innerHTML = this.diffRowsHtml(rows, hljs, this.rel, this.untrackedDiff);
    this.wireHunkDiscard();
    this.wireReviewComments();
  }

  render(text, changed, hljs) {
    const ext = this.rel.split(".").pop().toLowerCase();
    const canHl = hljs.getLanguage(ext);
    const overLimit = text.length >= HIGHLIGHT_LIMIT && !this.forceHighlight;
    if (canHl && !overLimit) {
      this.code.innerHTML = hljs.highlight(text, { language: ext, ignoreIllegals: true }).value;
    } else {
      this.code.textContent = text;
      if (canHl && overLimit) {
        this.notice.hidden = false;
        this.notice.innerHTML = `파일이 커서(${Math.round(text.length / 1024)} KB) 구문 강조를 껐습니다. <button type="button">구문 강조 켜기</button>`;
        this.notice.querySelector("button").onclick = () => {
          this.forceHighlight = true;
          this.load(true);
        };
      }
    }
    const marked = new Set(changed.lines);
    const n = text.split("\n").length;
    const nums = [];
    for (let i = 1; i <= n; i++) {
      const cls = [changed.all || marked.has(i) ? "chg" : "", this.targetLine === i ? "jump" : ""].filter(Boolean).join(" ");
      nums.push(cls ? `<span class="${cls}">${i}</span>` : i);
    }
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

  toggleFind(open) {
    this.findBar.hidden = !open;
    if (open) {
      this.findIn.focus();
      this.findIn.select();
      this.runFind();
    } else {
      this.findMatches = [];
      this.findCnt.textContent = "";
      this.el.focus();
    }
  }

  runFind() {
    const raw = this.findIn.value.trim();
    this.findMatches = [];
    this.findIdx = 0;
    if (!raw) { this.findCnt.textContent = ""; return; }
    if (/^:\d+$/.test(raw)) {
      const ln = Number(raw.slice(1));
      this.findCnt.textContent = `L${ln}`;
      this.scrollToLine(ln);
      return;
    }
    const q = raw.toLowerCase();
    if (this.mode === "diff") {
      this.findMatches = [...this.diff.querySelectorAll(".dl .dt")].filter((el) => el.textContent.toLowerCase().includes(q));
      this.findCnt.textContent = this.findMatches.length ? `1/${this.findMatches.length}` : "0건";
      this.findMatches[0]?.scrollIntoView({ block: "center" });
      return;
    }
    const lines = (this.lastText ?? "").split("\n");
    lines.forEach((l, i) => { if (l.toLowerCase().includes(q)) this.findMatches.push(i + 1); });
    this.findCnt.textContent = this.findMatches.length ? `1/${this.findMatches.length}` : "0건";
    if (this.findMatches.length) this.scrollToLine(this.findMatches[0]);
  }

  stepFind(dir) {
    if (!this.findMatches?.length) return;
    this.findIdx = (this.findIdx + dir + this.findMatches.length) % this.findMatches.length;
    this.findCnt.textContent = `${this.findIdx + 1}/${this.findMatches.length}`;
    const hit = this.findMatches[this.findIdx];
    if (typeof hit === "number") this.scrollToLine(hit);
    else hit.scrollIntoView({ block: "center" });
  }

  close() {
    this.el.hidden = true;
    this.card.focusDefault();
  }
}
